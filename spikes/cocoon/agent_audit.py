#!/usr/bin/env python3
"""Read-only TC observation; saves metadata only, never packets or guest data."""
import json
from pathlib import Path
import subprocess
import time

RUN=Path('/home/clanker/clankerbox-cocoon.b0ngM6/ca03')
seen={}
with (RUN/'gate-audit.jsonl').open('x') as log:
    while True:
        for path in (RUN/'gates').glob('*.json'):
            try:
                record=json.loads(path.read_text())
                key=(record['vm_id'],record['state'])
                if key in seen: continue
                if record['bridge'] not in ('cqagp','cqaga','cqagb'): raise ValueError('unowned gate')
                rules={direction:json.loads(subprocess.check_output(
                    ['tc','-s','-j','filter','show','dev',record['dev'],direction],text=True,stderr=subprocess.DEVNULL))
                    for direction in ('ingress','egress')}
                seen[key]=True
                log.write(json.dumps(dict(host_monotonic_ns=time.monotonic_ns(),gate=record,tc=rules))+'\n');log.flush()
            except (OSError,subprocess.CalledProcessError,json.JSONDecodeError): pass
        evidence=json.loads((RUN/'agent-evidence.json').read_text())
        if evidence.get('cleanup'): break
        time.sleep(.5)
