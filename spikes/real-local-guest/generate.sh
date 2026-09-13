#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p .tools
GOBIN="$PWD/.tools" go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
GOBIN="$PWD/.tools" go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.21.0
PATH="$PWD/.tools:$PATH" protoc -I proto --go_out=gen --go_opt=paths=source_relative --connect-go_out=gen --connect-go_opt=paths=source_relative proto/guest/v1/guest.proto
