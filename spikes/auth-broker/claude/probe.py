#!/usr/bin/env python3
"""Run as root in a disposable Linux VM with the pinned CLI installed.

Run via unshare --net; creates only dummy credentials and
records request metadata without credential values or request content.
"""
import http.server
import json
import os
import subprocess
import threading

VERSION = "2.1.263"
CLI = "/home/authprobe/cli/node_modules/.bin/claude"
records = []
mode = "success"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        raw = self.rfile.read(int(self.headers.get("content-length", "0")))
        body = json.loads(raw) if raw else {}
        headers = dict(self.headers)
        for key in headers:
            if key.lower() in {"authorization", "x-api-key", "cookie"}:
                headers[key] = "Bearer <redacted>" if headers[key].startswith("Bearer ") else "<redacted>"
        records.append({"method": self.command, "path": self.path, "headers": headers,
                        "model": body.get("model"), "stream": body.get("stream")})
        if mode == "unauthorized":
            data = json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "Controlled dummy-token rejection"}}).encode()
            self.send_response(401)
            self.send_header("content-type", "application/json")
        elif "messages" in self.path and "count_tokens" not in self.path:
            msg = {"id": "msg_mock", "type": "message", "role": "assistant", "model": body.get("model"), "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}
            events = [("message_start", {"message": msg}), ("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}), ("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "MOCK_OK"}}), ("content_block_stop", {"index": 0}), ("message_delta", {"delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}), ("message_stop", {})]
            data = "".join("event: " + name + "\ndata: " + json.dumps({"type": name, **payload}) + "\n\n" for name, payload in events).encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
        else:
            data = b'{"input_tokens":1}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


assert os.readlink("/proc/self/ns/net") != os.readlink("/proc/1/ns/net"), "Must run inside isolated network namespace"
subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
os.chdir("/home/authprobe")
server = http.server.ThreadingHTTPServer(("127.0.0.1", 18765), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = ["ANTHROPIC_BASE_URL=http://127.0.0.1:18765", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1", "API_TIMEOUT_MS=5000", "CLAUDE_CODE_MAX_RETRIES=0"]
result = {"version": subprocess.check_output([CLI, "--version"], text=True).strip(), "tests": []}
tests = [("api", ["ANTHROPIC_API_KEY=dummy-api-placeholder"]), ("oauth", ["CLAUDE_CODE_OAUTH_TOKEN=dummy-oauth-placeholder"]), ("oauth_with_refresh", ["CLAUDE_CODE_OAUTH_TOKEN=dummy-oauth-placeholder", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN=dummy-refresh-placeholder", "CLAUDE_CODE_OAUTH_SCOPES=user:profile user:inference user:sessions:claude_code"]), ("both", ["ANTHROPIC_API_KEY=dummy-api-placeholder", "CLAUDE_CODE_OAUTH_TOKEN=dummy-oauth-placeholder"]), ("bearer", ["ANTHROPIC_AUTH_TOKEN=dummy-bearer-placeholder"])]
for mode in ["success", "unauthorized"]:
    for name, credentials in tests:
        records.clear()
        command = ["timeout", "--signal=KILL", "15", "runuser", "-u", "authprobe", "--", "env", *base, *credentials, CLI]
        status = subprocess.run([*command, "auth", "status", "--json"], capture_output=True, text=True, timeout=20)
        try:
            proc = subprocess.run([*command, "-p", "Reply with MOCK_OK", "--model", "claude-sonnet-4-6", "--tools", "", "--max-turns", "1", "--output-format", "json"], capture_output=True, text=True, timeout=40)
            output = {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
        except subprocess.TimeoutExpired:
            output = {"timeout": 40}
        result["tests"].append({"name": name, "mode": mode, "auth_status": status.stdout, "requests": list(records), **output})
server.shutdown()
print(json.dumps(result, indent=2))
