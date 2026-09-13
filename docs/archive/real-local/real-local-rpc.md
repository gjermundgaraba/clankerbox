> Historical qualification evidence. Its experiment implementation is retired; use current product acceptance harnesses.

# Typed bidirectional RPC transport gate

This isolated nested module proves the transport portion of gate A.2 in
`docs/real-local-development-plan.md`. It does not implement product API routes,
VM lifecycle, guest authentication/rebinding, terminal snapshot semantics, or a
production release. Product dependencies are unchanged.

Run the complete local qualification:

```sh
cd spikes/real-local-rpc
./scripts/run.sh
```

The runner installs the locked Node dependencies, type-checks generated bindings
and the Node probe, runs Go tests with the race detector, builds the fixture
server, and runs the actual Node HTTP/2 client against TCP h2c, Unix h2c, and TLS.
It creates one private temporary directory, terminates its own server, and removes
only that directory. It does not boot VMs or change system trust.

Regenerate checked-in bindings with `./scripts/generate.sh`. The script requires
protoc 36.1 and pins protoc-gen-go v1.36.12, protoc-gen-connect-go v1.21.0, and
protoc-gen-es 2.15.0. `go.mod`/`go.sum` pin Connect Go v1.21.0, protobuf Go
v1.36.12, and x/net v0.59.0; `package.json`/`pnpm-lock.yaml` pin Connect Node/JS
2.2.0 and protobuf ES 2.15.0. pnpm is pinned to 10.32.1. Node must support native
TypeScript stripping; the local recorded run used Node 26.5.1 and Go 1.27.1.

## Fixture contract

`proto/gate/v1/gate.proto` generates Go in `gen/gate/v1` and TypeScript in
`gen-ts/gate/v1`. `TerminalProbe.Attach` accepts typed `Open`, `Input`, and
`Resize` commands and returns typed `Opened`, `SnapshotChunk`, `Ack`, `Output`,
and `Resized` events. There is no opaque JSON dispatch or legacy frame carrier.
`GetStats` is fixture instrumentation, not a proposed public product API.

The server accepts only HTTP/2 for attachments. A single producer serializes
bootstrap chunks and input/resize processing. Its output queue has four entries
with at most 64 KiB of payload each; an additional producer chunk and currently
sending chunk may exist. Protobuf messages are bounded to 256 KiB. Queue admission
has a one-second deadline, and each HTTP/2 write has a two-second deadline.
A stalled attachment is rejected without waiting indefinitely or holding up a
second attachment. These are explicit fixture bounds, not claimed final product
configuration. HTTP/2 and operating-system buffers are additional bounded
transport buffers; the queue measurement is not a total-process memory bound.

## Recorded local evidence, 2026-09-12

Go→Go and Node→Go passed against each of TCP h2c, same-user Unix socket h2c,
and verified TLS:

- `Opened`, snapshot, input acknowledgements, output and resize arrive before
  the request stream is half-closed. Controls are sent while snapshot chunks
  are arriving, proving true duplex rather than request buffering until EOF.
- An 8,388,721-byte snapshot is reconstructed with exact byte validation and
  final-chunk/order checks. No acknowledgement or live output overtakes bootstrap.
- Input offset `9007199254740993` and sequence `18446744073709551615` survive
  generated binary and protobuf JSON round trips. TypeScript uses `bigint`;
  protobuf JSON uses decimal strings. Output offset comparison is exact.
- Client cancellation reports cancellation/rejection and the server returns to
  zero active attachments. Some transports deliver request EOF before the
  server's original context becomes canceled, so the context-cancellation
  counter is diagnostic, not the cleanup criterion. Node logs that observation.
- A 64 MiB snapshot whose client stops reading fills the bounded output queue;
  the server rejects/releases the attachment within the deadline. A sibling
  attachment on the same HTTP/2 connection completes while the reader is stalled.
  The observed queue high-water mark is four entries.
- Untrusted CA and wrong-hostname TLS connections fail. The positive tests trust
  only the generated disposable test CA; verification is never disabled.
- Go race tests and TypeScript checking pass.

The slow-reader probes explicitly disable compression. The synthetic snapshot's
repeating bytes otherwise compress enough to fit below the transport receive
window, masking the intended flow-control/backpressure condition.

## Isolated reverse-proxy qualification

The companion `../real-local-proxy/run.py` passed this same Node suite on
2026-09-12 using Node 26.8.1 through an SSH byte tunnel to the actual edge Caddy
2.11.4 binary, running an isolated loopback TLS listener and forwarding h2c to the
fixture Go server in the same container. Recorded evidence is in
`.work/real-local-proxy/20260912T184508Z-0db7e668` at repository root. The companion
README owns the full remote setup, cleanup, and production-isolation evidence.
This does not establish production controller cutover, the production domain,
Clankerdesk routing, or the complete deployed network path.

To probe an already-running isolated TLS proxy:

```sh
GATE_REMOTE_ORIGIN=https://localhost:18443 \
GATE_REMOTE_CA=/absolute/path/to/test-ca.pem \
  pnpm test
```

The remote mode runs the same Node duplex, snapshot, integer, cancellation,
slow-reader, sibling-isolation and negative-TLS assertions. It needs no local
endpoint manifest.

The fixture server can be launched independently:

```sh
go run ./cmd/gate-server -state-dir /tmp/owned-rpc-gate \
  -h2c-address 127.0.0.1:18080 -tls-address 127.0.0.1:18444
```

It writes `endpoints.json`, `ca.pem`, `cert.pem`, and `key.pem` under the supplied
private state directory and creates a mode-0600 Unix socket. The certificate has
localhost and loopback IP SANs and lasts 24 hours. An existing socket is refused.
Use an explicit short `-unix-socket` path if the state path exceeds macOS limits.
