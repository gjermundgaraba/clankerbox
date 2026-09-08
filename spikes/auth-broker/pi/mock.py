import json, pathlib, time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = pathlib.Path('/home/authprobe/probe')
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def record(self, value):
        with (ROOT / 'requests.jsonl').open('a') as f: f.write(json.dumps(value) + '\n')
    def do_GET(self):
        mode = (ROOT / 'mode').read_text().strip()
        self.record({'path': self.path, 'mode': mode})
        self.send_response(403 if mode == 'resolve-fail' else 200)
        self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'key': 'dummy-broker-access-v1'}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        mode = (ROOT / 'mode').read_text().strip()
        self.record({'path': self.path, 'mode': mode, 'authorization': self.headers.get('Authorization'),
                     'stream': body.get('stream'), 'model': body.get('model')})
        if mode == 'upstream-fail':
            self.send_response(401); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"error":{"message":"mock credential revoked","type":"authentication_error"}}'); return
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for delta, finish in [({'role':'assistant'}, None), ({'content':'BROKER_'}, None), ({'content':'STREAM_OK'}, None), ({}, 'stop')]:
            event = {'id':'mock-1', 'object':'chat.completion.chunk', 'created':1, 'model':'mock',
                     'choices':[{'index':0, 'delta':delta, 'finish_reason':finish}]}
            self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode()); self.wfile.flush(); time.sleep(.05)
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
HTTPServer(('127.0.0.1',18091),Handler).serve_forever()
