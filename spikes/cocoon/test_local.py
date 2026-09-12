#!/usr/bin/env python3
"""Local contract/source tests. Never executes tc, ip, a VMM or systemctl."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE.parent / 'acceptance'))
from guest import call
import gate
import guest_prepare
import render


class Checks(unittest.TestCase):
    def test_quarantine_order_and_fail_closed(self):
        with tempfile.TemporaryDirectory(dir=BASE / '.work') as temp:
            base = Path(temp)
            rendered = render.render(base)
            self.assertEqual(rendered['net_scope'], 'q7')
            self.assertEqual(rendered['cgroup_parent'], 'cqq7.slice')
            c = json.loads((base / 'cni-conf/child-a.conflist').read_text())
            self.assertFalse(c['plugins'][0]['ipMasq'])
            self.assertFalse(c['plugins'][0]['isGateway'])
            self.assertEqual([p['type'] for p in c['plugins']], ['bridge', 'clanker-gate'])
            config = dict(c['plugins'][-1], cniVersion='1.0.0', prevResult={
                'cniVersion': '1.0.0', 'interfaces': [dict(name='cqq7a'), dict(name='veth123'),
                                                    dict(name='eth0', sandbox='/var/run/netns/q7-one')]})
            def execute(*args):
                commands.append(args)
                if args[0] == 'nsenter':
                    return json.dumps([dict(link_index=8)])
                if args[0] == 'ip':
                    return json.dumps([dict(ifindex=8, ifname='veth123', master='cqq7a',
                                            linkinfo=dict(info_kind='veth'))])
                if failure and args[0] == 'tc' and 'egress' in args:
                    raise RuntimeError('injected tc failure')
                if args[0] == 'tc' and 'show' in args:
                    return json.dumps([dict(pref=1, protocol='all', kind='matchall', options=dict(
                        actions=[dict(kind='gact', control_action=dict(type='drop'))]))])
                return ''
            env = dict(CNI_CONTAINERID='one', CNI_IFNAME='eth0', CNI_NETNS='/var/run/netns/q7-one')
            with patch.dict(os.environ, env):
                failure = True; commands = []
                with self.assertRaises(RuntimeError):
                    gate.cni(config, 'ADD', execute)
                self.assertFalse(list((base / 'gates').glob('*.json')))
                failure = False; commands = []
                self.assertEqual(gate.cni(config, 'ADD', execute), config['prevResult'])
                record = json.loads(next((base / 'gates').glob('*.json')).read_text())
                self.assertEqual(record['state'], 'quarantined')
                drops = [c for c in commands if c[0] == 'tc' and 'drop' in c]
                self.assertEqual(len(drops), 2)
                self.assertTrue(all('all' in c for c in drops))
                proof = dict(prepared=True, vm_id='one', gate_nonce=record['nonce'], session='new',
                             inherited_session='old', machine_id='a'*32, pid=9, inherited_pid=9,
                             marker_sha256='b'*64, inherited_marker_sha256='b'*64)
                for key, bad in [('prepared', False), ('gate_nonce', 'stale'), ('session', 'old'), ('pid', 10)]:
                    commands = []
                    with self.assertRaises(ValueError):
                        gate.release(record, dict(proof, **{key: bad}), execute)
                    self.assertEqual(commands, [])
                commands = []
                gate.release(record, proof, execute)
                self.assertIn('egress', commands[-2]); self.assertIn('ingress', commands[-1])
                self.assertTrue(all('del' in c for c in commands[-2:]))
                self.assertEqual(sum('8080' in c for c in commands), 2)
                self.assertEqual(sum('drop' in c for c in commands), 2)
                commands = []; failure = True
                with self.assertRaises(RuntimeError):
                    gate.release(record, proof, execute)
                self.assertFalse(any('del' in c for c in commands))

    def test_real_process_preparation(self):
        with tempfile.TemporaryDirectory(dir=BASE / '.work') as temp:
            root = Path(temp)
            for path in ('etc/ssh', 'sys/class/net/eth0', 'var/tmp'):
                (root / path).mkdir(parents=True)
            sock = root / 's'; disk = root / 'disk.json'
            process = subprocess.Popen([sys.executable, str(BASE.parent / 'acceptance/guest.py'),
                                        'serve', '--socket', str(sock), '--disk', str(disk)], stdout=subprocess.PIPE)
            try:
                self.assertTrue(json.loads(process.stdout.readline())['ready'])
                def rpc(_, request):
                    return call(sock, request)
                before = rpc(None, {'op': 'status'})
                def fail(args):
                    raise RuntimeError('injected identity hook failure')
                with self.assertRaises(RuntimeError):
                    guest_prepare.prepare('one', 'nonce', '172.30.217.2/24', '172.30.217.1',
                                          '02:00:00:00:00:01', root, fail, rpc)
                self.assertFalse((root / 'var/tmp/clanker-identity.json').exists())
                commands = []
                def guest_command(args):
                    commands.append(args)
                    if args == ['ssh-keygen', '-A']:
                        (root / 'etc/ssh/ssh_host_ed25519_key.pub').write_text('synthetic-public-key')
                proof = guest_prepare.prepare('one', 'nonce', '172.30.217.2/24', '172.30.217.1',
                                              '02:00:00:00:00:01', root, guest_command, rpc)
                after = rpc(None, {'op': 'status'})
                self.assertEqual(before['pid'], after['pid'])
                self.assertEqual(before['marker_sha256'], after['marker_sha256'])
                self.assertEqual(before['counter'], after['counter'])
                self.assertNotEqual(before['session'], after['session'])
                self.assertTrue(proof['prepared'])
                self.assertIn(['ssh-keygen', '-A'], commands)
            finally:
                process.terminate(); process.wait(timeout=5); process.stdout.close()

    def test_pinned_source_order(self):
        source = BASE / '.work/cocoon'
        self.assertEqual(subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
                         json.loads((BASE / 'pins.json').read_text())['cocoon_commit'])
        code = (source / 'cmd/vm/run.go').read_text().split('func (h Handler) cloneFromSrcDir', 1)[1]
        self.assertLess(code.index('h.prepareClone('), code.index('dcr.DirectClone('))
        self.assertLess(code.index('dcr.DirectClone('), code.index('h.reseedAfterResume('))
        code = (source / 'network/cni/lifecycle.go').read_text().split('func (c *CNI) provisionNIC', 1)[1]
        self.assertLess(code.index('AddNetworkList('), code.index('setupTCRedirectFn('))
        code = (source / 'hypervisor/firecracker/clone.go').read_text().split('func (fc *Firecracker) startCloneVM', 1)[1]
        self.assertLess(code.index('fc.loadCloneSnapshot('), code.index('fc.resumeAndReanchorClone('))


    def test_optimized_security_checks(self):
        code = '''
from pathlib import Path
import gate, render
checks = [lambda: gate.validate_base(Path('/tmp/unowned')),
          lambda: render.render(Path('/tmp/unowned')),
          lambda: gate.release({'vm_id':'one'}, {'prepared':False}, lambda *a: None)]
for check in checks:
    try:
        check()
    except ValueError:
        continue
    raise RuntimeError('optimized Python bypassed a safety check')
'''
        subprocess.run([sys.executable, '-O', '-c', code], cwd=BASE, check=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
