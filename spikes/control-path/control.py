#!/usr/bin/env python3
"""Disposable control-path experiment. The fixture host is NOT a VM runtime."""
import argparse
import hashlib
import hmac
import json
import re
import sqlite3
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

IDENTIFIER = re.compile(r"[a-zA-Z0-9_-]{1,80}\Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def connect(path):
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA synchronous=FULL")
    return db


def validate(request):
    if not isinstance(request, dict) or set(request) != {"action", "machine"}:
        raise ValueError("expected action and machine only")
    if request["action"] not in ("create", "start", "stop", "delete"):
        raise ValueError("unsupported action")
    if not isinstance(request["machine"], str) or not IDENTIFIER.fullmatch(request["machine"]):
        raise ValueError("invalid machine ID")


def fixture_host(path, envelope):
    """A durable fake host used only to test control delivery, not VM behavior."""
    key, request = envelope["id"], envelope["request"]
    if not isinstance(key, str) or not IDENTIFIER.fullmatch(key):
        raise ValueError("invalid operation ID")
    validate(request)
    body = canonical(request)
    db = connect(path)
    try:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS ops(id TEXT PRIMARY KEY, body TEXT, result TEXT);
            CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY, power TEXT,
                disk_marker TEXT NOT NULL);
        """)
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT * FROM ops WHERE id=?", (key,)).fetchone()
        if prior:
            if prior["body"] != body:
                raise ValueError("operation ID reused with different request")
            return json.loads(prior["result"])
        machine, action = request["machine"], request["action"]
        current = db.execute("SELECT * FROM machines WHERE id=?", (machine,)).fetchone()
        if action == "create":
            if current:
                raise ValueError("machine already exists")
            db.execute("INSERT INTO machines VALUES (?, 'stopped', ?)",
                       (machine, hashlib.sha256(key.encode()).hexdigest()))
        elif action == "delete":
            db.execute("DELETE FROM machines WHERE id=?", (machine,))
        else:
            if not current:
                raise ValueError("machine missing; refusing fresh replacement")
            db.execute("UPDATE machines SET power=? WHERE id=?",
                       ("running" if action == "start" else "stopped", machine))
        current = db.execute("SELECT * FROM machines WHERE id=?", (machine,)).fetchone()
        result = {"scope": "fixture", "machine": dict(current) if current else None}
        db.execute("INSERT INTO ops VALUES (?, ?, ?)", (key, body, canonical(result)))
        db.commit()
        return result
    finally:
        db.close()


class Controller:
    def __init__(self, path, command):
        self.path, self.command = path, command
        self.lock = threading.Lock()
        with connect(path) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS operations(
                id TEXT PRIMARY KEY, body TEXT NOT NULL, result TEXT, error TEXT)""")

    def submit(self, key, request):
        if not isinstance(key, str) or not IDENTIFIER.fullmatch(key):
            raise ValueError("invalid Idempotency-Key")
        validate(request)
        body = canonical(request)
        db = connect(self.path)
        try:
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute("SELECT body FROM operations WHERE id=?", (key,)).fetchone()
            if prior and prior["body"] != body:
                raise ValueError("idempotency key reused with different request")
            db.execute("INSERT OR IGNORE INTO operations(id,body) VALUES (?,?)", (key, body))
            db.commit()  # Durable intent exists before any host command is issued.
        finally:
            db.close()
        return self.get(key)

    def get(self, key):
        with connect(self.path) as db:
            row = db.execute("SELECT * FROM operations WHERE id=?", (key,)).fetchone()
        if row is None:
            return None
        return {"id": key, "status": "complete" if row["result"] else "pending",
                "request": json.loads(row["body"]),
                "result": json.loads(row["result"]) if row["result"] else None,
                "last_error": row["error"]}

    def reconcile(self):
        # One dispatcher preserves intent order; this is a spike, not a scheduler.
        with self.lock:
            with connect(self.path) as db:
                rows = db.execute("SELECT id,body FROM operations WHERE result IS NULL ORDER BY rowid").fetchall()
            for row in rows:
                envelope = canonical({"id": row["id"], "request": json.loads(row["body"])})
                try:
                    completed = subprocess.run(self.command, input=envelope, text=True,
                                               capture_output=True, timeout=10, check=True)
                    result = json.loads(completed.stdout)
                    if not isinstance(result, dict) or result.get("scope") != "fixture":
                        raise ValueError("invalid fixture-host response")
                    with connect(self.path) as db:
                        db.execute("UPDATE operations SET result=?,error=NULL WHERE id=?",
                                   (canonical(result), row["id"]))
                except (OSError, ValueError, subprocess.SubprocessError) as exc:
                    with connect(self.path) as db:
                        db.execute("UPDATE operations SET error=? WHERE id=?",
                                   (type(exc).__name__, row["id"]))
                    break  # Do not execute later intent past an ambiguous result.


def handler(controller, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, value):
            payload = canonical(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self):
            self.connection.settimeout(3)
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(),
                                       ("Bearer " + token).encode()):
                self.reply(401, {"error": "unauthorized"})
                return False
            return True

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/operations":
                return self.reply(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("invalid body length")
                request = json.loads(self.rfile.read(length))
                result = controller.submit(self.headers.get("Idempotency-Key"), request)
            except (ValueError, TypeError):
                return self.reply(400, {"error": "invalid request or idempotency conflict"})
            self.reply(202, result)

        def do_GET(self):
            if not self.authorized():
                return
            if not self.path.startswith("/operations/"):
                return self.reply(404, {"error": "not found"})
            key = self.path.removeprefix("/operations/")
            result = controller.get(key) if IDENTIFIER.fullmatch(key) else None
            self.reply(200 if result else 404, result or {"error": "not found"})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    host = sub.add_parser("fixture-host")
    host.add_argument("--db", required=True)
    host.add_argument("--lose-reply-once", action="store_true")
    server = sub.add_parser("serve")
    server.add_argument("--db", required=True)
    server.add_argument("--token-file", required=True)
    server.add_argument("--port", type=int, default=0)
    server.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.mode == "fixture-host":
        envelope = json.loads(sys.stdin.read(8193))
        result = fixture_host(args.db, envelope)
        if args.lose_reply_once:
            with connect(args.db) as db:
                db.execute("CREATE TABLE IF NOT EXISTS lost_reply(id TEXT PRIMARY KEY)")
                inserted = db.execute("INSERT OR IGNORE INTO lost_reply VALUES (?)", (envelope["id"],)).rowcount
            if inserted:
                raise SystemExit(75)  # Host committed, but controller receives no result.
        print(canonical(result))
        return
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    token = Path(args.token_file).read_text().strip()
    if not command or len(token) < 24 or not token.isascii():
        parser.error("host command and ASCII token of at least 24 characters required")
    controller = Controller(args.db, command)
    stop = threading.Event()

    def dispatch():
        while not stop.is_set():
            controller.reconcile()
            stop.wait(0.25)

    thread = threading.Thread(target=dispatch, daemon=True)
    thread.start()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), handler(controller, token))
    print(canonical({"url": f"http://127.0.0.1:{httpd.server_port}", "scope": "fixture"}), flush=True)
    try:
        httpd.serve_forever()
    finally:
        stop.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
