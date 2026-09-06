#!/bin/bash
set -euo pipefail
command -v gcc
command -v dockerd
mkdir -p /var/tmp/cube-build
cd /var/tmp/cube-build
cat > hello.c <<'C'
#include <stdio.h>
int main(void) { puts("cube-build-ok"); return 0; }
C
gcc -static -O2 -Wall -Werror hello.c -o hello
test "$(./hello)" = cube-build-ok
if ! docker info >/dev/null 2>&1; then
  nohup dockerd --storage-driver=vfs --iptables=false --bridge=none \
    >/var/tmp/cube-dockerd.log 2>&1 </dev/null &
fi
for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info
printf 'FROM scratch\nCOPY hello /hello\nENTRYPOINT ["/hello"]\n' > Dockerfile
DOCKER_BUILDKIT=0 docker build --network=none -t cube-spike-build:local .
test "$(docker run --rm --network=none cube-spike-build:local)" = cube-build-ok
printf 'guest-c-and-docker-build-pass\n'
