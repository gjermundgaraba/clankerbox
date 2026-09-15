# Contributing

## Build and test

Go 1.27, Python 3 and, for `make lint`, golangci-lint v2.13 are required.

```sh
make build   # CLI, controller, host and cross-compiled guest binaries into bin/
make test    # go test -race ./... plus the Python unit tests
make lint    # golangci-lint run ./...
```

The protobuf definitions and the TypeScript SDK live in `protocol/`:

```sh
cd protocol && pnpm install --frozen-lockfile && pnpm check && pnpm build && pnpm test && pnpm test:package
```

CI runs the Go tests on macOS and Linux, lint, and the protocol checks, including
installation of the packed SDK into a standalone consumer. See
[SDK publishing](docs/sdk-publishing.md) for npm setup and releases.

## Protocol changes

`protocol/clankerbox/v1` is the only wire contract ([ADR 0004](docs/adr/0004-generated-connect-contract.md)).
After editing a `.proto` file, regenerate the Go and TypeScript output as
described in [protocol/README.md](protocol/README.md) and commit the result.

## Design decisions

Architecture decisions are recorded in [docs/adr](docs/adr). A change that
reverses a recorded decision gets a new numbered ADR rather than an edit to the
old one.

## Pull requests

- Keep each commit focused and explain why in the message, not only what.
- Run `make test` and `make lint` before opening a pull request.
- Harnesses that need a live VM host live in [tests/](tests/README.md) and do not
  run in CI.
