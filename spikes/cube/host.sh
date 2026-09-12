#!/bin/bash
# Linux HOST launcher for one disposable outer VM. Requires explicit slot grant.
# All Cube services run inside that VM, never in this Docker container or host.
set -euo pipefail
cd "$(dirname "$0")"
test "$(uname -s)" = Linux
python3 - <<'PY'
import json, os, pathlib
from cube_spike import GRANT, require, validate_host_scope
s = json.loads(pathlib.Path('.work/scope.json').read_text())
validate_host_scope(s, pathlib.Path.cwd())
require(os.environ.get('CUBE_HOST_SLOT_GRANTED') == GRANT, 'Wrong grant')
PY
target="$PWD/.work/target"
owner=$(python3 -c 'import json; print(json.load(open(".work/scope.json"))["owner"])')
name="$owner-qemu"
image="$owner-runner"
serial="cube-${owner##*-}-data"
test "${#serial}" -le 20

init_disks() {
  test "$(docker image inspect -f '{{index .Config.Labels "clanker.owner"}}' "$image")" = "$owner"
  test ! -e "$target/root.qcow2"
  test ! -e "$target/data.raw"
  test ! -e "$target/seed.iso"
  test -f "$target/user-data"
  docker run --rm --name "$owner-disk-init" --label "clanker.owner=$owner" \
    --user "$(id -u):$(id -g)" --network none --cap-drop ALL --security-opt no-new-privileges \
    -v "$PWD/.work:/work" "$image" sh -ec \
    'qemu-img create -f qcow2 -F qcow2 -b /work/noble-server-cloudimg-amd64.img /work/target/root.qcow2 12G
     qemu-img create -f raw /work/target/data.raw 24G
     cloud-localds /work/target/seed.iso /work/target/user-data /work/target/meta-data'
}

case "${1:-}" in
  stage)
    test ! -e "$target"
    ! docker image inspect "$image" >/dev/null 2>&1
    ! docker inspect "$name" >/dev/null 2>&1
    ! docker inspect "$owner-disk-init" >/dev/null 2>&1
    test -z "$(ss -H -ltn sport = :22070)"
    mkdir -m 700 "$target"
    python3 - <<'PY'
import hashlib, pathlib
from cube_spike import require
p = pathlib.Path('.work/noble-server-cloudimg-amd64.img')
require(hashlib.file_digest(p.open('rb'), 'sha256').hexdigest() == 'd0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30', 'Cloud image checksum mismatch')
PY
    base=$(python3 -c 'import json; print(json.load(open("images.lock.json"))["RUNNER_BASE"]["pinned"])')
    ca_base=$(python3 -c 'import json; print(json.load(open("images.lock.json"))["GUEST_BASE"]["pinned"])')
    DOCKER_BUILDKIT=0 docker build --force-rm --network host --memory=8g --memory-swap=8g \
      --cpu-period=100000 --cpu-quota=400000 --label "clanker.owner=$owner" \
      --build-arg "BASE=$base" --build-arg "CA_BASE=$ca_base" --build-arg "OWNER=$owner" \
      -f Dockerfile.runner -t "$image" .
    docker image inspect "$image" > "$target/runner-image.json"
    ssh-keygen -q -t ed25519 -N '' -f "$target/id_ed25519"
    python3 - <<'PY'
