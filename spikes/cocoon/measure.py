#!/usr/bin/env python3
"""Host observation only: FC state sampling and Linux process/disk attribution."""
import http.client
import json
import os
from pathlib import Path
import socket
import threading
import time


class PauseObserver:
    def __init__(self, socket_path):
        self.path = socket_path; self.samples = []; self.stop = threading.Event()
        self.thread = threading.Thread(target=self.observe, daemon=True)

    def observe(self):
        while not self.stop.is_set():
            before = time.monotonic_ns()
            try:
                conn = http.client.HTTPConnection('localhost', timeout=0.5)
                conn.sock = socket.socket(socket.AF_UNIX); conn.sock.settimeout(0.5); conn.sock.connect(self.path)
                conn.request('GET', '/')
                response = conn.getresponse()
                state = json.loads(response.read())['state']
                conn.close()
            except Exception as error:
                state = 'error:' + str(error)
            self.samples.append(dict(before_ns=before, after_ns=time.monotonic_ns(), state=state))
            self.stop.wait(0.01)

    def finish(self):
        self.stop.set(); self.thread.join(timeout=2)
        paused = [i for i,s in enumerate(self.samples) if s['state'] == 'Paused']
        if not paused or paused[0] == 0 or paused[-1] == len(self.samples)-1:
            return dict(source_pause_lower_ms=None, source_pause_upper_ms=None)
        first, last = paused[0], paused[-1]
        # Conservative sampling bounds, not an exact instrumented vCPU pause.
        return dict(source_pause_lower_ms=max(0, (self.samples[last]['before_ns'] - self.samples[first]['after_ns'])/1e6),
                    source_pause_upper_ms=(self.samples[last+1]['after_ns'] - self.samples[first-1]['before_ns'])/1e6)


def resources(vms, base):
    result = {}
    for name, vm in vms.items():
        status = {}
        for line in Path(f"/proc/{vm['pid']}/smaps_rollup").read_text().splitlines():
            if line.startswith(('Rss:', 'Pss:', 'Private_Dirty:', 'Shared_Clean:')):
                key, value, _ = line.split(); status[key.rstrip(':') + '_bytes'] = int(value)*1024
        result[name] = status
    result['allocated_disk_bytes'] = sum(p.stat().st_blocks * 512 for p in base.rglob('*') if p.is_file())
    return result
