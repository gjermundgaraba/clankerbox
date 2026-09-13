.PHONY: build install test lint lint-fix

build:
	go build -o bin/clankerbox ./cmd/clankerbox
	go build -o bin/clankerbox-server ./cmd/clankerbox-server
	go build -o bin/clankerbox-host ./cmd/clankerbox-host
	GOOS=linux GOARCH=arm64 go build -o bin/clankerbox-guest-linux-arm64 ./cmd/clankerbox-guest
	GOOS=linux GOARCH=amd64 go build -o bin/clankerbox-guest-linux-amd64 ./cmd/clankerbox-guest
	GOOS=darwin GOARCH=arm64 go build -o bin/clankerbox-guest-darwin-arm64 ./cmd/clankerbox-guest

install:
	go install ./cmd/clankerbox

test:
	go test -race ./...
	python3 -m unittest discover -s tests -p 'test_*.py'
	python3 -m unittest discover -s scripts/release -p 'test_*.py'

lint:
	golangci-lint run ./...

lint-fix:
	golangci-lint run --fix ./...
