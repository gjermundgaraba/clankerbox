#!/usr/bin/env python3
"""Network-boundary checks for the new agent run; no public network calls."""
import json
import socket
import threading
import unittest
from unittest.mock import patch
import agent_gate
import agent_proxy

class ProxyBoundary(unittest.TestCase):
    def exchange(self, payload):
        server=agent_proxy.Server(('127.0.0.1',0),agent_proxy.Connect)
        server.counts={}; server.active=set(); server.lock=threading.Lock()
        thread=threading.Thread(target=server.serve_forever); thread.start()
        try:
            with socket.create_connection(server.server_address) as client:
                client.sendall(payload); return client.recv(1024)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_raw_http_denied(self):
        with patch.object(agent_proxy.socket,'getaddrinfo',side_effect=AssertionError('must not resolve')):
            # Socket object avoids create_connection, which itself needs getaddrinfo.
            self.assertNotIn('example.com',agent_proxy.ALLOWED)
        self.assertIn(b'403',self.exchange(b'GET http://chatgpt.com/ HTTP/1.1\r\n\r\n'))

    def test_unlisted_and_non443_denied(self):
        for target in (b'example.com:443',b'chatgpt.com:80',b'127.0.0.1:443'):
            self.assertIn(b'403',self.exchange(b'CONNECT '+target+b' HTTP/1.1\r\n\r\n'))

    def test_private_dns_denied(self):
        real=socket.getaddrinfo
        def resolution(host,*args,**kwargs):
            if host=='chatgpt.com': return [(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]
            return real(host,*args,**kwargs)
        with patch.object(agent_proxy.socket,'getaddrinfo',side_effect=resolution):
            self.assertIn(b'403',self.exchange(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'))

    def test_release_scoped_port_and_default_drop(self):
        commands=[]
        def run(*args):
            commands.append(args)
            if args[0]=='ip': return json.dumps([dict(ifindex=1,master='cqagp')])
            return ''
        record=dict(bridge='cqagp',endpoint='172.30.226.1',vm_id='test',nonce='once',dev='owned-veth',ifindex=1)
        with patch.object(agent_gate.gate,'run',run),patch.object(agent_gate.gate,'verify_block'):
            agent_gate.release(record,dict(vm_id='test',nonce='once',prepared=True))
        self.assertEqual(sum('8443' in c for c in commands),2)
        self.assertEqual(sum('100' in c and 'drop' in c for c in commands),2)
        self.assertEqual([c[5] for c in commands[-2:]],['egress','ingress'])

    def test_stale_proof_leaves_gate_untouched(self):
        with patch.object(agent_gate.gate,'run',side_effect=AssertionError('must not mutate')):
            with self.assertRaises(ValueError):
                agent_gate.release(dict(bridge='cqagp',endpoint='172.30.226.1',vm_id='test',nonce='once'),
                                   dict(vm_id='test',nonce='stale',prepared=True))

if __name__=='__main__': unittest.main()
