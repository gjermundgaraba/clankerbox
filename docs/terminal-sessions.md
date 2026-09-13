# Terminal sessions

Clankerbox terminal sessions are guest-owned PTYs exposed through generated
Connect RPC services. The supported wire contract is
[`clankerbox.v1`](../protocol/clankerbox/v1/session.proto). The session manager's
persisted records remain separate from protobuf DTOs; `internal/guest/protocol`
is an internal domain package, not a second network protocol.

## Services and trust boundaries

```text
Clankerdesk server / application client
  │ MachineService + SessionService, bearer-authenticated HTTP/2
  ▼
clankerbox-server
  │ private HostService, authenticated HTTP/2
  ▼
clankerbox-host (persistent journal, machine admission and guest routing)
  │ private GuestService, mutually authenticated TLS + HTTP/2
  ▼
clankerbox-guest (PTY ownership, Ghostty VT, bounded output ring)
```

Applications address an immutable machine ID. They receive no guest endpoint,
private certificate, host credential or image path. The controller and host relay
the same typed attachment messages; neither interprets terminal bytes or creates
a second terminal state machine. Controller-to-host transport uses its configured
private authenticated endpoint, including a private Unix socket for local development.
Guest readiness comes from the host's observation and authenticated DescribeGuest.

The guest service runs with a privileged management identity and starts terminal
workloads under a separate unprivileged UID. Guest binding files, service keys and
the administrative rebind socket are root-owned. Workloads cannot read those
credentials or invoke rebinding. The guest verifies the host certificate identity;
the host verifies both the guest certificate's machine identity and the requested
machine ID. Same-UID terminal workloads share a guest account and are not mutually
isolated. The public bearer token authorizes workload shell access to prepared
machines; it never grants the workload access to the management identity.

A RAM copy keeps the live session manager, PTY masters, process memory and daemon
incarnation. Before publishing access, host preparation installs a new
machine-scoped binding through the root-only local administrative socket. Rebind
persists the complete binding, invalidates inherited authenticated transports and
changes the admission epoch without restarting the session manager. Cold copies
start another daemon incarnation and convert unfinished manifests to `lost`.

## Generated clients

Go bindings live in `gen/clankerbox/v1` and
`gen/clankerbox/v1/clankerboxv1connect`. The TypeScript package is `@clankerbox/sdk`,
built from `protocol/` with pinned generators and dependencies. See
[the SDK instructions](../protocol/README.md) for reproducible generation and packaging.

Node consumers must use `@connectrpc/connect-node` with `httpVersion: "2"` for
bidirectional attachment. A browser fetch transport cannot carry this duplex
contract. Clankerdesk keeps Connect and its token in the server; its browser
WebSocket carries only the host-owned mirror protocol.

The public services are:

| Service | Methods |
| --- | --- |
| `MachineService` | Host/profile discovery, machine and checkpoint lifecycle, operation inspection, synchronous label replacement. |
| `SessionService` | `DescribeGuest`, `CreateSession`, `ListSessions`, `EndSession`, `AttachSession`. |
| private `HostService` | Typed durable operation submission/status, machine inspection and host description. |
| private mounts of `SessionService` | The same generated session contract at host and guest boundaries, with endpoint-owned authorization. |

## Session ownership and persistence

Each session owns a PTY, child process, authoritative Ghostty VT and bounded output
ring. The default command is the workload shell as a login shell, with `/bin/sh -l`
as fallback. `TERM` is `xterm-256color`. The requested working directory is created
before starting the process. No machine ID is placed in a workload environment:
copied processes would retain their parent's value.

The guest's private state directory holds the daemon lock, binding, administrative
socket and `sessions/<id>/manifest.json`. The lock is the singleton authority.
Manifest publication uses private atomic writes with fsync and directory syncing.
A session ID is durable before its process is published. Once started, it remains
taken even if a later state write fails. Unreadable records are quarantined as
known `lost` IDs rather than permitting a repeated create to spawn another process.
Session children do not inherit management sockets, locks, logs or credentials.

