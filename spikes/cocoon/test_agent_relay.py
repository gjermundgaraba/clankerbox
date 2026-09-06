#!/usr/bin/env python3
"""Local real-socket proof that reset preserves the relay and drops old tunnels."""
import json
import os
from pathlib import Path
import socket
import socketserver
import sys
import tempfile
import threading
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'real-agent'))
import relay

class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data=self.request.recv(1024)
            if not data:return
            self.request.sendall(data)

class ResetTest(unittest.TestCase):
    def exercise(self,unix):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); config=root/'address';config.write_text('127.0.0.1\n')
            upstream=relay.Unix(str(root/'upstream.sock'),Echo) if unix else relay.TCP(('127.0.0.1',0),Echo)
            registry=relay.Registry(config,0 if unix else upstream.server_address[1],str(root/'upstream.sock') if unix else None)
            server=relay.TCP(('127.0.0.1',0),relay.Relay);server.registry=registry
            manager=relay.Unix(str(root/'control.sock'),relay.Control);manager.registry=registry
            services=[upstream,server,manager]
            threads=[threading.Thread(target=s.serve_forever) for s in services]
            for t in threads:t.start()
            try:
                before=relay.control(str(root/'control.sock'),'status')
                with socket.create_connection(server.server_address) as client:
                    client.settimeout(2);client.sendall(b'fixture');self.assertEqual(client.recv(7),b'fixture')
                    reset=relay.control(str(root/'control.sock'),'reset')
                    self.assertTrue(reset['ok']);self.assertEqual(reset['pid'],before['pid'])
                    self.assertEqual(reset['pid'],os.getpid());self.assertEqual(reset['oldTunnels'],1)
                    self.assertEqual(reset['oldTunnelsRemaining'],0);self.assertEqual(reset['generation'],1)
                    self.assertEqual(client.recv(1),b'')
                with socket.create_connection(server.server_address) as client:
                    client.settimeout(2);client.sendall(b'fresh');self.assertEqual(client.recv(5),b'fresh')
                self.assertEqual(relay.control(str(root/'control.sock'),'status')['pid'],before['pid'])
            finally:
                registry.reset()
                for s in services:s.shutdown();s.server_close()
                for t in threads:t.join()

    def test_tcp_reset_without_restart(self):self.exercise(False)
    def test_unix_reset_without_restart(self):self.exercise(True)

if __name__=='__main__':unittest.main()
