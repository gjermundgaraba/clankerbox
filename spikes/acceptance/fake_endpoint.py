#!/usr/bin/env python3
"""Local synthetic session endpoint: POST {session, owner}, GET / for claims."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, self.server.claims)

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError("body must be 1–4096 bytes")
            data = json.loads(self.rfile.read(size))
            session, owner = data["session"], data["owner"]
            if not all(isinstance(v, str) and 0 < len(v) <= 128 for v in (session, owner)):
                raise ValueError("session and owner must be 1–128 character strings")
        except (ValueError, KeyError, TypeError) as error:
            self.reply(400, {"error": str(error)})
            return
        previous = self.server.claims.get(session)
        if previous is not None and previous != owner:
            self.reply(409, {"error": "duplicate-session", "existing_owner": previous})
            return
        self.server.claims[session] = owner
        self.reply(200, {"ok": True, "owner": owner})


def make_server(port=0):
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.claims = {}
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    with make_server(args.port) as server:
        print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}"}), flush=True)
        server.serve_forever()
