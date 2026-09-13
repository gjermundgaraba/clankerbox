# RPC contract and SDK

The wire package is `clankerbox.v1`. The Protobuf sources under
`clankerbox/v1/` generate Go messages in `gen/clankerbox/v1`, Go Connect
handlers and clients in `gen/clankerbox/v1/clankerboxv1connect`, and TypeScript
in `src/gen/clankerbox/v1`. Generated code is checked in.

The services:

- `MachineService`: discovery, resource reads, lifecycle mutations, operation
  inspection and label replacement. Lifecycle mutations carry idempotency keys
  and return durable Operations; clients poll `GetOperation` and never resubmit
  a mutation because a wait timed out. `SetLabels` is the exception: it takes
  no key and returns the updated `Machine` synchronously.
- `SessionService`: terminal sessions, mounted on controller, host and guest
  with endpoint-specific authorization.
- `HostService`: private operation submission and status plus host and machine
  inspection. Each action is a `oneof` payload.

Public `Profile`, `Host`, `Machine` and `Checkpoint` messages omit image paths,
private endpoints, engine store paths and credentials. `internal/rpcmodel`
converts between these messages and the services' persisted records.

Errors combine a Connect status code with a typed `ErrorDetail` reason.
`retryable` describes the operation, not terminal input: a lost input
acknowledgement must never be replayed. The streaming semantics of
`AttachSession` are specified in
[terminal sessions](../docs/terminal-sessions.md).

## Generation and packaging

```sh
cd protocol
pnpm install --frozen-lockfile
pnpm generate
pnpm build
pnpm check
pnpm test
pnpm pack
```

`generate` requires protoc 36.1 and installs pinned protoc-gen-go,
protoc-gen-connect-go and protoc-gen-es into `.tools/`. Go dependency versions
are in the root `go.mod`; JavaScript versions are in `package.json` and the
lockfile. Regeneration must leave the checked-in output unchanged.

`pnpm pack` produces a `@clankerbox/sdk` tarball with JavaScript and
declarations. It exports all descriptors at the root and per-file subpaths
`/resources`, `/machine`, `/session` and `/host`. Node consumers use
`createConnectTransport({httpVersion: "2", ...})` from
`@connectrpc/connect-node`; browser fetch cannot carry the bidirectional
attachment stream.

## Tests

```sh
go test -race ./internal/rpcmodel ./gen/...
cd protocol && pnpm test
```

The Go tests cover conversion round trips, private-field redaction, every
operation action and state, and typed errors over a real connection. The SDK
tests cover bigint and JSON precision, oneofs and service shapes.
`test/real-vm.mjs` and `test/public-session.mjs` drive a running machine and are
not part of the default test glob; see [tests](../tests/README.md).
