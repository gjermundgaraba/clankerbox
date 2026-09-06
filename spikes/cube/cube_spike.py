#!/usr/bin/env python3
"""Pinned Cube SDK procedure. Execute inside the disposable Cube host VM only."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent
REV = "d0081641c59822e4e5653b7462e914410b81910a"
GRANTS = frozenset(("cube-isolated-20260905", "cube-codex-20260905"))
NAMES = ("parent", "child-a", "child-b")
DELTAS = (10, 100, 1000)
GUEST = "/var/tmp/cube-guest.py"


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


def write(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(temp, 0o600)
    temp.replace(path)


def isolated():
    if Path("/etc/clanker-cube-disposable").read_text().strip() != REV:
        raise RuntimeError("Missing disposable target identity")
    if subprocess.check_output(["systemd-detect-virt", "--vm"], text=True).strip() != "kvm":
        raise RuntimeError("Requires a disposable KVM VM, never the existing bare-metal host")
    scope = json.loads((ROOT / '.work/scope.json').read_text())
    marker = json.loads(Path('/etc/clanker-cube-scope').read_text())
    require(scope == marker and scope['grant'] in GRANTS, 'Wrong isolated scope marker')


def sdk():
    source = ROOT / ".work/upstream"
    require(subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() == REV,
            'SDK source revision mismatch')
    from cubesandbox import Config, Sandbox, Template
    config = Config(api_url="http://127.0.0.1:3000", proxy_node_ip="127.0.0.1", proxy_port=80)
    if config.api_key:
        raise RuntimeError("Use the isolated unauthenticated fixture stack, no personal credentials")
    return Sandbox, Template, config


class Run:
    def __init__(self, directory, Sandbox, config, create=False):
        self.directory, self.Sandbox, self.config = Path(directory), Sandbox, config
        if create:
            self.directory.mkdir(parents=True, exist_ok=False)
            self.data = {"run": "cube-spike-" + uuid.uuid4().hex, "instances": {},
                         "snapshot": None, "pending": None, "deleted": []}
            self.save()
        else:
            self.data = json.loads((self.directory / "ledger.json").read_text())

    def save(self):
        write(self.directory / "ledger.json", self.data)

    def create(self, name, template):
        # Journal intent before an API call: an ambiguous response must not be retried blindly.
        self.data["pending"] = {"kind": "create", "name": name, "template": template}
        self.save()
        sb = self.Sandbox.create(template=template, timeout=-1, allow_internet_access=False,
                                 metadata={"clanker_run": self.data["run"], "branch": name}, config=self.config)
        self.data["instances"][name] = sb.sandbox_id
        self.data["pending"] = None
        self.save()
        return sb

    def snapshot(self, parent):
        self.data["pending"] = {"kind": "snapshot", "name": self.data["run"]}
        self.save()
        snap = parent.create_snapshot(name=self.data["run"])
        self.data["snapshot"] = snap.snapshot_id
        self.data["pending"] = None
        self.save()
        return snap.snapshot_id

    def attach(self, name):
        # Constructor attaches HTTP clients without /connect, which can resume a dead/paused VM.
        sb = self.Sandbox({"sandboxID": self.data["instances"][name]}, config=self.config)
        info = sb.get_info()
        data = dict(info)
        # SDK redacts this from serialization; use it only in process memory.
        if info.get("envdAccessToken"):
            data["envdAccessToken"] = info.get("envdAccessToken")
        sb.close()
        return self.Sandbox(data, config=self.config)

    def command(self, name, command, timeout=60):
        result = self.attach(name).commands.run(command, timeout=timeout, user="root")
        with (self.directory / "commands.jsonl").open("a") as log:
            log.write(json.dumps({"branch": name, "command": command, "stdout": result.stdout,
                                  "stderr": result.stderr, "exit_code": result.exit_code}) + "\n")
        if result.exit_code != 0:
            raise RuntimeError(f"{name} command exit {result.exit_code}: {result.stderr}")
        return result.stdout.strip()

    def state(self, name, request=None):
        return json.loads(self.command(name, f"python3 {GUEST} call " + shlex.quote(json.dumps(request or {"op": "status"}))))

    def infos(self):
        result = {name: dict(self.attach(name).get_info()) for name in NAMES}
        require(len({i["sandboxID"] for i in result.values()}) == 3, 'Expected three independent IDs')
        require(all(i.get("state") == "running" and not i.get("endAt") for i in result.values()),
                'Expected running instances with no expiration deadline')
        return result

    def cleanup(self):
        if self.data["pending"]:
            raise RuntimeError("Ambiguous API outcome: reconcile ledger against list/snapshots before cleanup")
        # Children first, source next, checkpoint last. A failed kill preserves the recovery point.
        for name in ("child-b", "child-a", "parent"):
            if name not in self.data["instances"] or name in self.data["deleted"]:
                continue
            sb = self.Sandbox({"sandboxID": self.data["instances"][name]}, config=self.config)
            try:
                info = sb.get_info()
            except Exception as error:
                if getattr(error, "status_code", None) != 404:
                    raise
            else:
                if info.get("metadata", {}).get("clanker_run") != self.data["run"]:
                    raise RuntimeError("Refusing cleanup of an unowned sandbox")
                sb.kill()
            self.data["deleted"].append(name)
            self.save()
        if self.data["snapshot"]:
            try:
                self.Sandbox.delete_snapshot(self.data["snapshot"], config=self.config)
            except Exception as error:
                if getattr(error, "status_code", None) != 404:
                    raise
            self.data["snapshot"] = None
            self.save()


def inventory():
    processes = []
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            executable = (proc / "exe").resolve().name
            if executable not in ("cube-runtime", "containerd-shim-cube-rs"):
                continue
            processes.append({"pid": int(proc.name), "exe": executable,
                              "cmdline": (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(),
                              "stat": (proc / "stat").read_text(),
                              "smaps_rollup": (proc / "smaps_rollup").read_text()})
        except (OSError, ProcessLookupError):
            continue
    return {"processes": processes, "allocated_disk": subprocess.check_output(
        ["du", "-sx", "--block-size=1", "/data/cubelet"], text=True)}


def runtime_mapping(instances, proc_root=Path('/proc'),
                    bundles=Path('/data/cubelet/state/io.containerd.runtime.v2.task/default')):
    """v0.7.0 embeds its VMM in the shim; vmm.pid records that process."""
    require(set(instances) == set(NAMES), 'Missing branch IDs for runtime mapping')
    candidates = {}
    for proc in proc_root.glob('[0-9]*'):
        try:
            if (proc / 'exe').resolve(strict=True).name != 'containerd-shim-cube-rs':
                continue
            args = (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
            if args.count('-id') == 1:
                candidates.setdefault(args[args.index('-id') + 1], []).append(proc)
        except (OSError, IndexError):
            continue
    result = {}
    for name in NAMES:
        sid = instances[name]
        require(sid and Path(sid).name == sid and sid not in ('.', '..'), 'Invalid sandbox ID')
        bundle = bundles / sid
        require(len(candidates.get(sid, [])) == 1, 'Expected one runtime identifying this sandbox')
        proc = candidates[sid][0]
        pid = int(proc.name)
        # The bundle lives in the shim's mount namespace, not necessarily ours.
        require(pid > 1 and int((proc / 'cwd/vmm.pid').read_text()) == pid and
                int((proc / 'cwd/shim.pid').read_text()) == pid, 'VMM/shim PID mismatch')
        stat = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
        require(stat[0] not in ('Z', 'X', 'x'), 'Runtime process is not live')
        executable = (proc / 'exe').resolve(strict=True)
        require(executable.name == 'containerd-shim-cube-rs', 'Wrong runtime executable')
        args = (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
        require(args.count('-id') == 1 and args[args.index('-id') + 1] == sid,
                'Runtime command does not identify this sandbox')
        require('-namespace' in args and args[args.index('-namespace') + 1] == 'default',
                'Wrong runtime namespace')
        require(proc.joinpath('cwd').readlink() == bundle, 'Wrong runtime bundle')
        fds = [str(fd.readlink()) for fd in (proc / 'fd').iterdir()]
        require('anon_inode:kvm-vm' in fds and any(f.startswith('anon_inode:kvm-vcpu:') for f in fds),
                'Runtime does not own a live KVM VM and vCPU')
        cgroup = (proc / 'cgroup').read_text()
        require(any('/cube_sandbox/sandbox/' in line for line in cgroup.splitlines()), 'Wrong runtime cgroup')
        # Re-read after metadata collection to reject exit/PID reuse during the observation.
        final = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
        require(final[19] == stat[19] and final[0] not in ('Z', 'X', 'x'), 'Runtime changed during mapping')
        result[name] = {'sandbox_id': sid, 'pid': pid, 'start_ticks': int(stat[19]),
                        'boot_id': (proc_root / 'sys/kernel/random/boot_id').read_text().strip(),
                        'exe': str(executable), 'bundle': str(bundle), 'cmdline': args,
                        'cgroup': cgroup, 'kvm_fds': [f for f in fds if 'kvm' in f]}
    require(len({v['sandbox_id'] for v in result.values()}) == 3 and
            len({v['pid'] for v in result.values()}) == 3, 'Branches do not own three distinct runtimes')
    return result


def require_same_runtimes(before, after):
    for name in NAMES:
        for key in ('sandbox_id', 'pid', 'start_ticks', 'boot_id'):
            require(before[name][key] == after[name][key], f'Runtime identity changed: {name} {key}')


def execute(run):
    e = {"execution_scope": "vm", "metrics": {"snapshot_ms": None, "source_pause_ms": None,
         "fork_to_exec_ms": None, "host_rss_bytes": None}}
    parent = run.create("parent", os.environ["CUBE_TEMPLATE_ID"])
    guest = (ROOT.parent / "acceptance/guest.py").read_bytes()
    encoded = base64.b64encode(guest).decode()
    run.command("parent", "printf %s " + shlex.quote(encoded) + f" | base64 -d > {GUEST}")
    run.command("parent", f"nohup python3 {GUEST} serve --disk /var/tmp/clanker-acceptance-disk.json "
                ">/var/tmp/cube-sentinel.log 2>&1 </dev/null &")
    for _ in range(50):
        try:
            e["baseline"] = run.state("parent")
            break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError("Sentinel did not start; inspect guest log, do not reseed")
    run.command("parent", "mkdir /var/tmp/cube-network; nohup python3 -m http.server 18080 "
                "--bind 0.0.0.0 --directory /var/tmp/cube-network >/var/tmp/cube-http.log 2>&1 </dev/null &")
    start = time.monotonic()
    snapshot = run.snapshot(parent)
    e["metrics"]["snapshot_ms"] = (time.monotonic() - start) * 1000
    start = time.monotonic()
    # Creates are sequential; all three remain running throughout subsequent observations.
    # This avoids introducing cross-thread journaling solely to parallelize API requests.
    for name in NAMES[1:]:
        run.create(name, snapshot)
    e["inherited"] = {name: run.state(name) for name in NAMES}
    write(run.directory / "evidence.json", e)
    e["metrics"]["fork_to_exec_ms"] = (time.monotonic() - start) * 1000
    observe(run, e)


def observe(run, e):
    require('after' not in e and not (run.directory / 'observations-started').exists(),
            'Observation mutations already started; do not repeat them')
    e["infos_before"] = run.infos()
    e["host_before"] = inventory()
    e['runtimes_before'] = runtime_mapping(run.data['instances'])
    write(run.directory / "evidence.json", e)
    (run.directory / 'observations-started').open('x').close()
    e["after"] = mutate_and_observe(run)
    e["infos_after"] = run.infos()
    e["host_after"] = inventory()
    e['runtimes_after'] = runtime_mapping(run.data['instances'])
    require_same_runtimes(e['runtimes_before'], e['runtimes_after'])
    e["concurrently_running"] = True
    write(run.directory / "evidence.json", e)
    import requests
    e["network"] = {}
    for name in NAMES:
        sb = run.attach(name)
        r = requests.get("http://127.0.0.1:80/branch", headers={"Host": sb.get_host(18080)}, timeout=20)
        r.raise_for_status()
        require(r.text == name, f'Network endpoint isolation failed: {name}')
        e["network"][name] = {"host": sb.get_host(18080), "body": r.text,
                              "addresses": json.loads(run.command(name, "ip -j address"))}
    write(run.directory / "evidence.json", e)
    spec = importlib.util.spec_from_file_location("acceptance_evaluate", ROOT.parent / "acceptance/evaluate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.evaluate(e)
    result["checks"].extend([{"name": "independent_proxy_endpoints", "status": "pass"},
                             {"name": "timeout_minus_one_no_deadline", "status": "pass"}])
    result["limitations"].extend(["source_pause_ms is unmeasured; snapshot RPC duration includes other work",
        "No pre-resume egress quarantine proof; no real agent session proof; no host-reboot proof"])
    write(run.directory / "result.json", result)
    require(result["status"] == "pass", str(result["checks"]))


def mutate_and_observe(run):
    for name, delta in zip(NAMES, DELTAS):
        run.state(name, {"op": "mutate", "delta": delta, "label": name})
        run.command(name, "printf %s " + shlex.quote(name) + " > /var/tmp/cube-network/branch")
    # Deliberately collect every final read only after every mutation has finished.
    with ThreadPoolExecutor(max_workers=3) as pool:
        return dict(zip(NAMES, pool.map(run.state, NAMES)))


def restart(run, idle_seconds):
    before = {name: run.state(name) for name in NAMES}
    host_before = inventory()
    runtimes_before = runtime_mapping(run.data['instances'])
    # Restart controller services only, never Cubelet/shims/VMMs or the entire target.
    subprocess.run(["systemctl", "restart", "cube-sandbox-cubemaster", "cube-sandbox-cube-api",
                    "cube-sandbox-cubeops", "cube-sandbox-cube-lifecycle-manager"], check=True, timeout=120)
    # No guest access during this interval; print progress without refreshing TTL.
    deadline = time.monotonic() + idle_seconds
    while time.monotonic() < deadline:
        time.sleep(min(30, max(0, deadline - time.monotonic())))
        print("retention observation: no guest traffic", flush=True)
    infos = run.infos()
    after = {name: run.state(name) for name in NAMES}
    for name in NAMES:
        for key in ("marker_sha256", "pid", "counter", "ram_label", "disk"):
            require(before[name][key] == after[name][key], f'Restart continuity failed: {name} {key}')
    host_after = inventory()
    runtimes_after = runtime_mapping(run.data['instances'])
    require_same_runtimes(runtimes_before, runtimes_after)
    write(run.directory / "restart.json", {"schema_version": 1, "execution_scope": "vm", "status": "pass",
          "checks": [{"name": "controller_restart_live_vmm_and_sentinel", "status": "pass"},
                     {"name": "no_expiry_observation", "status": "pass"}],
          "metrics": {"idle_ms": idle_seconds * 1000}, "limitations": ["Finite observation; no host reboot"],
          "evidence": {"before": before, "after": after, "infos": infos,
                       "host_before": host_before, "host_after": host_after,
                       "runtimes_before": runtimes_before, "runtimes_after": runtimes_after}})


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["run", "observe", "restart", "workload", "cleanup", "template"])
    p.add_argument("directory", type=Path)
    p.add_argument("--idle-seconds", type=int, default=360)
    args = p.parse_args()
    isolated()
    Sandbox, Template, config = sdk()
    if args.action == "template":
        image = os.environ["CUBE_WORKLOAD_IMAGE"]
        if "@sha256:" not in image:
            raise ValueError("Workload image must be pinned by digest")
        args.directory.mkdir(parents=True, exist_ok=False)
        build = Template.build(image=image, name="clanker-cube-workload", cpu_count=1000, memory_mb=1024,
                               writable_layer_size="4G", exposed_ports=[49983, 18080], probe_port=49983,
                               probe_path="/health", allow_internet_access=False, config=config)
        write(args.directory / "build.json", vars(build))
        deadline = time.monotonic() + 1200
        while time.monotonic() < deadline:
            status = Template.get_build_status(build.template_id, build.build_id, config=config)
            write(args.directory / "status.json", vars(status))
            if status.status.lower() in ("ready", "success", "succeeded"):
                print(build.template_id)
                return
            if status.status.lower() in ("failed", "error"):
                raise RuntimeError(status.error_message or status.message)
            time.sleep(2)
        raise TimeoutError("Template build retained; inspect build.json, do not blindly submit again")
    run = Run(args.directory, Sandbox, config, create=args.action == "run")
    try:
        if args.action == "run":
            execute(run)
        elif args.action == 'observe':
            e = json.loads((run.directory / 'evidence.json').read_text())
            for name in NAMES:
                state = run.state(name)
                for key in ('marker_sha256', 'pid', 'counter', 'ram_label', 'disk'):
                    require(state[key] == e['inherited'][name][key], 'Branch changed before observation resume')
            observe(run, e)
        elif args.action == "restart":
            restart(run, args.idle_seconds)
        elif args.action == "workload":
            script = (ROOT / "workload.sh").read_text()
            logs = {name: run.command(name, script, timeout=300) for name in NAMES}
            write(run.directory / "workload.json", {"schema_version": 1, "execution_scope": "vm",
                  "status": "pass", "checks": [{"name": "guest_docker_and_c_build", "status": "pass"}],
                  "metrics": {}, "evidence": logs, "limitations": ["Synthetic build, not a real agent session"]})
        else:
            run.cleanup()
    except Exception as error:
        write(run.directory / (args.action + "-failure.json"), {"schema_version": 1, "execution_scope": "vm",
              "status": "fail", "checks": [{"name": args.action, "status": "fail", "detail": str(error)}],
              "metrics": {}, "limitations": ["Resources retained; inspect ledger before cleanup"]})
        raise


if __name__ == "__main__":
    main()