from pathlib import Path
import json
from cube_spike import REV
p = Path('.work/target')
key = (p / 'id_ed25519.pub').read_text().strip()
config = {
 'hostname': 'clanker-cube070-disposable', 'ssh_pwauth': False,
 'users': [{'name': 'cube', 'sudo': 'ALL=(ALL) NOPASSWD:ALL', 'shell': '/bin/bash',
            'ssh_authorized_keys': [key]}],
 'write_files': [{'path': '/etc/clanker-cube-disposable', 'content': REV + '\n'},
                 {'path': '/etc/clanker-cube-scope', 'content': Path('.work/scope.json').read_text()},
                 {'path': '/etc/apt/sources.list.d/ubuntu.sources',
                  'content': '# Disabled: dated sources are in /etc/apt/sources.list\n'}],
 'apt': {'preserve_sources_list': False, 'sources_list':
    'deb [check-valid-until=no] http://snapshot.ubuntu.com/ubuntu/20260901T000000Z/ noble main universe\n'
    'deb [check-valid-until=no] http://snapshot.ubuntu.com/ubuntu/20260901T000000Z/ noble-updates main universe\n'
    'deb [check-valid-until=no] http://snapshot.ubuntu.com/ubuntu/20260901T000000Z/ noble-security main universe\n'},
 'package_update': True, 'package_upgrade': False,
 'packages': ['docker.io', 'docker-compose-v2', 'xfsprogs', 'python3-venv', 'python3-pip',
              'curl', 'jq', 'unzip', 'rsync', 'iproute2', 'iptables', 'git', 'bc'],
 'runcmd': ['modprobe kvm_amd', 'systemctl enable --now docker',
            'dpkg-query -W > /var/log/clanker-cube070-packages.txt']}
(p / 'user-data').write_text('#cloud-config\n' + json.dumps(config))
(p / 'meta-data').write_text('instance-id: clanker-cube070\nlocal-hostname: clanker-cube070-disposable\n')
PY
    init_disks
    ;;
  disks) init_disks ;;
  start|restricted)
    test -c /dev/kvm
    test -f "$target/root.qcow2"
    test "$(docker image inspect -f '{{index .Config.Labels "clanker.owner"}}' "$image")" = "$owner"
    test -z "$(ss -H -ltn sport = :22070)"
    if docker inspect "$name" >/dev/null 2>&1; then
      echo 'Existing owned launcher: stop and remove it explicitly before start' >&2
      exit 1
    fi
    restrict=off
    test "$1" != restricted || restrict=on
    # Host networking avoids Docker bridge/firewall changes. QEMU's userspace
    # network is the VM boundary; its sole TCP listener binds host loopback.
    # No host PID namespace, TUN, bpffs, system mounts or extra capabilities.
    docker run -d --name "$name" --label "clanker.owner=$owner" \
      --memory=14g --memory-swap=14g --cpus=8 --pids-limit=2048 \
      --cap-drop ALL --security-opt no-new-privileges --device /dev/kvm \
      --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /dev/kvm)" \
      --network host -v "$PWD/.work:/work" "$image" \
      qemu-system-x86_64 -enable-kvm -cpu host -smp 8 -m 12288 \
      -name clanker-cube070 -display none -serial file:/work/target/serial.log \
      -qmp unix:/work/target/qmp.sock,server=on,wait=off \
      -drive file=/work/target/root.qcow2,format=qcow2,if=none,id=cuberoot \
      -device virtio-blk-pci,drive=cuberoot,bootindex=1 \
      -drive file=/work/target/data.raw,format=raw,if=none,id=cubedata \
      -device "virtio-blk-pci,drive=cubedata,serial=$serial" \
      -drive file=/work/target/seed.iso,format=raw,if=virtio,readonly=on \
      -netdev "user,id=net0,net=10.77.70.0/24,dhcpstart=10.77.70.15,restrict=$restrict,hostfwd=tcp:127.0.0.1:22070-:22" \
      -device virtio-net-pci,netdev=net0
    sleep 1
    if test "$(docker inspect -f '{{.State.Running}}' "$name")" != true; then
      docker logs "$name" >&2
      exit 1
    fi
    ;;
  status)
    docker inspect "$name"
    du -sx --block-size=1 .work
    ;;
  stop)
    test "$(docker inspect -f '{{index .Config.Labels "clanker.owner"}}' "$name")" = "$owner"
    docker stop -t 60 "$name"
    docker rm "$name"
    ;;
  *) echo 'usage: host.sh stage|disks|start|restricted|status|stop' >&2; exit 2 ;;
esac
