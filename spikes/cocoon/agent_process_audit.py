#!/usr/bin/env python3
"""Record only guest PID/PPID/comm plus owned VM metadata, never command arguments."""
import json
from pathlib import Path
import subprocess
import time

RUN=Path('/home/clanker/clankerbox-cocoon.b0ngM6/ca03')
CLI=['/home/clanker/clankerbox-cocoon.b0ngM6/bin/cocoon','--config',str(RUN/'config.json')]
rows={}
for name in ('cq-agent3-p','cq-agent3-a','cq-agent3-b'):
    vm=json.loads(subprocess.check_output(CLI+['vm','inspect',name],text=True))
    guest=subprocess.check_output(CLI+['vm','exec',name,'--','ps','-eo','pid,ppid,comm'],text=True)
    rows[name]=dict(vm_id=vm['id'],host_vmm_pid=vm['pid'],guest_process_names_only=guest)
(RUN/'process-audit.json').write_text(json.dumps(dict(host_monotonic_ns=time.monotonic_ns(),vms=rows),indent=2)+'\n')
