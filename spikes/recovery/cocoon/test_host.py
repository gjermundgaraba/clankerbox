#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch

sys.path.insert(0,str(Path(__file__).parent))
import host


class HostTests(unittest.TestCase):
    def adapter(self):
        value=host.Recovery.__new__(host.Recovery)
        value.names={'source':Path('/private/s')}; value.event=Mock(); value.mounts=[]
        return value

    def test_native_empty_inventory_and_unknown_format(self):
        self.assertEqual(host.list_rows('[]\n','vm'),[])
        self.assertEqual(host.list_rows('No VMs found.\n','vm'),[])
        self.assertEqual(host.list_rows('No snapshots found.\n','snapshot'),[])
        for malformed in ('{}','null','[1]','No unexplained failure'):
            with self.subTest(value=malformed),self.assertRaises((RuntimeError,json.JSONDecodeError)):
                host.list_rows(malformed,'vm')

    def test_integrity_failure_is_fatal_even_with_nonzero_guest_exit(self):
        adapter=self.adapter()
        for code in (0,1):
            reply=dict(ok=False,ready=True,memory_ok=False,disk_ok=True)
            adapter.cc=Mock(return_value=subprocess.CompletedProcess([],code,json.dumps(reply),'integrity failure'))
            with self.assertRaises(host.IntegrityError): adapter.wait(lambda:adapter.ram('source'))
            self.assertEqual(adapter.cc.call_count,1)
            self.assertEqual(adapter.event.call_args.kwargs['reply'],reply)

    def test_not_ready_retries_then_returns_ready(self):
        adapter=self.adapter()
        responses=[dict(ok=False,ready=False),dict(ok=True,ready=True,memory_ok=True,disk_ok=True)]
        adapter.cc=Mock(side_effect=[subprocess.CompletedProcess([],0,json.dumps(reply),'') for reply in responses])
        with patch.object(host.time,'sleep'):
            self.assertTrue(adapter.wait(lambda:adapter.ram('source'))['ready'])
        self.assertEqual(adapter.cc.call_count,2)

    def test_sigterm_enters_finally_cleanup_and_preserves_failure(self):
        adapter=self.adapter(); adapter.args=argparse.Namespace(prepare=False,case='process')
        adapter.result={}; adapter.group_inode=123
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); (root/'prepared.json').write_text(json.dumps(dict(guest_sha256='g',probe_sha256='p',runtime_pins={})))
            adapter.auth={'allocated_disk_limit_bytes':1000}; adapter.start_group=Mock()
            adapter.process_case=lambda:host.terminate(signal.SIGTERM,None)
            adapter.lineage_case=adapter.native_case=adapter.corruption_case=Mock()
            adapter.cleanup=Mock(); adapter.close_group=Mock(); adapter.save=Mock(); adapter.out=root
            with patch.object(host,'ROOT',root),patch.object(host,'networks',return_value={}),patch.object(host.subprocess,'check_output',return_value='0 root'):
                with self.assertRaises(KeyboardInterrupt): adapter.execute()
            adapter.cleanup.assert_called_once(); adapter.close_group.assert_called_once()
            self.assertEqual(adapter.result['status'],'fail')

    def test_configuration_has_native_valid_scope_and_no_nic_plugin(self):
        adapter=self.adapter(); adapter.group=Path('/sys/fs/cgroup/cqrec20260906.slice')
        with tempfile.TemporaryDirectory() as temp:
            adapter.source=Path(temp); adapter.config(adapter.source)
            config=json.loads((adapter.source/'config.json').read_text())
            self.assertEqual(len(config['net_scope']),2)
            self.assertEqual(config['cni_conf_dir'],config['cni_bin_dir'])
            self.assertEqual(list((adapter.source/'empty-cni').iterdir()),[])

    def test_namespace_gate_host_namespace_and_shared_propagation_rejected(self):
        granted={'execution_authorized_runtime':'cocoon','mount_namespace_authorized':True}
        with self.assertRaisesRegex(RuntimeError,'grant closed'): host.namespace_proof({})
        with patch.object(host.os,'readlink',return_value='mnt:[1]'):
            with self.assertRaisesRegex(RuntimeError,'host mount namespace'): host.namespace_proof(granted)
        for info in ('1 0 0:1 / / rw shared:1 - ext4 /dev/x rw\n','1 0 0:1 / / rw master:1 - ext4 /dev/x rw\n'):
            with patch.object(host.os,'readlink',side_effect=['mnt:[2]','mnt:[1]']),patch.object(Path,'read_text',return_value=info):
                with self.assertRaisesRegex(RuntimeError,'propagation'): host.namespace_proof(granted)
        with patch.object(host.os,'readlink',side_effect=['mnt:[2]','mnt:[1]']),patch.object(Path,'read_text',return_value='1 0 0:1 / / rw - ext4 /dev/x rw\n'):
            self.assertEqual(host.namespace_proof(granted)['namespace'],'mnt:[2]')

    def test_unmount_refuses_survivors_and_never_uses_lazy_force(self):
        adapter=self.adapter(); adapter.mounts=[Path('/private/s'),Path('/private/artifacts')]; adapter.auth={}; adapter.result={}
        with patch.object(host,'inventory',return_value=[{'pid':1}]),patch.object(host.subprocess,'run') as command:
            with self.assertRaisesRegex(RuntimeError,'owned VMM'): adapter.unmount_owned()
            command.assert_not_called()
        with patch.object(host,'inventory',return_value=[]),patch.object(host,'namespace_proof',return_value={}),patch.object(host.subprocess,'run') as command:
            adapter.unmount_owned()
            self.assertEqual([call.args[0] for call in command.call_args_list],[['umount','/private/artifacts'],['umount','/private/s']])
            self.assertEqual(adapter.mounts,[])


if __name__=='__main__': unittest.main()
