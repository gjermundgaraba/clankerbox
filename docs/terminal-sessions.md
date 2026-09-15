# Terminal sessions

Terminal sessions are guest-owned PTYs exposed through the generated
`SessionService` in [session.proto](../protocol/clankerbox/v1/session.proto).
The controller and host relay attachment messages without interpreting terminal
bytes; only the guest holds terminal state.

## Trust boundaries

```text
application client
  │ MachineService + SessionService, bearer-authenticated HTTP/2
  ▼
clankerbox-server
  │ private HostService, authenticated HTTP/2
  ▼
clankerbox-host (journal, machine admission, guest routing)
  │ private SessionService, mutually authenticated TLS
  ▼
clankerbox-guest (PTY ownership, Ghostty VT, bounded output ring)
```

Applications address a machine ID and never receive guest endpoints,
certificates, host credentials or image paths. Guest readiness comes from the
host's observation and an authenticated `DescribeGuest`.

The guest daemon runs privileged and starts terminal workloads under a separate
unprivileged user. Binding files, service keys and the rebind socket are
root-owned, so workloads cannot read credentials or rebind. The guest verifies
the host certificate; the host verifies the guest certificate's machine identity
against the requested machine. Workloads on one machine share a user and are
not isolated from each other. The public bearer token grants shell access to
machines, never access to the management identity.

A RAM fork keeps the live session manager, PTY masters and process memory.
Before access is published, the host installs a new machine-scoped binding
through the rebind socket; this invalidates inherited transports and changes the
admission epoch without restarting sessions. A cold copy starts a new daemon
incarnation and marks unfinished sessions `lost`.

## Clients

Go bindings are in `gen/clankerbox/v1`; the TypeScript SDK is built from
[protocol/](../protocol/README.md). Node clients need `@connectrpc/connect-node`
with `httpVersion: "2"` for bidirectional attachment. A browser fetch transport
cannot carry it, so keep the Connect client and the bearer token server-side.

| Service | Methods |
| --- | --- |
| `MachineService` | Host and profile discovery, machine and checkpoint lifecycle, operation inspection, label replacement. |
| `SessionService` | `DescribeGuest`, `CreateSession`, `ListSessions`, `EndSession`, `AttachSession`. |
| `HostService` (private) | Operation submission and status, machine inspection, host description. |

`SessionService` is mounted on controller, host and guest with the same schema
and endpoint-specific authorization.

## Session lifecycle

