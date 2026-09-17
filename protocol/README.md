# @gjermundgaraba/clankerbox-sdk

Generated Protobuf messages, TypeScript types and Connect RPC service descriptors
for Clankerbox. This ESM package includes compiled JavaScript and declarations;
consumers do not need protoc, a Go toolchain, or a Clankerbox source checkout.

```sh
npm install @gjermundgaraba/clankerbox-sdk @connectrpc/connect @connectrpc/connect-node
```

```ts
import { MachineService, SessionService } from "@gjermundgaraba/clankerbox-sdk";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
```

The package supplies descriptors, not a transport or lifecycle coordinator.
Node consumers supply Connect 2.x and use
`createConnectTransport({httpVersion: "2", ...})`; browser fetch cannot carry
the bidirectional attachment stream. `@bufbuild/protobuf` is included as a
runtime dependency. All descriptors are exported at the root and through
`/resources`, `/machine`, `/session` and `/host` subpaths.

SDK **0.3.0** targets Clankerbox **0.7.0** and its runtime-built profile contract.
Use this pair together; SDK and controller version numbers are independent.
Older installations are not migrated to this contract.

## RPC contract

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
[terminal sessions](https://github.com/gjermundgaraba/clankerbox/blob/main/docs/terminal-sessions.md).

## Generation and packaging

```sh
cd protocol
pnpm install --frozen-lockfile
pnpm generate
pnpm build
pnpm check
pnpm test
pnpm test:package
pnpm pack
```

`generate` requires protoc 36.1 and installs pinned protoc-gen-go,
protoc-gen-connect-go and protoc-gen-es into `.tools/`. Go dependency versions
are in the root `go.mod`; JavaScript versions are in `package.json` and the
lockfile. Regeneration must leave the checked-in output unchanged.

`pnpm pack` clean-builds JavaScript and declarations and copies the repository's
MIT license into the package. `pnpm test:package` packs and installs the artifact
in a temporary consumer with lifecycle scripts disabled, then checks runtime
imports, TypeScript declarations, package contents and license inclusion.

Publishing uses dedicated `sdk-v<VERSION>` tags, not controller release tags.
See [SDK publishing](https://github.com/gjermundgaraba/clankerbox/blob/main/docs/sdk-publishing.md)
for first-publish setup and the tokenless GitHub Actions release workflow.

## Tests

```sh
go test -race ./internal/rpcmodel ./gen/...
cd protocol && pnpm test
```

The Go tests cover conversion round trips, private-field redaction, every
operation action and state, and typed errors over a real connection. The SDK
tests cover bigint and JSON precision, oneofs and service shapes.
`test/real-vm.mjs` and `test/public-session.mjs` drive a running machine and are
not part of the default test glob; see
[tests](https://github.com/gjermundgaraba/clankerbox/blob/main/tests/README.md).
