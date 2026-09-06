#!/usr/bin/env python3
"""Disposable KVM acceptance. Requires an explicit coordinator host-slot token."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import shutil
import socket
import stat
import sqlite3
import subprocess
import sys
import time


STAGE = Path("/home/clanker/clankerbox-smolvm.Jf1bpB")
GRANT = "smolvm-fix-20260905"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_stage(path):
    if path != STAGE or path.is_symlink() or path.resolve() != STAGE:
        raise ValueError(f"unauthorized staging path: {path}")
    return path


def owned_process(pid, binary, expected_start=None, proc_root=Path("/proc")):
    if type(pid) is not int or pid <= 1:
        raise ValueError(f"invalid VMM PID: {pid!r}")
    proc = proc_root / str(pid)
    try:
        executable = (proc / "exe").resolve(strict=True)
    except PermissionError:
        require(proc_root == Path("/proc") and binary == STAGE / "source/target/debug/smolvm",
                "privileged observer requested outside the authorized runtime")
        result = observe("--pid", str(pid))
        require(result["executable"] == str(binary.resolve()), "observer returned a foreign executable")
        if expected_start is not None and result["start_time"] != expected_start:
            raise ValueError(f"PID {pid} changed ownership; refusing signal")
        return result
    if executable != binary.resolve(strict=True):
        raise ValueError(f"PID {pid} does not execute the staged smolvm binary")
    if proc.stat().st_uid != os.getuid():
        raise ValueError(f"PID {pid} belongs to another user")
    proc_stat = (proc / "stat").read_text()
    fields = proc_stat.rsplit(")", 1)[1].split()
    if len(fields) < 20 or fields[0] == "Z":
        raise ValueError(f"PID {pid} is dead or has invalid process metadata")
    birth = fields[19]
    if expected_start is not None and birth != expected_start:
        raise ValueError(f"PID {pid} changed ownership; refusing signal")
    return {"pid": pid, "start_time": birth, "proc_stat": proc_stat,
            "cmdline": (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode()}


def observe(*args):
    result = subprocess.run(["sudo", "-n", "--", "python3", str(STAGE / "observe-linux.py"), *args],
                            text=True, capture_output=True, check=True, timeout=15)
    return json.loads(result.stdout)


def staged_processes(binary):
    if binary == STAGE / "source/target/debug/smolvm":
        return observe("--inventory")
    found = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        candidate = False
        try:
            argv = (proc / "cmdline").read_bytes().split(b"\0")
            candidate = bool(argv) and argv[0] == os.fsencode(binary)
            if candidate:
                # Do not silently count inaccessible, hardened staged VMMs as gone.
                found.append(owned_process(int(proc.name), binary))
            elif (proc / "exe").resolve(strict=True) == binary.resolve(strict=True):
                found.append(owned_process(int(proc.name), binary))
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            if candidate:
                raise RuntimeError(f"cannot audit staged process {proc.name}; it may still be alive")
            continue  # An unrelated user's process is outside this private run.
    return found


def clear_dead_socket(path, expected_inode=None):
    if not path.exists() and not path.is_symlink():
        return
    metadata = path.lstat()
    if (expected_inode is None or metadata.st_ino != expected_inode or
            metadata.st_uid != os.getuid() or not stat.S_ISSOCK(metadata.st_mode)):
        raise ValueError(f"refusing an unowned or unexpected controller socket: {path}")
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(1)
        try:
            client.connect(str(path))
        except OSError as error:
            if error.errno != errno.ECONNREFUSED:
                raise ValueError(f"cannot prove controller socket is inactive: {path}") from error
        else:
            raise ValueError(f"controller listener is still active: {path}")
    if path.lstat().st_ino != expected_inode:
        raise ValueError("controller socket changed during ownership check")
    path.unlink()


def remove_owned_orphan(name):
    if not re.fullmatch(r"cb-smol-[0-9]{8}-[0-9]{6}-(parent|child-[ab])", name):
        raise ValueError("invalid disposable VM identity for orphan cleanup")
    binary = STAGE / "source/target/debug/smolvm"
    require(not staged_processes(binary), "refusing orphan cleanup with staged processes alive")
    db_path = STAGE / "d/smolvm/server/smolvm.db"
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as db:
        require(db.execute("SELECT COUNT(*) FROM vms").fetchone()[0] == 0,
                "refusing orphan cleanup while any private VM record/lineage remains")
    path = STAGE / "c/smolvm/vms" / hashlib.sha256(name.encode()).hexdigest()[:16]
    if not path.exists() and not path.is_symlink():
        return
    require(path.resolve() == path and not path.is_symlink(), "orphan disk path is redirected")
    require(path.stat().st_uid == os.getuid(), "orphan disk directory belongs to another user")
    require((path / "name").read_text().strip() == name, "orphan disk identity marker does not match")
    shutil.rmtree(path)


def wait_for(fn, seconds=60):
    deadline = time.monotonic() + seconds
    while True:
        try:
            value = fn()
            if value:
                return value
        except (OSError, ValueError, subprocess.CalledProcessError):
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError(f"readiness timed out after {seconds}s")
        time.sleep(0.1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--acceptance", type=Path, required=True)
    parser.add_argument("--host-slot", required=True, help="coordinator-issued execution grant reference")
    parser.add_argument("--retention-only", action="store_true", help="one-VM disk/lifecycle checks, without RAM branches")
    parser.add_argument("--fork-diagnostic", action="store_true", help="resident pre-capture observer and one-child failure localization")
    args = parser.parse_args()
    stage, kit = validate_stage(args.stage), args.acceptance.resolve()
    require(stage.stat().st_uid == os.getuid(), "staging directory belongs to another user")
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        parser.error("this runner requires Linux x86_64/KVM")
    if os.geteuid() == 0:
        parser.error("run as clanker with effective group kvm, not as root")
    if args.host_slot != GRANT or not os.access("/dev/kvm", os.R_OK | os.W_OK):
        parser.error("host execution grant and /dev/kvm access required")
    require(kit == stage / "acceptance", "acceptance kit must be the staged copy")
    run_lock = (stage / "run.lock").open("a")
    fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for path in (kit / "guest.py", kit / "evaluate.py", stage / "workload/opt/acceptance/guest.py"):
        if not path.is_file():
            parser.error(f"missing prepared artifact: {path}")
    if (kit / "guest.py").read_bytes() != (stage / "workload/opt/acceptance/guest.py").read_bytes():
        parser.error("prepared guest.py differs from acceptance kit")
    binary = stage / "source/target/debug/smolvm"
    if not binary.is_file():
        parser.error("build the patched Linux binary first")
    require(binary.resolve().is_relative_to(stage), "staged binary escapes the authorized directory")
    for relative in ("d", "c", "config", "r", "empty-docker"):
        require((stage / relative).resolve() == stage / relative, f"private {relative} directory is redirected")
    require(not staged_processes(binary), "existing staged VMM/controller/guardian processes; refusing new run")
    clear_dead_socket(stage / "r/api.sock")
    output = stage / ("results-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime()))
    output.mkdir()
    # Private XDG paths isolate database/cache/defaults; HOME is unchanged.
    env = dict(os.environ, XDG_DATA_HOME=str(stage / "d"), XDG_CACHE_HOME=str(stage / "c"),
               XDG_CONFIG_HOME=str(stage / "config"), XDG_RUNTIME_DIR=str(stage / "r"),
               SMOLVM_LIB_DIR=str(stage / "source/lib/linux-x86_64"),
               LD_LIBRARY_PATH=str(stage / "source/lib/linux-x86_64"),
               SMOLVM_AGENT_ROOTFS=str(stage / "bundle/agent-rootfs"),
               RUST_LOG="smolvm=debug", DOCKER_CONFIG=str(stage / "empty-docker"))
    for key in ("XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DOCKER_CONFIG"):
        Path(env[key]).mkdir(mode=0o700, exist_ok=True)
    # No secrets, SSH agent, host mounts, inbound TCP or outbound networking.
    env.pop("SSH_AUTH_SOCK", None)
    suffix = output.name.removeprefix("results-")
    names = {role: f"cb-smol-{suffix}-{role}" for role in ("parent", "child-a", "child-b")}
    db_path = stage / "d/smolvm/server/smolvm.db"
    api = stage / "r/api.sock"
    commands = (output / "commands.jsonl").open("a")
    controller = None
    resident = None
    controller_socket_inode = None
    controller_log = (output / "controller.log").open("a")
    report = {"schema_version": 1, "execution_scope": "vm", "status": "fail", "checks": [
                  {"name": name, "status": "not-run"} for name in (
                      "source_pause", "network_separation_and_quarantine", "guest_docker",
                      "real_coding_agent_session", "portable_ram_recovery", "host_reboot")],
              "metrics": {"source_pause_ms": None}, "evidence": {"host_slot": args.host_slot,
                  "timing_context": "concurrent host activity; not isolated performance"},
              "limitations": ["Source pause is unmeasured; branch latency includes capture and child readiness.",
                              "Networking is disabled; network identity/quarantine and Docker are NOT RUN.",
                              "Real coding-agent sessions, capacity faults, cross-host restore and reboot are NOT RUN."]}

    def save(name, value):
        (output / name).write_text(json.dumps(value, indent=2) + "\n")

    def cli(*argv, timeout=180, check=True):
        started = time.monotonic()
        proc = subprocess.run([str(binary), *argv], env=env, capture_output=True, text=True, timeout=timeout)
        commands.write(json.dumps({"argv": argv, "returncode": proc.returncode,
                                   "elapsed_ms": (time.monotonic() - started) * 1000,
                                   "stdout": proc.stdout, "stderr": proc.stderr}) + "\n")
        commands.flush()
        if check:
            proc.check_returncode()
        return proc

    def guest(role, *argv):
        return cli("machine", "exec", "--name", names[role], "--", *argv).stdout

    def call(role, request):
        return json.loads(guest(role, "python3", "/opt/acceptance/guest.py", "call", json.dumps(request)))

    def records():
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as db:
            return {name: json.loads(data) for name, data in db.execute("SELECT name,data FROM vms")}

    def vm_dir(role):
        digest = hashlib.sha256(names[role].encode()).hexdigest()[:16]
        return stage / "c/smolvm/vms" / digest

    def process_evidence():
        rows, result = records(), {}
        for role, name in names.items():
            pid = rows[name]["pid"]
            proc = Path(f"/proc/{pid}")
            result[role] = {**owned_process(pid, binary), "record": rows[name]}
            if "smaps_rollup" not in result[role]:
                result[role]["smaps_rollup"] = (proc / "smaps_rollup").read_text()
        require(len({p["pid"] for p in result.values()}) == 3, "expected three distinct VMM processes")
        return result

    def stop_controller():
        nonlocal controller
        if controller is not None:
            controller.terminate()
            try:
                controller.wait(timeout=15)
            except subprocess.TimeoutExpired:
                controller.kill()
                controller.wait(timeout=10)
            controller = None

    def start_controller():
        nonlocal controller, controller_socket_inode
        require(controller is None, "controller handle is still active")
        clear_dead_socket(api, controller_socket_inode)
        controller = subprocess.Popen([str(binary), "serve", "start", "--listen", str(api)],
                                      env=env, stdout=controller_log, stderr=controller_log)
        def healthy():
            if controller.poll() is not None:
                raise RuntimeError("controller exited; inspect controller.log")
            return subprocess.run(["curl", "--silent", "--fail", "--max-time", "2", "--unix-socket",
                                   str(api), "http://localhost/health"], capture_output=True).returncode == 0
        wait_for(healthy)
        controller_socket_inode = api.stat().st_ino

    def passed(name):
        report["checks"].append({"name": name, "status": "pass"})

    def kill_recorded_vmm(role, previous):
        pid = records()[names[role]]["pid"]
        owned_process(pid, binary, previous["start_time"])
        fd = os.pidfd_open(pid)
        try:
            owned_process(pid, binary, previous["start_time"])
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        finally:
            os.close(fd)
        wait_for(lambda: not Path(f"/proc/{pid}").exists())

    def check_retention_only(baseline):
        report["evidence"]["mode"] = "one_vm_retention"
        report["checks"].append({"name": "concurrent_ram_fork", "status": "not-run"})
        changed = call("parent", {"op": "mutate", "delta": 10, "label": "parent"})
        start_controller()
        stop_controller()
        start_controller()
        now = call("parent", {"op": "status"})
        require(now["marker_sha256"] == baseline["marker_sha256"] and now["pid"] == baseline["pid"],
                "controller restart changed the continuing process")
        save("retention-continuity.json", {"baseline": baseline, "changed": changed, "after_controller_restart": now})
        passed("controller_restart_preserves_running_process")
        cli("machine", "stop", "--name", names["parent"])
        cli("machine", "start", "--name", names["parent"])
        require(json.loads(guest("parent", "cat", "/var/tmp/clanker-acceptance-disk.json")) == changed["disk"],
                "explicit stop/start lost workspace")
        passed("explicit_stop_start_retains_disk")
        stop_controller()
        previous = owned_process(records()[names["parent"]]["pid"], binary)
        kill_recorded_vmm("parent", previous)
        start_controller()
        row = records()[names["parent"]]
        require(row["state"].lower() == "stopped" and row["pid"] is None, "dead machine was not retained stopped")
        require(vm_dir("parent").is_dir(), "dead machine data directory was removed")
        save("after-vmm-death.json", row)
        cli("machine", "start", "--name", names["parent"])
        require(json.loads(guest("parent", "cat", "/var/tmp/clanker-acceptance-disk.json")) == changed["disk"],
                "cold restart after VMM death lost disk state")
        passed("vmm_death_reconciliation_and_cold_restart_retain_disk")
        report["status"] = "pass"

    try:
        # Disk exists after cold restart: leave it intact and keep the workload idle.
        workload = ("if test -e /var/tmp/clanker-acceptance-disk.json; then exec sleep infinity; "
                    "else exec python3 /opt/acceptance/guest.py serve --socket /tmp/clanker-acceptance.sock "
                    "--disk /var/tmp/clanker-acceptance-disk.json; fi")
        cli("machine", "create", "--name", names["parent"], "--image", str(stage / "workload"),
            "--cpus", "2", "--mem", "1024", "--storage", "4", "--overlay", "1",
            "--", "sh", "-c", workload)
        cli("machine", "start", "--name", names["parent"], "--branchable")
        baseline = wait_for(lambda: call("parent", {"op": "status"}))
        save("baseline.json", baseline)
        if args.fork_diagnostic:
            from fork_diagnostics import start_resident
            env["SMOLVM_DIAG_CHECKPOINT_PAUSE"] = "1"
            resident = start_resident(vm_dir("parent") / "agent.sock")
            time.sleep(3)
        if args.retention_only:
            check_retention_only(baseline)
            return 0  # finally still audits and deletes every disposable artifact.
        fork_ms = {}
        for child in ("child-a", "child-b"):
            began = time.monotonic()
            cli("machine", "branch", "--from", names["parent"], "--name", names[child], timeout=300)
            if args.fork_diagnostic:
                save("parent-child-ready-before-exec.json", {
                    "at": time.time(), "exec": cli("machine", "exec", "--name", names["parent"],
                                                  "--", "/bin/true", check=False).returncode})
            wait_for(lambda: call(child, {"op": "status"}))
            fork_ms[child] = (time.monotonic() - began) * 1000
            save(f"parent-after-{child}.json", call("parent", {"op": "status"}))
        # Single-child branches do not require changing the acceptance process to
        # participate in smolvm's optional batch rendezvous protocol.
        observed = process_evidence()
        save("concurrent-processes.json", observed)
        inherited = {role: call(role, {"op": "status"}) for role in names}
        for role, delta in (("parent", 10), ("child-a", 100), ("child-b", 1000)):
            call(role, {"op": "mutate", "delta": delta, "label": role})
        after = {role: call(role, {"op": "status"}) for role in names}
        evidence = {"execution_scope": "vm", "concurrently_running": True, "baseline": baseline,
                    "inherited": inherited, "after": after, "metrics": {"source_pause_ms": None,
                    **{f"{role}_branch_to_exec_ms": ms for role, ms in fork_ms.items()}}}
        save("evidence.json", evidence)
        evaluated = subprocess.run([sys.executable, str(kit / "evaluate.py"), str(output / "evidence.json")],
                                   text=True, capture_output=True)
        (output / "acceptance.json").write_text(evaluated.stdout)
        evaluated.check_returncode()
        passed("shared_ram_pid_memory_and_disk_acceptance")
        start_controller()
        refused = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "15", "--unix-socket",
                                  str(api), "-X", "DELETE", "-o", str(output / "source-delete-refusal.json"),
                                  "-w", "%{http_code}", f"http://localhost/api/v1/machines/{names['parent']}"],
                                 text=True, capture_output=True, check=True)
        require(refused.stdout == "409", "source API deletion did not return the required lineage conflict")
        require(process_evidence().keys() == observed.keys(), "lost running VMM after refused source deletion")
        passed("source_delete_refused_while_children_depend_on_it")
        stop_controller()
        start_controller()
        reconnected = {role: call(role, {"op": "status"}) for role in names}
        require(all(reconnected[r]["pid"] == after[r]["pid"] and
                   reconnected[r]["marker_sha256"] == after[r]["marker_sha256"] for r in names),
                "controller restart changed the continuing guest process")
        save("after-controller-restart.json", process_evidence())
        passed("controller_restart_preserves_three_running_processes")
        cli("machine", "stop", "--name", names["child-a"])
        cli("machine", "start", "--name", names["child-a"])
        require(json.loads(guest("child-a", "cat", "/var/tmp/clanker-acceptance-disk.json")) == after["child-a"]["disk"],
                "child-a disk changed across stop/start")
        passed("explicit_stop_start_retains_child_disk")
        stop_controller()
        # The common sentinel uses ordinary buffered writes. Establish the
        # guest-to-disk durability boundary before testing cold crash recovery.
        guest("child-b", "/bin/sync")
        passed("guest_sync_establishes_disk_durability_before_vmm_death")
        kill_recorded_vmm("child-b", observed["child-b"])
        start_controller()
        row = records()[names["child-b"]]
        require(row["state"].lower() == "stopped" and row["pid"] is None, "crashed child was not retained stopped")
        require(vm_dir("child-b").is_dir(), "crashed child disk directory was deleted")
        save("after-vmm-death.json", row)
        cli("machine", "start", "--name", names["child-b"])
        require(json.loads(guest("child-b", "cat", "/var/tmp/clanker-acceptance-disk.json")) == after["child-b"]["disk"],
                "child-b disk changed after VMM death")
        passed("vmm_death_controller_recovery_and_cold_restart_retain_disk")
        # One real guest compilation using the already-installed Python runtime.
        guest("child-b", "python3", "-c", "import py_compile; py_compile.compile('/opt/acceptance/guest.py', doraise=True)")
        passed("guest_python_compile")
        report["status"] = "pass"
        report["evidence"].update({"acceptance": str(output / "acceptance.json"), "names": names})
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        # Preserve non-secret guest executable diagnostics before deleting fixtures.
        for role in names:
            try:
                if not db_path.exists() or names[role] not in records():
                    continue  # Upstream exec on an absent name can create orphan disks.
                cli("machine", "exec", "--name", names[role], "--", "/bin/sh", "-c",
                    "ls -l /usr/local/bin/python*; od -An -tx1 -N32 /usr/local/bin/python3.13", check=False, timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                pass
        raise
    finally:
        if resident is not None:
            try:
                save("resident-probe.json", resident[1].result(timeout=50))
            except Exception as error:
                save("resident-probe-error.json", {"error": f"{type(error).__name__}: {error}"})
                report["status"] = "fail"
            finally:
                resident[0].shutdown(wait=True)
        stop_controller()
        clear_dead_socket(api, controller_socket_inode)
        cleanup = []
        for role in ("child-b", "child-a", "parent"):
            try:
                if role == "parent" and db_path.exists():
                    dependents = [n for n, row in records().items() if row.get("golden") == names["parent"]]
                    require(not dependents, f"refusing source cleanup while children remain: {dependents}")
                result = cli("machine", "delete", "--name", names[role], "--force", check=False)
                cleanup.append({"name": names[role], "returncode": result.returncode})
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                cleanup.append({"name": names[role], "error": str(error)})
                report["status"] = "fail"
        save("cleanup.json", cleanup)
        if db_path.exists():
            remaining = [name for name in names.values() if name in records()]
            if remaining:
                report["status"] = "fail"
                report["cleanup_remaining"] = remaining
            else:
                passed("explicit_delete_removes_disposable_records")
        remaining_processes = staged_processes(binary)
        if not remaining_processes and db_path.exists() and not records():
            for role in names:
                remove_owned_orphan(names[role])
        remaining_disks = [str(vm_dir(role)) for role in names if vm_dir(role).exists()]
        save("cleanup-audit.json", {"processes": remaining_processes, "disk_directories": remaining_disks})
        if remaining_processes or remaining_disks:
            report["status"] = "fail"
            report["cleanup_remaining_processes_or_disks"] = True
        else:
            passed("no_staged_vmm_guardian_or_owned_disk_remains")
        save("result.json", report)
        print(json.dumps({"status": report["status"], "result": str(output / "result.json")}))
        commands.close()
        controller_log.close()
        if args.retention_only and report["status"] != "pass":
            raise RuntimeError(f"retention or cleanup failed; inspect {output / 'result.json'}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
