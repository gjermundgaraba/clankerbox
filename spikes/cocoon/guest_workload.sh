#!/bin/sh
# Disposable guest only: vfs avoids nesting an overlay upperdir on Cocoon overlay.
set -eu
cd /var/tmp
printf '#include <stdio.h>\nint main(void){puts("clanker-build-ok");}\n' > build.c
gcc -static -Wall -Werror build.c -o build
./build
systemctl mask --now systemd-networkd-wait-online.service
systemctl stop docker.service docker.socket
mkdir -p /etc/docker
printf '%s\n' '{"storage-driver":"vfs","data-root":"/var/lib/clanker-docker-vfs","features":{"containerd-snapshotter":false}}' > /etc/docker/daemon.json
dockerd --validate --config-file=/etc/docker/daemon.json
systemctl start docker.service
docker info --format '{{.Driver}}'
mkdir -p docker-build
cp build docker-build/build
printf 'FROM scratch\nCOPY build /build\n' > docker-build/Dockerfile
docker build --network=none -t clanker-local docker-build
docker run --rm --network=none clanker-local /build
