#!/usr/bin/env python3
"""Exercise the actual generated wrapper and native macOS Claude with fake auth.

No provider access: sandbox-exec permits only loopback network, blocks the user's
Claude state and keychain, and the CLI receives a fresh temporary HOME/config.
"""
import http.server
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[3]
CLI = shutil.which("claude")
assert CLI and shutil.which("sandbox-exec"), "Requires macOS, sandbox-exec and Claude Code"
source = (ROOT / "internal/host/auth.go").read_text()
wrapper = source.split("func claudeAuthWrapper() string {\n\treturn `", 1)[1].split("`\n}", 1)[0]
records = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        tool_ok = any(block.get("type") == "tool_result" and "CLANKERBOX_TOOL_OK" in str(block.get("content"))
                      for msg in body.get("messages", []) for block in msg.get("content", []) if isinstance(block, dict))
        records.append({"method": "POST", "path": self.path, "oauth_placeholder": self.headers.get("Authorization") == "Bearer clankerbox-controller-managed",
                        "api_key_present": bool(self.headers.get("x-api-key")), "beta": self.headers.get("anthropic-beta"),
                        "tool_result_received": tool_ok})
        if "count_tokens" in self.path:
            data = b'{"input_tokens":1}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
        else:
            msg = {"id": "msg_mock", "type": "message", "role": "assistant", "model": body.get("model"), "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}
            content = {"type": "text", "text": ""} if tool_ok else {"type": "tool_use", "id": "tool_mock", "name": "Bash", "input": {}}
            delta = {"type": "text_delta", "text": "MOCK_TOOL_ROUNDTRIP_OK"} if tool_ok else {"type": "input_json_delta", "partial_json": json.dumps({"command": "printf CLANKERBOX_TOOL_OK", "description": "Emit test fixture marker"})}
            events = [("message_start", {"message": msg}), ("content_block_start", {"index": 0, "content_block": content}), ("content_block_delta", {"index": 0, "delta": delta}), ("content_block_stop", {"index": 0}), ("message_delta", {"delta": {"stop_reason": "end_turn" if tool_ok else "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}), ("message_stop", {})]
            data = "".join("event: " + name + "\ndata: " + json.dumps({"type": name, **payload}) + "\n\n" for name, payload in events).encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 18443), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix="clankerbox-claude-wrapper-") as directory:
    root = Path(directory)
    (root / "bin").mkdir()
    (root / "bin/claude").symlink_to(CLI)
    launcher = root / "bin/clankerbox-claude"
    launcher.write_text(wrapper)
    launcher.chmod(0o700)
    config = root / "config"
    config.mkdir()
    # Deliberately conflicting ordinary settings must not switch away from OAuth.
    (config / "settings.json").write_text(json.dumps({"apiKeyHelper": "touch " + shlex.quote(str(root / "helper-was-called")) + "; printf fake-conflicting-helper", "env": {"ANTHROPIC_API_KEY": "fake-conflicting-key", "CLAUDE_CODE_USE_VERTEX": "1"}}))
    user_root = Path.home()
    blocked = [user_root / ".claude", user_root / ".claude.json", user_root / "Library/Keychains"]
    policy = '(version 1)(allow default)(deny network*)(allow network* (remote ip "localhost:*"))'
    policy += ''.join('(deny file-read* (subpath ' + json.dumps(str(path)) + '))' for path in blocked)
    env = {"HOME": directory, "CLAUDE_CONFIG_DIR": str(config), "PATH": str(root / "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": directory,
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_MAX_RETRIES": "0", "API_TIMEOUT_MS": "5000",
           "ANTHROPIC_API_KEY": "fake-inherited-conflict", "CLAUDE_CODE_USE_BEDROCK": "1"}
    version = subprocess.check_output([CLI, "--version"], env=env, text=True).strip()
    proc = subprocess.run(["sandbox-exec", "-p", policy, str(launcher), "-p", "Run the supplied Bash tool and return its marker", "--model", "claude-sonnet-4-6", "--tools", "Bash", "--allowedTools", "Bash", "--max-turns", "3", "--output-format", "json"], cwd=directory, env=env, capture_output=True, text=True, timeout=45)
    result = {"version": version, "exit": proc.returncode, "requests": records, "stdout": proc.stdout, "stderr": proc.stderr,
              "real_credentials_used": False, "configured_api_key_helper_called": (root / "helper-was-called").exists(), "network": "sandbox-exec loopback only", "conflicting_user_settings_unchanged": json.loads((config / "settings.json").read_text())["env"]["ANTHROPIC_API_KEY"] == "fake-conflicting-key"}
server.shutdown()
print(json.dumps(result, indent=2))
assert proc.returncode == 0 and "MOCK_TOOL_ROUNDTRIP_OK" in proc.stdout
assert not result["configured_api_key_helper_called"]
assert any(item["tool_result_received"] for item in records)
assert all(item["oauth_placeholder"] and not item["api_key_present"] for item in records)
