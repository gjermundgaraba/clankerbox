#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(protoc --version)" != "libprotoc 36.1" ]]; then
  echo "Generation requires protoc 36.1; found $(protoc --version)" >&2
  exit 1
fi
mkdir -p .tools src/gen ../gen
GOBIN="$PWD/.tools" go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
GOBIN="$PWD/.tools" go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.21.0
pnpm install --frozen-lockfile
PATH="$PWD/.tools:$PWD/node_modules/.bin:$PATH" protoc -I . \
  --go_out=../gen --go_opt=paths=source_relative \
  --connect-go_out=../gen --connect-go_opt=paths=source_relative \
  --es_out=src/gen --es_opt=target=ts,import_extension=js \
  clankerbox/v1/resources.proto clankerbox/v1/machine.proto \
  clankerbox/v1/session.proto clankerbox/v1/host.proto
