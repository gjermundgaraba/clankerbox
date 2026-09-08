.PHONY: build install test lint lint-fix

build:
	go build -o bin/clankerbox ./cmd/clankerbox
	go build -o bin/clankerbox-server ./cmd/clankerbox-server
	go build -o bin/clankerbox-host ./cmd/clankerbox-host

install:
	go install ./cmd/clankerbox

test:
	go test -race ./...

lint:
	golangci-lint run ./...

lint-fix:
	golangci-lint run --fix ./...
