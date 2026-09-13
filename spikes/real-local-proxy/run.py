#!/usr/bin/env python3
"""Run isolated Caddy qualification on the actual edge LXC, never live ingress."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
STAMP = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
NAME = "cb-proxy-" + STAMP.lower()
REMOTE = "/tmp/" + NAME
EVIDENCE = ROOT / ".work/real-local-proxy" / STAMP
EVIDENCE.mkdir(parents=True, mode=0o700)
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "root@192.168.99.2"]


def host(*args, check=True):
    return subprocess.run(SSH + [shlex.join(args)], check=check, capture_output=True, text=True)


def ct(*args, check=True):
    return host("pct", "exec", "101", "--", *args, check=check)


def stage(source, name):
    target = REMOTE + "/" + name
    subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", str(source), "root@192.168.99.2:" + target], check=True)
    host("pct", "push", "101", target, target)


def read_remote(name):
    return ct("cat", REMOTE + "/state/" + name).stdout


def launch(suffix, *args):
    ct("systemd-run", "--unit=" + NAME + "-" + suffix, "--property=User=caddy", "--property=Group=caddy", "--property=RuntimeMaxSec=600", "--property=UMask=0077", *args)


def main():
    tunnel = None
    host_owned = False
    ct_owned = False
    started = []
    before = ct("sha256sum", "/etc/caddy/Caddyfile").stdout
    autosave_before = ct("sha256sum", "/var/lib/caddy/.config/caddy/autosave.json").stdout
    production = ct("systemctl", "show", "caddy", "-p", "MainPID", "-p", "ActiveState").stdout
    result = {"topology": "Node on operator -> loopback TCP / strict SSH stdio / pct exec -> TLS Caddy on edge LXC101 loopback -> h2c Go gate on same LXC loopback", "production_config_before": before, "production_service_before": production, "caddy_version": ct("/usr/local/bin/caddy", "version").stdout.strip(), "caddy_sha256": ct("sha256sum", "/usr/local/bin/caddy").stdout.strip(), "remote_owned_directory": REMOTE}
    result["production_autosave_before"] = autosave_before
    try:
        host("mkdir", "-m", "700", REMOTE)
        host_owned = True
        ct("mkdir", "-m", "700", REMOTE)
        ct_owned = True
        binary = ROOT / ".work/real-local-proxy/gate-server-linux-amd64"
        subprocess.run(["go", "build", "-o", str(binary), "./cmd/gate-server"], cwd=ROOT / "spikes/real-local-rpc", env={**os.environ, "GOOS": "linux", "GOARCH": "amd64"}, check=True)
        result["gate_binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        stage(binary, "gate-server")
        stage(ROOT / "spikes/real-local-proxy/tunnel.py", "tunnel.py")
        config = EVIDENCE / "Caddyfile"
        config.write_text("{\n admin off\n auto_https off\n persist_config off\n storage file_system {\n  root " + REMOTE + "/storage\n }\n}\nhttps://127.0.0.1:18443 {\n bind 127.0.0.1\n tls " + REMOTE + "/state/cert.pem " + REMOTE + "/state/key.pem\n reverse_proxy h2c://127.0.0.1:18080\n}\n")
        stage(config, "Caddyfile")
        ct("chmod", "755", REMOTE + "/gate-server")
        ct("chown", "-R", "caddy:caddy", REMOTE)
        launch("go", REMOTE + "/gate-server", "-state-dir", REMOTE + "/state", "-h2c-address", "127.0.0.1:18080")
        started.append("go")
        for _ in range(20):
            ready = ct("test", "-f", REMOTE + "/state/endpoints.json", check=False)
            if ready.returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("gate server did not become ready")
        ca = EVIDENCE / "ca.pem"
        ca.write_text(read_remote("ca.pem"))
        launch("caddy", "/usr/local/bin/caddy", "run", "--config", REMOTE + "/Caddyfile", "--adapter", "caddyfile")
        started.append("caddy")
        # Caddy is a separate process with no admin socket, ACME, trust install,
        # service reload, production environment file or production certificate.
        for _ in range(20):
            ready = ct("python3", "-c", "import socket; socket.create_connection(('127.0.0.1',18443),1).close()", check=False)
            if ready.returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("isolated Caddy did not become ready")
        remote_command = shlex.join(["pct", "exec", "101", "--", "python3", REMOTE + "/tunnel.py", "remote", "18443"])
        tunnel = subprocess.Popen([sys.executable, str(ROOT / "spikes/real-local-proxy/tunnel.py"), "local", "0", *SSH, remote_command], stdout=subprocess.PIPE, text=True)
        address = tunnel.stdout.readline().strip().split()[-1]
        result["tls_origin"] = "https://" + address
        (EVIDENCE / "proxy.json").write_text(json.dumps({"origin": result["tls_origin"], "ca": str(ca)}))
        print("Proxy ready: " + str(EVIDENCE / "proxy.json"), flush=True)
        # Supply an explicit Node probe command after --; env carries only test paths.
        command = sys.argv[1:]
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            raise RuntimeError("pass Node probe command after --")
        result["probe_command"] = command
        result["probe_executable_version"] = subprocess.run([command[0], "--version"], capture_output=True, text=True, check=True).stdout.strip()
        result["node_probe_sha256"] = hashlib.sha256((ROOT / "spikes/real-local-rpc/node/probe.ts").read_bytes()).hexdigest()
        probe = subprocess.run(command, cwd=ROOT / "spikes/real-local-rpc", env={**os.environ, "GATE_REMOTE_ORIGIN": result["tls_origin"], "GATE_REMOTE_CA": str(ca)}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
        (EVIDENCE / "probe.log").write_text(probe.stdout)
        print(probe.stdout, end="", flush=True)
        result["probe_exit_code"] = probe.returncode
        if probe.returncode:
            raise RuntimeError("Node qualification failed")
    finally:
        if tunnel:
            tunnel.terminate()
            tunnel.wait(timeout=10)
        for suffix in reversed(started):
            ct("systemctl", "stop", NAME + "-" + suffix, check=False)
            log = ct("journalctl", "-u", NAME + "-" + suffix, "--no-pager", check=False)
            (EVIDENCE / (suffix + ".log")).write_text(log.stdout)
        result["production_config_after"] = ct("sha256sum", "/etc/caddy/Caddyfile").stdout
        result["production_autosave_after"] = ct("sha256sum", "/var/lib/caddy/.config/caddy/autosave.json").stdout
        result["production_service_after"] = ct("systemctl", "show", "caddy", "-p", "MainPID", "-p", "ActiveState").stdout
        result["production_unchanged"] = result["production_config_after"] == before and result["production_service_after"] == production and result["production_autosave_after"] == autosave_before
        result["listeners_after"] = ct("ss", "-ltn").stdout
        # Exact invocation-owned paths only, after the exact owned units stop.
        cleanup = "import shutil; shutil.rmtree(" + repr(REMOTE) + ", ignore_errors=True)"
        if ct_owned:
            ct("python3", "-c", cleanup)
        if host_owned:
            host("python3", "-c", cleanup)
        result["cleanup_complete"] = ct("test", "!", "-e", REMOTE, check=False).returncode == 0 and host("test", "!", "-e", REMOTE, check=False).returncode == 0
        (EVIDENCE / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print("Evidence: " + str(EVIDENCE), flush=True)


if __name__ == "__main__":
    main()
