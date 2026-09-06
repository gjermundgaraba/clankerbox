#!/usr/bin/env python3
"""Real Codex RAM-fork acceptance on the authorized private smolvm runtime."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import sqlite3
import subprocess
import sys
import threading
import time

from codex_network import Proxy
from fork_diagnostics import vm_exec

spec = importlib.util.spec_from_file_location("smolvm_runner", Path(__file__).with_name("run-linux.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
STAGE = base.STAGE
RUN = STAGE / "codex.PsgPI5"
GRANT = "smolvm-codex-20260905"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-slot", required=True)
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    base.require(args.host_slot == GRANT and os.geteuid() != 0 and os.access("/dev/kvm", os.R_OK | os.W_OK),
                 "requires coordinator grant and clanker:kvm execution")
    base.validate_stage(STAGE)
    base.require(RUN.resolve() == RUN and RUN.stat().st_uid == os.getuid(), "invalid private run directory")
    binary = STAGE / "source/target/debug/smolvm"
    lock = (STAGE / "run.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    base.require(not base.staged_processes(binary), "staged VMM/controller already exists")
    proxy_path = RUN / "proxy.sock"
    base.require(not proxy_path.exists(), "private proxy path already exists")
    gate_path = RUN / "model-gate"
    base.require(not gate_path.exists() and not gate_path.is_symlink(), "stale coordinator model gate exists")
    gate_inode = None
    suffix = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    output = RUN / ("results-" + suffix)
    output.mkdir(mode=0o700)
    names = {role: f"cb-smol-{suffix}-{role}" for role in ("parent", "child-a", "child-b")}
    env = dict(os.environ, XDG_DATA_HOME=str(STAGE / "d"), XDG_CACHE_HOME=str(STAGE / "c"),
               XDG_CONFIG_HOME=str(STAGE / "config"), XDG_RUNTIME_DIR=str(STAGE / "r"),
               SMOLVM_LIB_DIR=str(STAGE / "source/lib/linux-x86_64"),
               LD_LIBRARY_PATH=str(STAGE / "source/lib/linux-x86_64"),
               SMOLVM_AGENT_ROOTFS=str(STAGE / "bundle/agent-rootfs"),
               RUST_LOG="smolvm=debug", DOCKER_CONFIG=str(STAGE / "empty-docker"))
    env.pop("SSH_AUTH_SOCK", None)
    env.pop("SMOLVM_DIAG_CHECKPOINT_PAUSE", None)
    commands = (output / "commands.jsonl").open("a")
    commands_lock = threading.Lock()
    report = {"status": "fail", "host_slot": GRANT, "names": names,
              "scope": "real Codex active-shell RAM fork; no guest NIC", "checks": []}
    proxy = Proxy(str(proxy_path))
    proxy.allowed_peers = set()
    os.chmod(proxy_path, 0o600)
    proxy_inode = proxy_path.stat().st_ino
    threading.Thread(target=proxy.serve_forever, daemon=True).start()

    def save(name, value):
        (output / name).write_text(json.dumps(value, indent=2) + "\n")

    def cli(*argv, check=True, timeout=240):
        started = time.monotonic()
        result = subprocess.run([str(binary), *argv], env=env, text=True,
                                capture_output=True, timeout=timeout)
        # These commands never carry credentials. Shared-harness replies are sanitized.
        with commands_lock:
            commands.write(json.dumps({"argv": argv, "returncode": result.returncode,
                                       "elapsed_ms": (time.monotonic()-started)*1000,
                                       "stdout": result.stdout, "stderr": result.stderr}) + "\n")
            commands.flush()
        if check:
            result.check_returncode()
        return result

    def directory(role):
        return STAGE / "c/smolvm/vms" / hashlib.sha256(names[role].encode()).hexdigest()[:16]

    def records():
        with sqlite3.connect("file:"+str(STAGE / "d/smolvm/server/smolvm.db")+"?mode=ro", uri=True) as db:
            return {name: json.loads(data) for name, data in db.execute("SELECT name,data FROM vms")}

    def guest(role, *argv, check=True, timeout=240):
        return cli("machine", "exec", "--name", names[role], "--", *argv, check=check, timeout=timeout)

    def call(role, op, branch=False, check=True):
        argv = ["python3", "/opt/real-agent/client.py", op]
        if branch:
            argv += ["--name", role]
        result = guest(role, *argv, check=False)
        value = json.loads(result.stdout) if result.stdout.strip() else {"ok": False, "error": "EmptyGuestReply"}
        if check:
            base.require(result.returncode == 0 and value.get("ok"), f"{role}:{op}: {value.get('error', 'failed')}")
        return value

    def identities():
        rows = records()
        result = {role: {**base.owned_process(rows[name]["pid"], binary), "record": rows[name]}
                  for role, name in names.items() if name in rows}
        return result

    def parallel_phase(op, branch=False):
        def invoke(role):
            started = time.monotonic()
            value = call(role, op, branch=branch)
            completed = time.monotonic()
            save(f"{role}-{op}.json", value)
            return role, {"started": started, "completed": completed}
        with ThreadPoolExecutor(max_workers=3) as pool:
            timings = dict(pool.map(invoke, names))
        save(f"{op}-timings.json", timings)
        return timings

    def retain_failure(role):
        # Only bounded, sanitized controller replies: never raw logs or HOME.
        for op in ("status", "report"):
            try:
                result = guest(role, "python3", "/opt/real-agent/client.py", "--timeout", "5", op,
                               check=False, timeout=10)
                value = json.loads(result.stdout) if result.stdout.strip() else {"ok": False, "error": "EmptyGuestReply"}
                save(f"failure-{role}-{op}.json", value)
            except Exception as error:
                save(f"failure-{role}-{op}.json", {"ok": False, "error": type(error).__name__})

    try:
        cli("machine", "create", "--name", names["parent"], "--image", str(RUN / "image"),
            "--cpus", "2", "--mem", "2048", "--storage", "4", "--overlay", "2",
            "--mount-socket", f"{proxy_path}:/run/real-agent-proxy.sock",
            "--", "/bin/sh", "/opt/real-agent/codex-boot.sh")
        cli("machine", "start", "--name", names["parent"], "--branchable")
        proxy.allow_peer(records()[names["parent"]]["pid"])
        guest("parent", "/bin/sh", "-c", "test -d /home/agent/.codex && id agent && /opt/real-agent/codex --version && /opt/real-agent/runtime/codex-resources/zsh/bin/zsh --version")
        network = json.loads(guest("parent", "python3", "/opt/real-agent/codex_preflight.py").stdout)
        save("guest-network.json", network)
        base.require(network.get("ok"), "guest has non-dummy external interface or default route")
        container_state = vm_exec(directory("parent") / "agent.sock", ["/bin/sh", "-c",
            "cat /storage/containers/crun/*/status"])
        base.require(container_state.get("exit_code") == 0, "container identity query failed")
        container_pid = json.loads(container_state["stdout"])["pid"]
        ready = {"agent_socket": str(directory("parent") / "agent.sock"),
                 "container_name": names["parent"], "guest_auth_path": "/home/agent/.codex/auth.json",
                 "guest_uid": 1100, "guest_gid": 1100, "result_dir": str(output),
                 "container_pid": container_pid,
                 "vm_auth_path": f"/proc/{container_pid}/root/home/agent/.codex/auth.json",
                 "proxy_socket": str(proxy_path)}
        save("ready-for-auth.json", ready)
        print(json.dumps({"awaiting_auth": ready}), flush=True)
        # This only polls controller readiness; baseline is the first model call.
        deadline = time.monotonic() + 900
        while not call("parent", "status", check=False).get("ok"):
            base.require(time.monotonic() < deadline, "coordinator auth/controller readiness deadline")
            time.sleep(3)
        save("controller-ready.json", call("parent", "status"))
        print(json.dumps({"awaiting_model_gate": str(gate_path)}), flush=True)
        deadline = time.monotonic() + 1800
        while not gate_path.is_file():
            base.require(time.monotonic() < deadline, "coordinator model gate deadline")
            time.sleep(3)
        base.require(not gate_path.is_symlink() and gate_path.stat().st_uid == os.getuid(), "invalid coordinator model gate")
        gate_inode = gate_path.stat().st_ino
        save("baseline.json", call("parent", "baseline"))
        save("barrier-start.json", call("parent", "barrier-start"))
        deadline = time.monotonic() + 190
        while True:
            status = call("parent", "status")
            if status.get("state", {}).get("barrierWaiting") or status.get("barrierWaiting"):
                save("barrier-waiting.json", status)
                relay_before = json.loads(guest("parent", "python3", "/opt/real-agent/relay.py", "status").stdout)
                save("relay-before-fork.json", relay_before)
                break
            base.require(time.monotonic() < deadline, "active builtin shell barrier did not become ready")
            time.sleep(1)
        for child in ("child-a", "child-b"):
            cli("machine", "branch", "--from", names["parent"], "--name", names[child], timeout=300)
            save(f"{child}-restored-status.json", call(child, "status"))
            save(f"parent-after-{child}.json", call("parent", "status"))
            # New child tunnels are denied until its inherited relay sockets
            # are closed in place. Codex/controller/relay processes stay alive.
            reset = json.loads(guest(child, "python3", "/opt/real-agent/relay.py", "reset").stdout)
            base.require(reset.get("ok") and reset.get("oldTunnelsRemaining") == 0
                         and reset.get("pid") == relay_before.get("pid"), "child relay reset/identity failed")
            save(f"{child}-relay-reset.json", reset)
            proxy.allow_peer(records()[names[child]]["pid"])
        live = identities()
        base.require(len(live) == 3 and len({p["pid"] for p in live.values()}) == 3, "three live VMMs required")
        save("concurrent-processes.json", live)
        for role in names:
            save(f"{role}-barrier-release.json", call(role, "barrier-release", branch=True))
        parallel_phase("barrier-wait")
        ordering = {"clock": "host-monotonic", "ramSnapshotVerified": True,
                    "writesCompleted": {}, "readsStarted": {}}
        branch_times = parallel_phase("branch", branch=True)
        ordering["writesCompleted"] = {role: timing["completed"] for role, timing in branch_times.items()}
        parallel_phase("followup")
        for role in names:
            ordering["readsStarted"][role] = time.monotonic()
            save(f"{role}.json", call(role, "report"))
        save("ordering.json", ordering)
        evaluated = subprocess.run([sys.executable, str(RUN / "harness/evaluate.py"),
            *[str(output / f"{role}.json") for role in names], "--ordering", str(output / "ordering.json"),
            "--require-barrier"], text=True, capture_output=True)
        (output / "acceptance.json").write_text(evaluated.stdout)
        evaluated.check_returncode()
        report["checks"].append({"name": "real_codex_active_shell_ram_fork", "status": "pass"})
        save("proxy-fault.json", {"at": time.monotonic(), "closed_tunnels": proxy.disconnect()})
        parallel_phase("recovery-followup")
        for role in names:
            save(f"{role}-recovery.json", call(role, "report"))
        recovery = subprocess.run([sys.executable, str(RUN / "harness/evaluate.py"),
            *[str(output / f"{role}-recovery.json") for role in names], "--ordering", str(output / "ordering.json"),
            "--require-barrier", "--allow-upstream-recovery"], text=True, capture_output=True)
        (output / "recovery-acceptance.json").write_text(recovery.stdout)
        recovery.check_returncode()
        report["checks"].append({"name": "forced_provider_disconnect_followup", "status": "pass"})
        report["status"] = "pass"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        try:
            rows = records()
            with ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(retain_failure, [role for role in names if names[role] in rows]))
        except Exception as diagnostic_error:
            report["diagnostic_error"] = type(diagnostic_error).__name__
    finally:
        cleanup = []
        for role in ("child-b", "child-a", "parent"):
            try:
                if names[role] not in records():
                    continue
                if role == "parent":
                    base.require(not [r for r in records().values() if r.get("golden") == names["parent"]],
                                 "dependent children remain; preserving source")
                result = cli("machine", "delete", "--name", names[role], "--force", check=False)
                cleanup.append({"name": names[role], "returncode": result.returncode})
            except Exception as error:
                cleanup.append({"name": names[role], "error": type(error).__name__})
        proxy.disconnect()
        proxy.shutdown()
        proxy.server_close()
        if proxy_path.exists() and proxy_path.stat().st_ino == proxy_inode:
            proxy_path.unlink()
        save("proxy-counts.json", {"accepted": proxy.counts, "denied_or_closed": proxy.denied})
        processes = base.staged_processes(binary)
        remaining = [name for name in names.values() if name in records()]
        if not remaining and not processes:
            for name in names.values():
                base.remove_owned_orphan(name)
        disks = [str(directory(role)) for role in names if directory(role).exists()]
        if not remaining and not processes and not disks and gate_inode is not None:
            if gate_path.exists() and not gate_path.is_symlink() and gate_path.stat().st_ino == gate_inode:
                gate_path.unlink()
        save("cleanup.json", {"deletes": cleanup, "processes": processes, "records": remaining, "disks": disks})
        if remaining or processes or disks:
            report["status"] = "fail"
            report["cleanup_incomplete"] = True
        save("result.json", report)
        commands.close()
        print(json.dumps({"status": report["status"], "result": str(output / "result.json")}), flush=True)
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