The process states are `starting → running → exited`; `lost` means an unfinished
manifest was recovered without its original owner. Exit code, signal, ending time,
PID and incarnation preserve their distinctions. A sparse quarantined `lost`
record may lack its original grid and metadata. A restarted daemon never signals
an adopted PID based on a persisted number.

On child exit the daemon drains the PTY until EOF or its bounded drain deadline,
then publishes the ordered final session record and captures final screen text and
cursor. The terminal and ring are released. Ended records remain for seven days;
a remembered session still deduplicates an old create. Daemon loss, machine stop
or reboot ends live ownership. Network loss, controller/host restart or closing a
viewer only detaches consumers.

`EndSession` explicitly ends a session: signal the foreground process group when
its session identity matches, then escalate against the child's process group,
with liveness guards and bounded waits. Its unary reply is not a terminal-output
barrier. Consumers finalize their screen from ordered `SessionExited`, or from an
`ENDED` opening after reconnection.

## Creation and typed errors

`CreateSession` includes `machine_id`, caller-minted `session_id`, label, cwd,
argv, env, grid and the caller's original RFC3339Nano `created_at`. Repeating the
same ID and immutable cwd/argv/env returns the same session; changing them is a
conflict. A forgotten create older than 24 hours is expired, and one more than an
hour in the future is invalid. Retention exceeds that retry horizon. Retrying a
lost create reply must preserve its ID, timestamp and immutable arguments.

Typical limits are 48 live sessions, 200 label characters, 4096 cwd characters,
64 environment entries, 2–500 columns and 1–300 rows. Generated optional fields
preserve absent exit codes, signals, ending times and last-resize offsets.

Unary failures use Connect status plus generated `ErrorDetail` with stable
`ErrorReason`, message and retryability. Consumers classify reasons, never parse
diagnostic text. A machine prerequisite refusal is reconciled against its
inspection; stopped machines are not started by attaching. An unavailable
transport does not prove a mutation was refused. Lifecycle mutations return a
durable operation; cancellation of the request does not cancel accepted work.

## Typed bidirectional attachment

An `AttachmentRequest` contains exactly one of `Open`, `Input` or `Resize`.
`Open` must be first and may appear only once. It carries the machine/session IDs,
optional expected engine digest and `ResumeCursor {offset, incarnation}`.
Subsequent controls name this attachment's session implicitly and use strictly
increasing positive `uint64` sequence IDs.

The first `AttachmentEvent` is `Opened`, containing guest description, session,
mode, atomic `cut`, `start_offset`, snapshot length and optional final `View`.
The remaining alternatives are `SnapshotChunk`, `ViewChunk`, `Output`, `Resized`,
`Ack`, `SessionExited` and `Gap`. There are no generic payload envelopes.

Every byte cursor and counter is protobuf `uint64`; generated TypeScript uses
`bigint`, including values above 2^53. Never cast an output offset, resume cursor,
PID or sequence through a JavaScript number. Bounded chunk lengths can be converted
after validating their limit. Protobuf JSON represents 64-bit integers as strings.

### Atomic opening

The session mutex selects the cut, captures the immutable bootstrap prefix and
registers the subscriber. Sending happens outside that mutex: Opened first, then
the prefix before terminal-state events from the live tail. ACKs may interleave
with prefix chunks after Opened; controls retain their admission order. Output at the cut is neither skipped nor
duplicated. A snapshot consumes no output offsets.