Each session owns a PTY, a child process, a Ghostty VT and a bounded output
ring. The default command is `/bin/sh -l`. The process gets a fixed
environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL=/bin/sh`,
`TERM=xterm-256color`, `LANG=C.UTF-8`) followed by the caller's `env` entries,
which win for duplicate keys. An empty cwd means the workload home, a relative
cwd is resolved against it, and the directory must already exist. The machine
ID is not placed in the environment, because forked processes would keep the
parent's value.

Session state lives under the guest's private state directory as
`sessions/<id>/manifest.json`, written atomically with fsync. A session ID is
durable before its process is published and stays taken even if a later write
fails. Unreadable records become known `lost` IDs so a repeated create cannot
spawn a second process. Children inherit no management sockets, locks or
credentials.

States are `starting`, `running`, `exited` and `lost`. Exit code, signal, end
time, PID and incarnation are recorded separately. On child exit the daemon
drains the PTY to EOF or a bounded deadline, publishes the final record with the
final screen text and cursor, and releases the terminal. Ended records are
retained for a week and still deduplicate a repeated create. Daemon loss,
machine stop or reboot ends live ownership; network loss, controller or host
restart, or closing a viewer only detaches consumers.

`EndSession` signals the foreground process group, then escalates against the
child's process group with bounded waits. Its reply is not an output barrier:
consumers finalize their screen from the ordered `SessionExited` event or from
an `ENDED` opening after reconnecting.

## Creating sessions

`CreateSession` carries `machine_id`, a caller-minted `session_id`, label, cwd,
argv, env, grid and the caller's RFC 3339 `created_at`. Repeating the same ID
with the same cwd, argv and env returns the retained session for as long as its
record exists; changing them is a conflict. Only a create the guest never
started is subject to the horizon: one older than a day is expired and one more
than an hour in the future is invalid. A client that lost the reply therefore
retries with its original identity and timestamp.

Unary failures return a Connect status plus an `ErrorDetail` with a stable
`ErrorReason` and retryable flag. Classify on the reason, not the message. A
prerequisite refusal means the machine is not ready for sessions: not running
at its accepted generation, not prepared, or deleted. Attaching never starts a
machine. An unavailable transport does not prove a mutation was refused.

## Attachment

An `AttachmentRequest` is exactly one of `Open`, `Input` or `Resize`. `Open`
comes first and only once, with the machine and session IDs, an optional
expected engine digest and an optional `ResumeCursor {offset, incarnation}`.
Later controls use strictly increasing positive sequence IDs.

The first `AttachmentEvent` is `Opened`, with the guest description, session,
mode, the atomic `cut`, `start_offset`, snapshot length and an optional final
`View`. The remaining events are `SnapshotChunk`, `ViewChunk`, `Output`,
`Resized`, `Ack`, `SessionExited` and `Gap`.

Every offset, cursor and counter is a `uint64`. TypeScript receives `bigint`;
never pass an output offset, resume cursor, PID or sequence through a JavaScript
number. Protobuf JSON encodes them as strings.

### Opening

The session mutex selects the cut, captures the bootstrap prefix and registers
the subscriber; sending happens outside it. `Opened` is sent first, then the
prefix, then live events. Acknowledgements may interleave with the prefix.
Output at the cut is neither skipped nor duplicated, and a snapshot consumes no
output offsets.

| Mode | Contract |
| --- | --- |
| `RESUME` | The incarnation matches, the requested offset is still retained and no resize happened at or after it. `start_offset` is the requested cursor; `cut` is the later session offset. Output replays `[start_offset, cut)` before live output. |
| `SNAPSHOT` | The session cannot be resumed. `snapshot_bytes` announces the exact Ghostty snapshot length; `SnapshotChunk` delivers it, then live output starts at `cut`. |
| `UNAVAILABLE` | The VT cannot encode a snapshot right now. No subscriber or prefix follows; keep the previous mirror and retry with backoff. |
| `ENDED` | The session is exited or lost. An optional `View` gives the final cursor and byte count, followed by `ViewChunk`. An absent view is different from an empty one. No live tail follows. |

Snapshot and view chunks carry a bootstrap-local `position`, bytes and `final`.
Positions must be contiguous and `final` must agree with the announced total;
truncation, gaps, contradictory lengths or invalid snapshot data fail the
attachment.

A consumer advances its committed resume cursor only after its parser consumed
a contiguous `Output` range, and adopts a snapshot's cut only after a complete
restore. To request a fresh snapshot, omit the resume cursor. An ordered
`Resized` event changes the mirror grid at its output offset.

`DescribeGuest` and `Opened.guest` expose the schema identifier, machine ID,
incarnation, boot ID, daemon version, workload user, engine digest and capacity.
A consumer that decodes snapshots supplies its expected engine digest; a
mismatch is reported without ending sessions. The guest binary belongs to the
prepared image; changing it requires a new image/bundle and is not a live PTY
handoff. Retained starts do not install binaries.

### Input and replies

An `Input` acknowledgement means the bytes were admitted to the bounded PTY
writer, not that the shell ran them. A lost acknowledgement leaves the input
uncertain; never replay it on another attachment. Repeated sequence IDs are
refused. A `Resize` acknowledgement means the request was accepted; the mirror
follows the ordered `Resized` event, which may arrive before or after the
acknowledgement.

One writer drains caller input and the VT's automatic replies (DA, DSR, CPR)
without interleaving entries. Caller input has an admission budget and replies
have a separate reservation; overflow refuses input or counts dropped replies in
`reply_overflow`. The PTY reader never waits for a consumer. Only the guest VT
emits terminal replies; mirrors must not duplicate them. Interrupt is ordinary
input such as Ctrl-C.

Each subscriber has an immutable bootstrap prefix and a bounded live tail. A
consumer that overflows its tail is dropped with a best-effort `Gap`; other
consumers and the PTY continue. A clean request half-close stops control
admission, drains the already-queued responses and detaches without waiting for
the shell. Disconnecting never calls `EndSession`.

## Host routing

The host admits guest calls only for an owned, prepared, running machine at its
accepted generation and without conflicting reservations. Fork and checkpoint
reservations revoke existing guest leases before runtime work; consumers
reconnect once admission reopens. A host or controller restart rebuilds routing
from durable state while the PTY stays with the guest. Public `Machine`
resources include a sanitized guest status; `Host` and `Profile` omit private
endpoints, certificates and image paths.

`MachineService.SetLabels` replaces the label map synchronously. Forks inherit
source labels and restores inherit checkpoint labels, with request labels
overriding matching keys. `ListMachines` filters on labels.

## Failure summary

| Event | Outcome |
| --- | --- |
| Viewer closes or a network hop fails | The PTY continues; the consumer resumes or restores a snapshot. |
| Controller or host restart | Operations reconcile and routing reconnects. Accepted work is not canceled. |
| RAM fork or restore | PTYs and memory continue; the new binding revokes inherited authentication before access is published. |
| Cold copy, guest reboot or daemon restart | New incarnation; unfinished sessions become `lost`. |
| Slow consumer | That attachment is shed; others and the PTY continue. |
| Lost create reply | Repeat the same create with its original identity and timestamp; never allocate a replacement silently. |
| Lost input or resize acknowledgement | Outcome uncertain; do not replay. |
| Session ends while no one is attached | An `ENDED` opening returns the outcome and final view. |
| Engine digest mismatch | Snapshot decoding is refused; sessions stay alive. |

Tests in `internal/rpctransport`, `internal/rpcidentity` and `internal/guest`
cover authentication, ordering, cancellation and bounded queues.
`protocol/test/public-session.mjs` exercises a deployed public endpoint,
including backpressure and resume.
