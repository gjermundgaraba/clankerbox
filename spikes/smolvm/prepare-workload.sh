#!/usr/bin/env bash
# Private OCI export only. No Docker daemon, VM, mount, or network configuration.
set -euo pipefail
stage=$(realpath "${1:?private staging directory}")
kit=$(realpath "${2:?shared acceptance kit directory}")
[[ "$stage" =~ ^/home/clanker/clankerbox-smolvm\.[A-Za-z0-9]{6}$ ]]
test -f "$kit/guest.py"
mkdir -p "$stage/downloads" "$stage/empty-docker" "$stage/tmp"
export DOCKER_CONFIG="$stage/empty-docker" TMPDIR="$stage/tmp"
crane="$stage/bundle/agent-rootfs/usr/local/bin/crane"
test -x "$crane"
if [[ ! -s "$stage/downloads/python-image.txt" ]]; then
    digest=$("$crane" digest --platform linux/amd64 python:3.13-alpine)
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
    printf 'python@%s\n' "$digest" > "$stage/downloads/python-image.txt"
fi
image=$(cat "$stage/downloads/python-image.txt")
if [[ ! -f "$stage/downloads/python-rootfs.tar" ]]; then
    "$crane" export --platform linux/amd64 "$image" "$stage/downloads/python-rootfs.tar"
fi
# A fresh directory prevents accidentally overwriting a previously tested image.
mkdir "$stage/workload"
tar --no-same-owner -xf "$stage/downloads/python-rootfs.tar" -C "$stage/workload"
mkdir -p "$stage/workload/opt/acceptance"
cp "$kit/guest.py" "$stage/workload/opt/acceptance/guest.py"
sha256sum "$stage/downloads/python-rootfs.tar" "$stage/workload/opt/acceptance/guest.py" > "$stage/workload.sha256"
echo 'PREPARED pinned Python workload; no VM launched'