| Mode | Contract |
| --- | --- |
| `RESUME` | Incarnation matches, the requested offset is retained, and no resize happened at or after it. `start_offset` is the requested committed cursor; `cut` is the later atomic session offset. Contiguous Output replays `[start_offset, cut)` before live output. |
| `SNAPSHOT` | A running session cannot resume. `snapshot_bytes` announces the exact Ghostty snapshot length; SnapshotChunk completes it, then live output starts at `cut`. |
| `UNAVAILABLE` | The VT cannot currently encode a snapshot, for example after continuation overflow. No subscriber or bootstrap follows. Keep the prior mirror and retry with backoff. |
| `ENDED` | The session is exited or lost. Optional View gives final cursor and UTF-8 byte count, followed by ViewChunk. An absent view differs from a present empty view. Manifest-only records have no invented final screen. No live tail follows. |

Snapshot and view chunks carry bootstrap-local `position`, bytes and `final`.
The next position must equal the received byte count, and `final` must agree with
the announced total. Snapshot size is bounded at 32 MiB; production chunks are
64 KiB and each protobuf message is bounded. Truncation, gaps, contradictory
lengths or invalid snapshot data fail the attachment.

A consumer advances its committed resume cursor only after its parser consumes a
contiguous Output range. It adopts a snapshot's cut only after complete validated
restoration. A partial snapshot leaves its existing mirror and cursor unchanged.
Resume is ready only after replay reaches its cut. To request a fresh snapshot,
omit the resume cursor. Ordered Resized changes the mirror grid at its output
offset; the informational session record is not a substitute for that event.

`DescribeGuest` and `Opened.guest` expose schema `clankerbox.v1`, machine ID,
incarnation, boot ID, daemon version, workload user, engine digest and capacity.
Snapshot consumers supply their expected engine digest and require exact equality.
The guest checks it when supplied; attaching does not require a discovery round-trip. A mismatch is a visible
incompatible state and does not end existing sessions. Installing a new binary
does not hand off live PTYs: explicitly stop/start to replace a daemon after
inspecting any uncertain lifecycle operation.

### Input, replies and bounds

An Input ACK means admission to the bounded PTY writer, not shell execution or
command completion. A lost ACK leaves input uncertain; never replay it on another
attachment. Repeated sequence IDs are refused. Resize ACK means the requested
operation was accepted; the mirror follows ordered Resized. Consumers that need
the updated grid wait for both, allowing either delivery order.

One writer drains caller input and terminal protocol replies without interleaving
an individual entry. Caller input has a 256 KiB admission budget; automatic
replies have a separate 64 KiB reservation. Overflow refuses caller input or
counts dropped replies in `reply_overflow`. The PTY reader never waits for a
consumer. Interrupt is ordinary input, such as Ctrl-C, interpreted by the guest
line discipline or application.

Only the authoritative guest VT emits DA/DSR/CPR and other terminal replies.
Desk/browser mirrors render state and encode deliberate human input; they must
not duplicate automatic replies. Parsing and ring retention continue with zero
viewers. Ghostty keeps bounded scrollback and continuation tracking; the output
ring defaults to 8 MiB.

Each subscriber has an immutable bootstrap prefix separate from its live-tail
budget. The tail is bounded at 8 MiB of output and 1024 items, with bounded send
stall handling. Overflow drops that attachment with best-effort Gap. Relays own
bounded streams and propagate cancellation; disconnect never invokes EndSession.
A clean request half-close stops control admission, drains the finite set of responses
already queued, and detaches. It does not wait for the shell or an unbounded live
tail. Relays close the upstream request direction and receive its clean completion.

Controls can be admitted while a snapshot or resume prefix is being sent. One
bounded event queue carries ACKs and terminal events; a stalled reader eventually
backpressures its own attachment. Clankerdesk keeps user input disabled until its
mirror is ready.

## Host routing and lifecycle barriers

The persistent host admits guest calls only for the owned, prepared, running
machine at its accepted generation, without conflicting source reservations.
Registering a guest lease and publishing journal reservations share a short
admission mutex; native effects run outside it. Unrelated machines remain usable.
Fork/checkpoint reservations revoke existing guest leases before runtime work;
consumers reconnect after admission becomes available. Rebinding copied machine
identity rejects inherited parent sessions without losing PTY ownership.

