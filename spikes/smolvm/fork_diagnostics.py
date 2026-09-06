"""Non-secret guest diagnostics over the private, already-authorized agent RPC."""
import base64
import json
import socket
import struct
from concurrent.futures import ThreadPoolExecutor


def vm_exec(socket_path, command, timeout=45):
    request = json.dumps({"method": "vm_exec", "command": command,
                          "env": [], "workdir": None, "timeout_ms": timeout * 1000}).encode()
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(timeout + 5)
        conn.connect(str(socket_path))
        conn.sendall(struct.pack(">I", len(request)) + request)
        def receive(count):
            value = bytearray()
            while len(value) < count:
                data = conn.recv(count - len(value))
                if not data:
                    raise RuntimeError("agent closed diagnostic RPC")
                value.extend(data)
            return bytes(value)
        response = json.loads(receive(struct.unpack(">I", receive(4))[0]))
    for key in ("stdout", "stderr"):
        if key in response:
            response[key] = base64.b64decode(response[key]).decode(errors="replace")
    return response


def start_resident(socket_path):
    # Already running before capture: continues even if fresh container exec fails.
    script = r'''
for state in /storage/containers/crun/*/status; do
  printf 'STATE %s\n' "$state"; cat "$state"; printf '\n'
done
i=0
while [ "$i" -lt 24 ]; do
  printf 'SAMPLE %s ' "$i"; cat /proc/uptime
  for state in /storage/containers/crun/*/status; do
    cid=${state%/status}; cid=${cid##*/}
    pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$state")
    printf 'IDENTITY cid=%s pid=%s\n' "$cid" "$pid"
    for link in /proc/1/ns/mnt /proc/1/ns/pid /proc/$pid/ns/mnt /proc/$pid/ns/pid /proc/$pid/root; do printf '%s ' "$link"; readlink "$link"; done
    for file in /usr/bin/crun /proc/$pid/root/usr/local/bin/python3 /proc/$pid/root/bin/busybox; do
      ls -li "$file"; sha256sum "$file"; od -An -tx1 -N64 "$file"
    done
    /opt/probe/lib/ld-linux-x86-64.so.2 --library-path /opt/probe/lib /opt/probe/strace -f -s 160 -e trace=execve,execveat,setns,chroot,chdir,openat,memfd_create /usr/bin/crun --root /storage/containers/crun exec "$cid" /bin/true
    printf 'CRUN_EXIT %s\n' "$?"
    /usr/bin/nsenter --target "$pid" --mount --pid --root=/proc/$pid/root --wd=/proc/$pid/root -- /bin/true
    printf 'NSENTER_EXIT %s\n' "$?"
  done
  i=$((i+1)); sleep 1
done
'''
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(vm_exec, socket_path, ["/bin/sh", "-c", script], 45)
    return pool, future
