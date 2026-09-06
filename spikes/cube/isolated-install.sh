#!/bin/bash
# Run only INSIDE the fresh outer VM. The existing host never invokes install.sh.
set -euo pipefail
trap 'echo "isolated-install: failed at line $LINENO" >&2' ERR
cd /opt/clanker-spikes/cube
python3 -c 'from cube_spike import isolated; isolated()'
test "$(id -u)" = 0
python3 nested_kvm.py | tee .work/nested-kvm.json
python3 - <<'PY'
import hashlib
from cube_spike import require
with open('.work/cube-sandbox-one-click-v0.7.0-amd64.tar.gz', 'rb') as stream:
    require(hashlib.file_digest(stream, 'sha256').hexdigest() ==
            'd4522eb97fe898dd8ea681a7caaadbfd1f331d98df76a7c08e5865d6b7229ba4', 'Bundle checksum mismatch')
PY
mkdir -p .work/bundle
tar -xzf .work/cube-sandbox-one-click-v0.7.0-amd64.tar.gz -C .work/bundle

# Only the uniquely serialized second virtual disk is eligible for formatting.
owner=$(python3 -c 'import json; print(json.load(open(".work/scope.json"))["owner"])')
label="cube-${owner##*-}"
test "$(cat /sys/class/block/vdb/serial)" = "$label-data"
test "$(blockdev --getsize64 /dev/vdb)" = 25769803776
if findmnt /data/cubelet >/dev/null; then
  test "$(findmnt -n -o SOURCE /data/cubelet)" = /dev/vdb
  test "$(findmnt -n -o FSTYPE /data/cubelet)" = xfs
else
  test -z "$(lsblk -nr -o MOUNTPOINTS /dev/vdb | tr -d '[:space:]')"
  if ! blkid /dev/vdb >/dev/null; then
    mkfs.xfs -m reflink=1 -L "$label" /dev/vdb
  fi
  test "$(blkid -s LABEL -o value /dev/vdb)" = "$label"
  test "$(blkid -s TYPE -o value /dev/vdb)" = xfs
  mkdir -p /data/cubelet
  mount /dev/vdb /data/cubelet
fi
grep -q "^LABEL=$label " /etc/fstab || \
  printf 'LABEL=%s /data/cubelet xfs defaults 0 0\n' "$label" >> /etc/fstab
xfs_info /data/cubelet | tee .work/xfs-info.txt
grep -q 'reflink=1' .work/xfs-info.txt
mountpoint -q /sys/fs/bpf || mount -t bpf bpf /sys/fs/bpf
grep -q '^bpf /sys/fs/bpf ' /etc/fstab || printf 'bpf /sys/fs/bpf bpf defaults 0 0\n' >> /etc/fstab

python3 - <<'PY'
import hashlib, json, pathlib, secrets
from cube_spike import require
root = pathlib.Path('.work/bundle/cube-sandbox-one-click-v0.7.0-amd64')
archive = pathlib.Path('.work/cube-sandbox-one-click-v0.7.0-amd64.tar.gz')
require(hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == 'd4522eb97fe898dd8ea681a7caaadbfd1f331d98df76a7c08e5865d6b7229ba4', 'Bundle checksum mismatch')
lock = json.loads(pathlib.Path('images.lock.json').read_text())
keys = [key for key in lock if key.startswith('CUBE_') or key == 'WEB_UI_IMAGE']
require(len(keys) == 8, 'Missing pinned dependency images')
env = pathlib.Path('isolated.env').read_text()
env += '\n' + '\n'.join(key + '=' + lock[key]['pinned'] for key in keys) + '\n'
for key in ['CUBE_SANDBOX_REDIS_PASSWORD', 'CUBE_SANDBOX_MYSQL_ROOT_PASSWORD',
            'CUBE_SANDBOX_MYSQL_PASSWORD', 'CUBE_SANDBOX_MINIO_ROOT_PASSWORD']:
    env += key + '=' + secrets.token_hex(24) + '\n'
p = root / '.env'
if p.exists():
    current = dict(line.split('=', 1) for line in p.read_text().splitlines()
                   if line and not line.startswith('#') and '=' in line)
    expected = dict(line.split('=', 1) for line in pathlib.Path('isolated.env').read_text().splitlines()
                    if line and not line.startswith('#') and '=' in line)
    expected.update({key: lock[key]['pinned'] for key in keys})
    require(all(current.get(key) == value for key, value in expected.items()),
            'Existing config differs from pinned input; inspect before resuming')
else:
    p.write_text(env)
    p.chmod(0o600)
PY
cd .work/bundle/cube-sandbox-one-click-v0.7.0-amd64
bash install.sh
bash smoke.sh
