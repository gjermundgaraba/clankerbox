# Clankerbox generated RPC contracts

The single supported wire package is `clankerbox.v1`. The checked-in Protobuf
sources generate Go models under `gen/clankerbox/v1`, Go Connect handlers/clients
under `gen/clankerbox/v1/clankerboxv1connect`, and TypeScript descriptors under
`protocol/src/gen/clankerbox/v1`.

These contracts are separate from SQLite journal models. `internal/rpcmodel`
translates the existing durable machine/checkpoint/operation and session records;
this transport work does not rewrite journals. Public Profile, Host, Machine,
and Checkpoint values omit image paths, private network endpoints, SSH fields,
engine store paths and credentials. The host protocol also carries only portable profile identity; hosts resolve
image paths from their own configuration after checking every compatibility field.

## Services

- `MachineService` provides discovery, resource reads, lifecycle mutations,
  operation inspection and synchronous label replacement. Mutations carry caller
  idempotency keys and return durable Operations; labels return the updated
  Machine directly. Clients poll GetOperation with bounded waits and never
  resubmit a mutation merely because a wait times out.
- `SessionService` is mounted independently on controller, host and guest. Each
  endpoint owns its authentication and machine admission.
- `HostService` provides durable typed operation submission/status, host and
  machine inspection. SubmitOperation
  acknowledgement is distinct from final operation success. Each action is a
  Protobuf oneof payload; there is no generic JSON command dispatcher.

Guest identity rebind is local administration outside the session service.

The same AttachmentRequest/AttachmentEvent types cross each terminal relay.
Exactly one Open comes first; subsequent Input/Resize controls are processed in
stream order. Opened describes the atomic guest-selected snapshot/resume/final
view and live subscription. `cut` is the session's live offset at that boundary;
`start_offset` is the requested retained starting offset and can be earlier.
SnapshotChunk/ViewChunk positions are attachment-local bootstrap positions.
Partial snapshots never become committed resume state. Final views retain their
cursor and can be unavailable. Output offsets and input sequences are uint64;
TypeScript uses bigint and Protobuf JSON uses decimal strings.

Opened is always first. ACKs may interleave with snapshot/view chunks or retained
resume output; they acknowledge control admission independently of prefix progress.
The immutable prefix finishes before any live terminal-state event. Input and
resize retain their control sequence ordering, and all events share one bounded
attachment queue. Clients that stop reading responses eventually backpressure
control admission.

Clean request EOF seals a finite drain boundary for queued responses and detaches
after that boundary, without waiting for the shell or draining an unbounded live
tail. Relays half-close the upstream request direction and continue receiving
through clean upstream completion. Errors and cancellation cancel the attachment.

Accepted input means admission to the bounded guest writer, not shell execution.
Lost acknowledgements are uncertain and must not cause automatic input replay.
Attachment cancellation detaches; EndSession independently ends the session.
All relays must bound queues and stalled writes. The schema does not by itself
implement these runtime obligations. Exact expected engine digest checks remain
required before snapshot decoding.

Errors combine standard Connect status codes with the typed ErrorDetail reason.
Unsupported, prerequisite, capacity, unavailable, identity mismatch, and engine
mismatch remain distinct. ErrorDetail.retryable is not permission to replay
uncertain input.

## Generation, checks, and packaging

```sh
cd protocol
pnpm install --frozen-lockfile
pnpm generate
pnpm build
pnpm check
pnpm test
pnpm pack
```

Generation requires protoc 36.1 and installs pinned protoc-gen-go v1.36.12,
protoc-gen-connect-go v1.21.0, and protoc-gen-es 2.15.0. Product runtime dependencies
are Connect Go v1.21.0, protobuf Go v1.36.12, and x/net v0.59.0. Go's module
selection additionally requires x/crypto v0.57.0 and x/sys v0.48.0.

The SDK pins @bufbuild/protobuf 2.15.0, @connectrpc/connect and connect-node 2.2.0,
TypeScript 7.0.2, and pnpm 12.4.1. Versions were checked against their official
registries/release API on 2026-09-12. Go module checksums and the pnpm lockfile
are checked in; repeat generation must leave generated content unchanged.

`pnpm pack` builds a portable `@clankerbox/sdk` tarball containing JavaScript and
declarations, without requiring consumers to understand TypeScript source or
have the Clankerbox checkout. For coordinated local development, build this
package then use `file:../clankerbox/protocol` or an appropriate workspace link.
The SDK exports all descriptors at its root, with `/resources`, `/machine`,
`/session` and `/host` subpaths. Server-side Node consumers use
`createClient(Service, createConnectTransport({httpVersion: "2", ...}))` from
Connect Node; browser Fetch is not a substitute for the bidirectional transport.

Run DTO/error tests from the repository root:

```sh
go test -race ./internal/rpcmodel ./gen/...
```

Tests cover domain round trips through serialized Protobuf, private-field
redaction, retained private profile/input fingerprints, all operation actions
and states, final views, resume cuts, creation retry identity, optional lifecycle
fields, integer range checks, and typed errors over an actual RPC connection.
The SDK tests exercise bigint/JSON precision, oneofs and service shapes. Generated
contracts alone are not VM qualification; the live harnesses are described in
[tests](../tests/README.md).
`test/real-vm.mjs` drives explicit guest qualification against a selected running
machine and is not part of the ordinary test glob.
