#!/bin/bash
# Run inside the fresh VM after isolated-install.sh, while provisioning egress is on.
set -euo pipefail
cd /opt/clanker-spikes/cube
python3 -c 'from cube_spike import isolated; isolated()'
owner=$(python3 -c 'import json; print(json.load(open(".work/scope.json"))["owner"])')
base=$(python3 -c 'import json; print(json.load(open("images.lock.json"))["GUEST_BASE"]["pinned"])')
registry=$(python3 -c 'import json; print(json.load(open("images.lock.json"))["REGISTRY_IMAGE"]["pinned"])')
docker run -d --name clanker-cube070-registry --restart unless-stopped \
  --label "clanker.owner=$owner" -p 127.0.0.1:5000:5000 "$registry"
docker build --label "clanker.owner=$owner" --build-arg "BASE=$base" \
  -f Dockerfile.workload -t localhost:5000/cube-workload:070 .
docker push localhost:5000/cube-workload:070
docker image inspect localhost:5000/cube-workload:070 > .work/workload-image.json
image=$(docker image inspect -f '{{index .RepoDigests 0}}' localhost:5000/cube-workload:070)
printf 'http://%s\n' "$image" > .work/workload-image-ref
python3 -m venv .work/linux-venv
.work/linux-venv/bin/pip install -r requirements.lock
.work/linux-venv/bin/pip install --no-deps --no-build-isolation .work/upstream/sdk/python
export CUBE_WORKLOAD_IMAGE="http://$image"
.work/linux-venv/bin/python cube_spike.py template .work/template