Guest binary installation and management use the runtime's native privileged
bootstrap channel. Application terminal traffic uses SessionService. A host or
controller restart reconstructs its routing from durable machine/operation state;
the PTY remains with the guest. Public Machine includes a sanitized guest status;
public Host/Profile omit private endpoints, certificates and local image paths.

`MachineService.SetLabels` synchronously replaces a validated label map in its
own transaction. Forks inherit source labels and restores inherit checkpoint
labels, with explicit request labels overriding matching keys. Lifecycle saves
cannot restore an obsolete map. `ListMachines` supports typed label filtering.

## Clankerdesk integration

Configure the desk server with
`CLANKERDESK_CLANKERBOX={"url":"https://CONTROLLER","tokenPath":"/private/token"}`
and machine defaults when allocating machines. It rereads the bearer file for
each call. Neither credentials nor private SDK implementation enter browser or
workspace-process dependencies.

The desk persists its terminal ID, guest session ID, machine ID and canonical
create intent before the network request. Reconnect repeats an unconfirmed create
with its original identity, then opens the session. Copied guest sessions are not
automatically adopted into unrelated canvas resources. Browser view changes do not
allocate machines or terminal sessions.

One attachment owner keeps the mirror, exact bigint cursor and incarnation. It
handles atomic bootstrap and reconnect; the terminal service keeps the catalog,
workspace allocation and browser fanout. Snapshots are applied before publishing
live state. Ended outcomes are recorded from ordered exit or ended opening.
Slow browser viewers have a 16 MiB live-backlog limit with separate credit for
one in-flight bootstrap snapshot. Closing a browser detaches that viewer only.

An ended pending create on an unreachable machine abandons the desk's intent;
a shell already accepted by the guest remains discoverable through ListSessions.
Guest lost records map to ended desk rows with reason `lost`; permanent creation
refusals retain their reason. Engine mismatch uses a slower retry while preserving
existing guest sessions. Desk restart reopens nonfinal catalog entries.

The desk uses a content-named vendored generated SDK tarball and tests actual Node
HTTP/2 handlers with real PTYs. Its Vite+ ready pipeline also drives Chromium
through human typing, MCP input, reload/reconnect, slow viewers and explicit end.
These fixture tests do not establish production deployment or VM qualification.

## Failure and qualification boundaries

| Event | Outcome |
| --- | --- |
| Viewer closes or network hop fails | Guest PTY continues; consumer resumes retained output or restores a snapshot. |
| Controller or host process restarts | Durable operations reconcile; guest routing reconnects. Accepted work is not canceled by its old request context. |
| RAM fork/restore | PTYs and memory continue; new machine binding revokes inherited authentication before access is published. |
| Cold copy, guest reboot or daemon restart | New incarnation; unfinished manifests become lost. |
| Output gap or slow consumer | That attachment is shed; other consumers and the PTY continue. |
| Lost create reply | Repeat the same create ID and immutable intent within its horizon; never allocate a replacement silently. |
| Lost input/resize ACK | Outcome is uncertain; do not replay on reconnect. |
| Guest exits while consumer is away | Ended opening returns retained outcome and available final view. |
| Engine mismatch | Refuse decoding, keep sessions alive, deploy a matching compatibility unit. |

The transport gate records Go-to-Go and actual Node-to-Go HTTP/2 over h2c, Unix
and verified TLS, including duplex operation, cancellation, large chunks,
bounded slow readers and exact bigint values. The separate Caddy gate uses the
actual edge binary on an isolated listener; it does not qualify production-domain
routing. See [RPC gate](archive/real-local/real-local-rpc.md),
[proxy gate](archive/real-local/real-local-proxy.md) and
[real guest identity proof](archive/real-local/real-local-guest.md).
Historical terminal and runtime records retain their original scope. A deployment
must validate its matching guest binaries, image, runtime bundle and consumer SDK.
