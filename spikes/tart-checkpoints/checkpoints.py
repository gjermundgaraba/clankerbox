#!/usr/bin/env python3
"""Disposable Tart disk experiment. Run locally with --run; no dependencies."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time

HOST = "user@mac-workstation"
TART = "/opt/homebrew/bin/tart"
DIGEST = "61f6e857a3d65dd2f8daf9c51c7b837fa458bcc9181ae8556e645b534dab6bf6"
IMAGE = "ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:" + DIGEST
NAMES = ("public-seed", "source", "checkpoint", "branch")
MARKER = "clankerbox-tart-checkpoints-v1\n"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST]
WORKSPACE = "/Users/admin/clankerbox-checkpoint-fixture"


def owned(path):
    path = Path(path)
    if (not re.fullmatch(r"/Users/example/clankerbox-tart-checkpoints\.[A-Za-z0-9]{6}", str(path))
            or path.is_symlink() or path.resolve() != path):
        raise ValueError("Refusing non-owned TART_HOME: " + str(path))
    if (path / ".owner").read_text() != MARKER:
        raise ValueError("Ownership marker mismatch")
    return path


def tart_command(home, *args):
    owned(home)
    return [TART, *args], dict(os.environ, TART_HOME=str(home), TART_NO_AUTO_PRUNE="1")


def vm_name(name):
    if name not in NAMES:
        raise ValueError("Unowned VM name: " + name)
    return name


def inventory():
    """Filesystem-only inventory: never point Tart at the existing home."""
    root = Path("/Users/example/.tart")
    records = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            st = path.lstat()
            record = {"mode": st.st_mode, "size": st.st_size, "mtime_ns": st.st_mtime_ns}
            if path.is_symlink():
                record["target"] = os.readlink(path)
            elif path.name == "config.json":
                record["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            records[str(path.relative_to(root))] = record
    return records


def apfs_copy(source, target):
    """clonefile only: no fallback to an 87GB byte copy."""
    clonefile = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).clonefile
    clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    clonefile.restype = ctypes.c_int
    target.mkdir()
    for child in source.iterdir():
        if child.is_symlink() or not child.is_file():
            raise ValueError("Unexpected cached image entry: " + str(child))
        if clonefile(os.fsencode(child), os.fsencode(target / child.name), 0):
            raise OSError(ctypes.get_errno(), "APFS clonefile failed; will not full-copy", str(child))


class Experiment:
    def __init__(self, home):
        self.home = owned(home)
        self.events = []
        self.processes = {}
        self.free_before = shutil.disk_usage(home).free
        self.peak_growth = 0
        self.budget_exceeded = threading.Event()
        self.done = threading.Event()
        self.before = inventory()
        self.save("inventory-before.json", self.before)

    def save(self, name, data):
        (self.home / name).write_text(json.dumps(data, indent=2) + "\n")

    def event(self, name, status="PASS", **data):
        row = dict(check=name, status=status, monotonic_ns=time.monotonic_ns(), **data)
        self.events.append(row)
        print(json.dumps(row), flush=True)

    def command(self, args, data=None, timeout=120, env=None):
        if self.budget_exceeded.is_set():
            raise RuntimeError("Host free-space delta exceeded 32GiB safety threshold")
        start = time.monotonic()
        result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout, env=env)
        self.events.append(dict(command=args, seconds=time.monotonic() - start,
                                returncode=result.returncode, stdout=result.stdout, stderr=result.stderr))
        result.check_returncode()
        return result.stdout.strip()

    def tart(self, *args, **kw):
        cmd, env = tart_command(self.home, *args)
        return self.command(cmd, env=env, **kw)

    def guest(self, name, script, timeout=120):
        return self.tart("exec", "-i", vm_name(name), "/bin/bash", "-se", data=script, timeout=timeout)

    def watch_budget(self):
        while not self.done.wait(0.5):
            growth = self.free_before - shutil.disk_usage(self.home).free
            self.peak_growth = max(self.peak_growth, growth)
            if growth > 32 * 1024**3:
                self.budget_exceeded.set()
                # Stop only processes this runner spawned, then normal cleanup owns disks.
                for proc in list(self.processes.values()):
                    if proc.poll() is None:
                        proc.terminate()
                return

    def start(self, name):
        vm_name(name)
        assert not any(p.poll() is None for p in self.processes.values()), "One guest at a time"
        start = time.monotonic()
        cmd, env = tart_command(self.home, "run", name, "--no-graphics", "--no-audio", "--no-clipboard")
        with (self.home / (name + "-run.log")).open("a") as log:
            self.processes[name] = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
        deadline = start + 240
        while time.monotonic() < deadline:
            if self.processes[name].poll() is not None:
                raise RuntimeError(name + " run exited: " + (self.home / (name + "-run.log")).read_text())
            try:
                boot = self.guest(name, "/usr/sbin/sysctl -n kern.bootsessionuuid\n", timeout=15)
                self.event(name + "-guest-ready", seconds=time.monotonic() - start, boot_session=boot)
                return boot
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                time.sleep(2)
        raise TimeoutError(name + " guest readiness exceeded 240s")

    def stop(self, name):
        start = time.monotonic()
        # Guest-initiated shutdown avoids tart stop's force-after-timeout ambiguity.
        try:
            self.guest(name, "sync\nsudo -n /sbin/shutdown -h now\n", timeout=20)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            # RPC may disconnect during shutdown; successful VMM exit is required below.
            pass
        code = self.processes[name].wait(timeout=90)
        assert code == 0, (name, "unclean VMM exit", code)
        self.event(name + "-clean-stop", seconds=time.monotonic() - start, run_exit=code)

    def clone(self, source, target):
        vm_name(source)
        vm_name(target)
        assert not any(p.poll() is None for p in self.processes.values())
        start = time.monotonic()
        self.tart("clone", source, target)
        self.tart("set", target, "--cpu", "4", "--memory", "8192", "--random-mac", "--random-serial")
        self.event(source + "-clone-to-" + target, seconds=time.monotonic() - start)

    def prepare_ssh(self, name):
        key = self.home / (name + "-client")
        self.command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)])
        pub = key.with_suffix(".pub").read_text().strip()
        self.guest(name, "umask 077\nmkdir -p /Users/admin/.ssh\nprintf '%s\\n' " + shlex.quote(pub) +
                   " > /Users/admin/.ssh/authorized_keys\n" +
                   "sudo -n rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub " +
                   "/etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub " +
                   "/etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub\n" +
                   "sudo -n /usr/bin/ssh-keygen -A\n")
        hostkey = self.guest(name, "cat /etc/ssh/ssh_host_ed25519_key.pub\n")
        ip = self.tart("ip", name, "--wait", "60", timeout=75)
        import ipaddress
        ipaddress.ip_address(ip)
        known = self.home / (name + "-known-hosts")
        known.write_text(ip + " " + hostkey + "\n")
        args = ["ssh", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
                "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlgorithms=ssh-ed25519",
                "-o", "UserKnownHostsFile=" + str(known), "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "ConnectTimeout=5", "-i", str(key), "admin@" + ip, "/usr/bin/id -un"]
        assert self.command(args) == "admin"
        config = json.loads((self.home / "vms" / name / "config.json").read_text())
        identity = dict(ip=ip, host_key=hostkey, client_public_key=pub, config=config)
        self.event(name + "-prepared-ssh", **identity)
        return identity

    def state(self, name):
        return self.guest(name, "cd " + WORKSPACE + "\n" +
                          "git status --porcelain=v1\ngit diff --cached\ngit diff\n" +
                          "cat untracked.txt marker.txt\nsqlite3 state.sqlite '.dump'\n" +
                          "sqlite3 state.sqlite 'PRAGMA integrity_check;'\n")

    def run(self):
        assert sys.platform == "darwin"
        assert self.command(["hostname"]) == "macbook-workstation"
        assert "2.32.1" in self.tart("--version")
        assert self.free_before > 60 * 1024**3
        self.event("host", version=self.command(["sw_vers"]), free_bytes=self.free_before, image=IMAGE)
        candidates = [p.parent for p in Path("/Users/example/.tart/cache").rglob("disk.img")
                      if DIGEST in str(p) and not p.is_symlink()]
        assert len(candidates) == 1, [str(p) for p in candidates]
        seed = self.home / "vms" / "public-seed"
        seed.parent.mkdir()
        thread = threading.Thread(target=self.watch_budget, daemon=True)
        thread.start()
        start = time.monotonic()
        apfs_copy(candidates[0], seed)
        self.event("isolated-apfs-public-seed", seconds=time.monotonic() - start, source=str(candidates[0]))
        self.clone("public-seed", "source")
        self.start("source")
        source_identity = self.prepare_ssh("source")
        self.guest("source", "mkdir " + WORKSPACE + "\ncd " + WORKSPACE + "\n" +
                   "git init -q\ngit config user.name 'Disposable Spike'\n" +
                   "git config user.email 'spike@example.invalid'\nprintf 'base\\n' > tracked.txt\n" +
                   "git add tracked.txt\ngit commit -qm seed\nprintf 'staged\\n' >> tracked.txt\n" +
                   "git add tracked.txt\nprintf 'unstaged\\n' >> tracked.txt\n" +
                   "printf 'untracked-source\\n' > untracked.txt\nprintf 'source-marker\\n' > marker.txt\n" +
                   "sqlite3 state.sqlite 'PRAGMA journal_mode=DELETE; CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); " +
                   "BEGIN; INSERT INTO items VALUES(1,\"source-committed\"); COMMIT;'\nsync\n")
        expected = self.state("source")
        assert "MM tracked.txt" in expected and "?? untracked.txt" in expected and "source-committed" in expected
        self.event("dirty-git-sqlite-seeded", state=expected)
        self.stop("source")
        self.clone("source", "checkpoint")
        self.clone("checkpoint", "branch")
        boot1 = self.start("branch")
        assert self.state("branch") == expected
        self.event("checkpoint-restored-dirty-git-and-sqlite")
        branch_identity = self.prepare_ssh("branch")
        assert source_identity["host_key"] != branch_identity["host_key"]
        assert source_identity["client_public_key"] != branch_identity["client_public_key"]
        assert source_identity["ip"] != branch_identity["ip"]
        source_config, branch_config = source_identity["config"], branch_identity["config"]
        assert source_config["macAddress"] != branch_config["macAddress"]
        self.event("distinct-network-and-ssh-identities", source_ip=source_identity["ip"], branch_ip=branch_identity["ip"])
        self.guest("branch", "cd " + WORKSPACE + "\nprintf 'branch-staged\\n' >> tracked.txt\n" +
                   "git add tracked.txt\nprintf 'branch-unstaged\\n' >> tracked.txt\n" +
                   "printf 'branch-untracked\\n' > untracked.txt\nprintf 'branch-marker\\n' > marker.txt\n" +
                   "sqlite3 state.sqlite 'BEGIN; UPDATE items SET value=\"branch-committed\" WHERE id=1; COMMIT;'\nsync\n")
        changed = self.state("branch")
        assert changed != expected and "branch-committed" in changed
        self.stop("branch")
        boot2 = self.start("branch")
        assert boot1 != boot2 and self.state("branch") == changed
        self.event("branch-stop-start-disk-retention", previous_boot=boot1, new_boot=boot2, state=changed)
        self.stop("branch")
        for name in ("source", "checkpoint"):
            self.start(name)
            assert self.state(name) == expected
            self.event(name + "-unaffected-by-branch")
            self.stop(name)
        self.tart("delete", "source")
        self.tart("delete", "checkpoint")
        assert not (self.home / "vms/source").exists() and not (self.home / "vms/checkpoint").exists()
        self.start("branch")
        assert self.state("branch") == changed
        self.event("child-survives-source-and-checkpoint-deletion")
        self.stop("branch")
        self.event("ram-suspend-resume", "NOT RUN", reason="Optional; this test establishes cold disk recovery only")

    def cleanup(self):
        owned(self.home)
        errors = []
        self.done.set()
        for name, proc in self.processes.items():
            if proc.poll() is None:
                try:
                    cmd, env = tart_command(self.home, "stop", vm_name(name), "--timeout", "20")
                    subprocess.run(cmd, env=env, timeout=30, check=True, capture_output=True)
                    proc.wait(timeout=30)
                except Exception as exc:
                    errors.append(repr(exc))
                    if proc.poll() is None:
                        proc.terminate()
                        try:
                            proc.wait(timeout=30)
                        except subprocess.TimeoutExpired:
                            errors.append("Owned VMM still alive; disks retained")
        alive = [name for name, proc in self.processes.items() if proc.poll() is None]
        if not alive:
            for name in reversed(NAMES):
                if (self.home / "vms" / name).exists():
                    try:
                        cmd, env = tart_command(self.home, "delete", vm_name(name))
                        subprocess.run(cmd, env=env, timeout=60, check=True, capture_output=True)
                    except Exception as exc:
                        errors.append(repr(exc))
        for name in NAMES:
            for suffix in ("-client", "-client.pub", "-known-hosts"):
                (self.home / (name + suffix)).unlink(missing_ok=True)
        after = inventory()
        self.save("inventory-after.json", after)
        unchanged = self.before == after
        leftovers = [str(p) for p in (self.home / "vms").iterdir()] if (self.home / "vms").exists() else []
        self.event("cleanup", "PASS" if not errors and not alive and not leftovers and unchanged else "FAIL",
                   errors=errors, live_owned_vms=alive, leftover_vms=leftovers,
                   original_inventory_unchanged=unchanged, peak_host_free_space_delta_bytes=self.peak_growth,
                   final_host_free_space_delta_bytes=self.free_before - shutil.disk_usage(self.home).free)
        self.save("results.json", self.events)
        return not errors and not alive and not leftovers and unchanged


def local_run():
    results = Path(__file__).resolve().parent / "results" / time.strftime("%Y%m%d-%H%M%S")
    results.mkdir(parents=True)
    prerequisite = subprocess.run(SSH + ["hostname; command -v python3"], capture_output=True, text=True)
    (results / "connection.txt").write_text(prerequisite.stdout + prerequisite.stderr)
    if prerequisite.returncode:
        (results / "results.json").write_text(json.dumps({"status": "NOT RUN", "cause": prerequisite.stderr.strip(),
                                                         "remote_mutations": False}, indent=2) + "\n")
        print("Runtime blocked; evidence: " + str(results), flush=True)
        return 1
    lines = prerequisite.stdout.splitlines()
    assert lines[0] == "macbook-workstation" and len(lines) == 2 and lines[1].startswith("/")
    remote_python = lines[1]
    home = subprocess.check_output(SSH + ["mktemp -d /Users/example/clankerbox-tart-checkpoints.XXXXXX"], text=True).strip()
    assert re.fullmatch(r"/Users/example/clankerbox-tart-checkpoints\.[A-Za-z0-9]{6}", home)
    (results / "remote-path.txt").write_text(home + "\n")
    subprocess.run(SSH + ["cat > " + shlex.quote(home + "/.owner")], input=MARKER, text=True, check=True)
    subprocess.run(SSH + ["cat > " + shlex.quote(home + "/checkpoints.py")], input=Path(__file__).read_text(), text=True, check=True)
    with (results / "runtime.log").open("w") as log:
        result = subprocess.run(SSH + [shlex.join([remote_python, home + "/checkpoints.py", "--remote", home])], stdout=log, stderr=subprocess.STDOUT)
    for name in ("results.json", "inventory-before.json", "inventory-after.json"):
        fetched = subprocess.run(SSH + ["cat " + shlex.quote(home + "/" + name)], text=True, capture_output=True)
        if fetched.returncode == 0:
            (results / name).write_text(fetched.stdout)
    print("Evidence: " + str(results) + "; remote small logs: " + home, flush=True)
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--remote", type=Path)
    args = parser.parse_args()
    if args.run:
        return local_run()
    if args.remote:
        experiment = Experiment(args.remote)
        passed = False
        try:
            experiment.run()
            passed = True
        except Exception as exc:
            experiment.event("runtime", "FAIL", cause=repr(exc))
        finally:
            clean = experiment.cleanup()
        return 0 if passed and clean else 1
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
