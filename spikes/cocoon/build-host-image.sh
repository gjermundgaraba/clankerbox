#!/bin/sh
# Run ONLY after a host execution slot authorizes the scoped Docker build.
set -eu
base=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
test "${CLANKER_HOST_SLOT:-}" = cocoon
case "$base" in /home/clanker/clankerbox-cocoon.*) ;; *) exit 1;; esac
cd "$base"
if docker image inspect clanker-cocoon-b0ngm6:acceptance >/dev/null 2>&1 || \
   docker container inspect clanker-cocoon-b0ngm6-export >/dev/null 2>&1; then
  echo 'Refusing to overwrite an existing build image or export container' >&2
  exit 1
fi
mkdir -p image-context
cp Dockerfile guest_prepare.py probe.py image-context/
cp src/guest.py image-context/
# Host networking avoids Docker creating bridge/NAT rules. No port publishing.
# Legacy builder enforces the CPU/memory flags on temporary build containers.
DOCKER_BUILDKIT=0 docker build --network=host --memory=8g --memory-swap=8g \
  --cpu-period=100000 --cpu-quota=400000 --label clanker-spike=cocoon-b0ngM6 \
  -t clanker-cocoon-b0ngm6:acceptance image-context
# Never start this export-only container; its sole purpose is flattening rootfs.
docker create --name clanker-cocoon-b0ngm6-export --network=none clanker-cocoon-b0ngm6:acceptance
trap 'docker rm clanker-cocoon-b0ngm6-export >/dev/null' EXIT
docker export clanker-cocoon-b0ngm6-export -o guest-rootfs.tar
sha256sum guest-rootfs.tar > guest-rootfs.sha256
docker image inspect clanker-cocoon-b0ngm6:acceptance > results/guest-image.json
python3 - <<'PY'
import hashlib, json, tarfile
with tarfile.open('guest-rootfs.tar') as t:
    names = [m for m in t.getmembers() if m.name.startswith('boot/') and m.isfile()]
    report = {m.name: {'size': m.size, 'sha256': hashlib.sha256(t.extractfile(m).read()).hexdigest()} for m in names}
    for m in names:
        if m.name.startswith('boot/config-'):
            cfg=t.extractfile(m).read().decode()
            report[m.name]['required_config']=[x for x in cfg.splitlines() if x.startswith(('CONFIG_VMGENID=', 'CONFIG_VIRTIO_MMIO=', 'CONFIG_VIRTIO_VSOCKETS='))]
    open('results/kernel-inventory.json','w').write(json.dumps(report,indent=2))
PY
