#!/bin/sh
set -eu
cd "$(dirname "$0")"
base=$PWD
mkdir -p .work
export GOMODCACHE="$base/.work/gomod" GOCACHE="$base/.work/gocache" GOPATH="$base/.work/gopath" GOMAXPROCS=4
export GOOS=linux GOARCH=amd64 CGO_ENABLED=0
if [ ! -d .work/cocoon ]; then
  git clone https://github.com/cocoonstack/cocoon.git .work/cocoon
fi
test "$(git -C .work/cocoon rev-parse HEAD)" = 23a05603479a7552213adfb5fa25f2de7b2dbaf9 || git -C .work/cocoon checkout --detach 23a05603479a7552213adfb5fa25f2de7b2dbaf9
go build -C .work/cocoon -p 4 -ldflags "-X github.com/cocoonstack/cocoon/version.REVISION=23a05603479a7552213adfb5fa25f2de7b2dbaf9" -o ../cocoon-linux-amd64 .
if [ ! -d .work/cni ]; then
  git clone --depth 1 --branch v1.9.1 https://github.com/containernetworking/plugins.git .work/cni
fi
test "$(git -C .work/cni rev-parse HEAD)" = adc3e6b5b581638afbd194cf2e9319ecbb0151a1
go build -C .work/cni -p 4 -o ../bridge ./plugins/main/bridge
go build -C .work/cni -p 4 -o ../host-local ./plugins/ipam/host-local
