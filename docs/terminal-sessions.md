# Terminal sessions

Status as of 2026-09-09: design revision 3 after two independent reviews. The
Clankerbox side (guest daemon, protocol, controller link, endpoints, labels,
events, CLI, host preparation) is implemented with unit and integration tests;
nothing is live-qualified. Clankerdesk is the only consumer.

Clankerbox gains a guest-side daemon that owns terminal sessions inside each
machine, a controller path that exposes those sessions to an authenticated API
caller, and small machine-record additions (labels, guest status, change
notifications). A terminal session survives every network hop, controller
restart, and consumer restart. It ends only when its process exits, when a
caller ends it, or when the guest daemon or machine stops.

## Trust boundary

The terminal key can only reach the session daemon, but the daemon is not a
reduced-privilege account. `session.create` runs arbitrary commands as the
machine's SSH user (`root` on Linux, `admin` on macOS). Anyone holding the
controller bearer token holds shell-equivalent authority over every prepared
machine. Same-user processes inside the guest
are trusted, as elsewhere in Clankerbox.

## Continuity contract

| Item | Contract |
| --- | --- |
| Tolerated events | Consumer restart, consumer-to-controller drop, controller restart, controller-to-guest SSH drop, Linux RAM fork or RAM checkpoint restore, viewer loss. |
| Retained owner | `clankerbox-guest`, one daemon per guest user, holding the PTY, the child process, the authoritative Ghostty VT state, and a bounded output ring. |
| Identity on reattach | `(machine id, session id)` plus the daemon `incarnation`. Authentication is the controller bearer token, then the controller's terminal SSH key into the guest, then a same-user Unix socket with a peer-credential check. |
| Maximum gap | Resume from a byte offset works while the offset is inside the ring (default 8 MiB per session) and no resize happened at or after it. Otherwise the client receives a fresh snapshot. There is no time limit. |
| Replay unit | Raw PTY output bytes with lifetime-monotonic offsets. Snapshots are Ghostty snapshot format v1 from the pinned `ghostty-vt.wasm`; they are never replayed bytes. |
| Lost | Input the consumer had not yet sent when its connection dropped. Output older than the ring for a resumed client. Kitty graphics across a snapshot. Raw history older than the ring is gone, though the VT keeps its own bounded scrollback inside snapshots. |
| Not survivable | Guest daemon exit (the PTY master closes and the shell receives SIGHUP), machine stop, machine delete, guest reboot, macOS disk-only forks and checkpoints. Unfinished records from a dead daemon are listed as `lost`. |
| Split brain | A Linux RAM copy is a machine with a new id whose daemon keeps its incarnation and live sessions. Consumers key sessions by machine id, so both copies resume independently. A cold copy starts a new daemon with a new incarnation; its copied unfinished records become `lost`. |
| Restored form | Live bytes into an unchanged parser, or a complete VT snapshot followed by live bytes from the snapshot offset. Never both for the same range. |

## Components

```text
Clankerdesk host (mirror parser, browsers, MCP)
   │  HTTP/1.1 upgrade "clankerbox-session", bearer token, frames v1
   ▼
clankerbox-server (machine gating, one SSH link per ready machine)
   │  SSH exec channel per stream, forced command, terminal key
   ▼
clankerbox-guest proxy  (stdio ⇄ $HOME/.clankerbox/guest.sock)
   │  Unix socket, same user, SO_PEERCRED / LOCAL_PEERCRED
   ▼
clankerbox-guest daemon (PTYs, Ghostty VT, ring, sessions, activity)
```

The controller bridges upgraded streams without parsing them. It does run a
small protocol client of its own for `session.list`, for the readiness probe
that reads `hello`, and for nothing else.

## Guest daemon

`cmd/clankerbox-guest` is a Go binary built for `linux/amd64` and
`darwin/arm64`. Linux guests have no init system beyond `smolvm-agent`, so the
daemon starts on demand. macOS guests use the same path.

### Singleton and state directory

State lives under `$HOME/.clankerbox/`, created and validated as a private
0700 directory through the existing `statefs` rules:

- `guest.lock`: the daemon-lifetime advisory lock. Holding it is the only
  singleton authority. PID files are diagnostic.
- `guest.sock` (0600): created by the lock holder only, after it removed any
  stale socket. A process that fails to take the lock never touches the socket.
- `daemon.log`: daemon stdout and stderr after detachment.
- `sessions/<id>/manifest.json`: written through `statefs` (private temp file,
  fsync, rename, directory fsync, and the parents synced when the record
  directory is new) before the session is published and on every state
  change. A write that fails once the process runs is logged to
  `daemon.log` and the in-memory record stays authoritative until the daemon
  restarts, after which the on-disk record wins: an unwritten exit comes back
  as `lost`. A record that cannot be read or decoded at startup is logged and
  quarantined: its id stays known as a `lost` session, so a repeated create for
  it is answered rather than run again; an entry whose name is not a session id
  is skipped.

`clankerbox-guest proxy` connects to the socket. On connection failure it runs
`clankerbox-guest daemon` detached in a new session with every inherited
descriptor closed and stdio redirected to the log, then retries the connection
with backoff for up to 10 s. Two concurrent proxies may both spawn a daemon;
the loser fails to take the lock and exits, and both proxies connect to the
winner. The daemon accepts only peers whose UID equals its own, verified with
`SO_PEERCRED` on Linux and `LOCAL_PEERCRED` on macOS; a permission failure is
reported distinctly from an unavailable service.

Session shells never inherit the lock, socket, or log descriptors.

### Session ownership

Each session holds:

- A PTY master set non-blocking and a child started in a new session with the
  PTY as its controlling terminal, `TERM=xterm-256color`,
  `CLANKERBOX_SESSION_ID=<id>`, and the requested `cwd` created with
  `mkdir -p`. Default command is `$SHELL -l`, falling back to `/bin/sh -l`. No
  machine id is placed in the environment because copied processes keep their
  parent's environment.
- The authoritative Ghostty VT: the pinned `ghostty-vt.wasm` executed with
  wazero, one instance per session. `internal/guest/vt` vendors the artifact
  with its provenance; its sha256 is a test-pinned constant and is advertised in
  `hello`. Bounds: 10,000 scrollback lines, 8 MiB scrollback bytes, 8 MiB
  continuation tracking.
- A byte ring (default 8 MiB) with lifetime offsets. `offset` is the number of
  bytes ever produced by the PTY; `retained_from` is the oldest byte still in
  the ring. Offsets never reset for the life of the manifest.
- `last_resize_offset`, or none when the session was never resized.
- Subscribers (attached streams). Each has an immutable bootstrap prefix
  (snapshot bytes or a ring slice copied at the cut) written outside the session
  mutex, and a separately bounded live tail queue (8 MiB) with a 60 s stall
  clock. A subscriber whose tail overflows or stalls is dropped with a
  best-effort `gap` event; the PTY reader never waits for a viewer.
- One PTY writer goroutine draining one FIFO of entries. Each entry is either
  one caller input or one protocol reply, admitted in arrival order, and is
  written completely (through any partial writes) before the next entry
  starts, so no reply ever lands inside a paste or escape sequence and neither
  source can starve the other. Admission budgets are separate: 256 KiB for
  caller input and 64 KiB reserved for replies. The writer never holds the
  session mutex. Callers whose input does not fit are refused; a reply that
  does not fit is dropped and counted in `reply_overflow`, published in the
  session record so the loss is visible. An application waiting for a dropped
  reply may hang; the count is the diagnostic.

The PTY reader loop reads at most 64 KiB per iteration and, under the session
mutex, feeds the VT, appends to the ring, and enqueues to subscriber tails.
Because the VT and the ring advance under one mutex, "snapshot at offset N" is
exact. Protocol replies (DA, DSR, CPR, mode reports, XTVERSION) come from the
guest VT's write-to-PTY callback, which only copies bytes into the reply queue
and never re-enters the VT or takes the session mutex. Replies happen once,
inside the machine, independent of viewers.

Zero viewers change nothing: parsing, ring, and activity continue.

### Process state machine

`starting → running → exited`, with `lost` as the restart conversion for
records that were not finished when a previous daemon died.

- `starting`: the manifest is durably written; the child is being spawned. If
  spawning fails before the child exists the manifest is removed and the
  request fails; once the child runs, its id stays taken whatever a later
  write does.
- `running`: the child is alive. The daemon owns it and reaps it with `wait`.
- `exited`: the child was reaped. The record carries `exit_code` for a normal
  exit or `signal` for signal termination; neither is fabricated from PTY EOF.
  After the wait, the daemon drains the PTY for at most 2 s or until EOF, then
  publishes the final `session` event carrying the final `offset`. Descendants
  that keep the PTY slave open past the drain are left alone. The final screen
  text and cursor are captured once at exit and the terminal and the output
  ring are released: an ended session costs its record and that text, not a VT
  instance, and nothing resumes an ended session.
- `lost`: a copied or restarted daemon found an unfinished manifest. Its pid is
  never signalled during cleanup. Daemon loss means ownership loss, not proven
  death of every descendant.

`session.end` sends SIGHUP to the foreground process group when its session id
equals the child's session id, waits 500 ms, then SIGTERM and SIGKILL to the
child's own process group with the same wait, each step guarded by a liveness
check on pid plus kernel start time plus boot id. The PTY closes after the
child is reaped. Ended records are retained until the daemon prunes records
older than 7 days. `session.open` on an `exited` session answers `ended` with
the final screen as `view` while the daemon that owned it is alive; on a
manifest-only record (after a daemon restart) or a `lost` session it answers
`ended` with the known status and no `view`, never an invented screen.
Retention applies equally to sessions the running daemon owned and to records
adopted from earlier daemons. A repeated `session.create` with the same id is a
conflict unless cwd, argv, and env match, and a create the daemon does not
remember is refused as `expired` once its `created_at` is older than 24 h.
Retention is longer than that horizon, so a session this daemon ran is still
remembered when its create expires and a repeated create never starts a second
process.

### Activity

Every session carries `activity: {state, source, since}` with
`state ∈ idle | working | attention | unknown | exited` and daemon-owned
`source ∈ hook | process | none`. Observations are advisory.

- A hook report owns the state for 300 s after the last report.
- Below that, process observation reads the PTY foreground process group. A
  shell in the foreground is `idle`. Every other foreground process is
  `unknown`, regardless of its name or output. Applications can report
  `working` or `attention` explicitly through the generic hook.
- Process exit sets `exited` immediately, overriding a hook TTL.

Hooks report through `clankerbox-guest report <state>` inside the guest, which
reads `CLANKERBOX_SESSION_ID` from the environment and sends `session.report`.
It reports hook state only; ranking is the daemon's. OSC progress and
notification signals are a later source.

## Wire protocol, revision 2

One framed byte stream, carrier independent. Consumers speak it to the guest
through the controller; the guest proxy speaks it over stdio; the daemon speaks
it over the Unix socket.

```text
frame := u32 BE length | u8 kind | body        length counts kind + body, ≥ 1
kind 0x01 REQUEST        JSON request envelope
kind 0x02 RESPONSE       JSON response envelope
kind 0x03 EVENT          JSON event envelope
kind 0x10 OUTPUT         u64 BE next_offset | bytes, bytes non-empty
kind 0x12 SNAPSHOT_DATA  bytes of the snapshot or final view announced by an open reply
```

Maximum frame length is 1 MiB. A frame beyond it, a zero-length frame, an
unknown kind, a binary body shorter than its fixed header, or invalid JSON
closes the connection. Unknown JSON fields are ignored. Offsets are `u64` on
the binary wire and JSON numbers in envelopes; both sides reject offsets above
2^53 − 1 so JSON consumers never lose precision.

Envelopes:

```json
{"request_id": 1, "op": "session.input", "args": {"session_id": "…", "data": "…"}}
{"request_id": 1, "ok": true, "value": {"status": "accepted"}}
{"request_id": 1, "ok": false, "error": {"code": "not_running", "message": "…", "retryable": false}}
{"event": "output_gap", "session_id": "…", "reason": "stalled"}
```

`request_id` is a caller-chosen positive integer, unique per connection.
Requests on one connection are answered in any order. Refusals that are part of
an operation's normal outcome (input status) are successful typed values;
`error` is reserved for requests that could not be applied.

The daemon sends a `hello` event first on every connection:

```json
{"event": "hello", "protocol": 2,
 "incarnation": "<uuid>", "boot_id": "<id>", "daemon_version": "…",
 "os": "linux", "user": "root", "wasm_sha256": "93fb…", "max_sessions": 48}
```

There is one supported wire revision. Every consumer compares `protocol` for
equality and treats any other value as `incompatible`; any change to an
operation, value, event, or bound is a new revision, and all bindings move
together. Consumers that decode snapshots also require `wasm_sha256` equality
with their own artifact and otherwise enter a visible `incompatible` state
instead of retrying. The deployable compatibility unit is therefore the wire
revision plus the engine artifact.

### Session object

```json
{"id": "<uuid>", "label": "…", "cwd": "/root", "argv": ["/bin/bash", "-l"],
 "cols": 80, "rows": 24, "status": "running", "exit_code": null, "signal": null,
 "pid": 1234, "created_at": "…", "ended_at": null,
 "offset": 10240, "retained_from": 0, "last_resize_offset": null,
 "incarnation": "<uuid>", "reply_overflow": 0,
 "activity": {"state": "unknown", "source": "process", "since": "…"},
 "foreground": {"pid": 1300, "command": "python3"}}
```

### Operations

| Op | Args | Value |
| --- | --- | --- |
| `session.create` | `session_id` (caller-minted UUID), `label?` ≤ 200, `cwd?` ≤ 4096, `argv?`, `env?` ≤ 64 entries, `cols` 2–500, `rows` 1–300, `created_at` (RFC 3339, when the caller decided to create) | `{session}` |
| `session.list` | | `{sessions}` |
| `session.open` | `session_id`, `from_offset?`, `from_incarnation?` | `{mode, offset, session, snapshot_bytes?, view?}`; modes `resume` and `snapshot` are followed by stream frames on this connection, including ordered `session` events for this session's activity, foreground, and exit; `ended` with a view is followed by the view's text bytes; `unavailable` is complete |
| `session.input` | `session_id`, `data` base64 ≤ 256 KiB decoded | `{status: accepted \| refused, reason?}` |
| `session.resize` | `session_id`, `cols`, `rows` | `{session}` |
| `session.end` | `session_id` | `{session}` |
| `session.report` | `session_id`, `state ∈ idle, working, attention` | `{}` |

Error codes: `not_found`, `not_running`, `invalid`, `too_large`, `conflict`,
`already_attached`, `capacity`, `expired`, `internal`. Only `capacity` is
retryable.
Every operation names its session; none depends on the connection having
opened one. Interrupting a command is input: the consumer writes the byte a
terminal would, and the line discipline or the raw-mode program handles it
exactly as it would for a keyboard.

`session.create` is idempotent on `session_id`: a repeat with identical
immutable arguments (`cwd`, `argv`, `env`) returns the existing session; a
repeat with different arguments fails with `conflict`, so a lost reply is
recovered by repeating the same create. The repeat is bounded by `created_at`:
a create the daemon does not remember that is older than the 24 h horizon
fails with `expired` and is never started, and ended sessions are remembered
for longer than that, so a consumer that keeps repeating a create gets either
the session it started or a refusal, never a second process. A create dated
more than 1 h ahead of the daemon's clock is refused as `invalid`, so the
horizon holds across clock skew.

### Open and resume

Opening is one operation whose reply is the whole bootstrap description, so a
consumer never combines several observations. One connection carries at most
one open session; a second open on a connection that streams fails with
`already_attached`. The daemon chooses the mode:

- `resume` when the session runs, `from_incarnation` equals the daemon
  incarnation, `retained_from ≤ from_offset ≤ offset`, and `last_resize_offset`
  is absent or strictly below `from_offset`. The reply carries `offset =
  from_offset`. The bootstrap prefix is the ring slice `[from_offset, offset)`
  copied at the cut.
- `snapshot` when the session runs and cannot resume. The reply carries the
  current `offset` and `snapshot_bytes`; the prefix is that many bytes of
  SNAPSHOT_DATA frames.
- `unavailable` when the session runs but the VT cannot encode because its
  continuation tracking overflowed. The reply is complete, with no stream and
  no subscriber; the connection stays usable and may open again. The consumer
  keeps its existing mirror unchanged and retries with backoff while the
  session runs.
- `ended` when the session is `exited` or `lost`. The reply carries the final
  record and, while this daemon still holds the terminal, `view: {cursor,
  bytes}`, followed by `bytes` of SNAPSHOT_DATA frames carrying the final
  screen text as UTF-8, so no screen is too large for the frame bound; a
  record adopted from an earlier daemon has no view. No live stream follows
  and the connection stays usable. JSON bodies are written without HTML
  escaping.

The cut happens under the session mutex at `cut_offset`: capture it, copy the
prefix (the ring slice `[from_offset, cut_offset)` or the snapshot), register
the subscriber. The reply is written before the prefix, then the prefix outside
the mutex, followed by the tail queue, whose first OUTPUT frame starts at
`cut_offset`. No byte is delivered twice or skipped, and a snapshot consumes no
offsets. `snapshot_bytes` never exceeds 32 MiB; a consumer rejects a larger
announcement, a truncated prefix, or a snapshot that fails validation by
closing the connection, keeping its committed mirror and cursor unchanged, and
opening again later.

Ordered `resize` events `{session_id, cols, rows, offset}` are placed in the
tail at the point where the guest applied them. This event, not the
informational `session` event, is what a mirror uses to change its grid.

Consumer commit rule: a consumer advances its resume cursor only after its
parser consumed a contiguous OUTPUT range, and adopts a snapshot offset only
after complete, validated restoration. Partial frames change nothing. A
consumer that wants a fresh snapshot omits `from_offset`.

### Input

Input is admission, nothing more. Under the session mutex the daemon admits the
bytes to the input queue or refuses them with a reason (`not_running`,
`queue_full`). There is no input identity and no duplicate suppression: a lost
response is an unknown outcome surfaced to the caller, never replayed
automatically, and a viewport read is diagnostic, not proof.

`accepted` means the bytes entered the queue. They may reach the PTY after the
consumer's connection is gone, or partially if the child exits mid-write.
Unwritten input is discarded when the session ends. Encoding is the consumer's
job: the guest writes bytes as given.

### Resize

Last writer wins. Under the session mutex the daemon resizes the PTY first;
if that fails nothing changed and the request fails with `internal`. Only
then does it resize the VT, record `last_resize_offset = offset`, and enqueue
the ordered `resize` event to every tail. VT resize cannot fail for a valid
grid; if it ever does, the PTY is resized back to the previous size, which is
stateless, and the request fails with `internal` while VT state is untouched.

### Conformance

`protocol/conformance.json` lists encoded frames as hex with their decoded
form, including invalid frames and their rejection reason; the Go codec test
replays it. `protocol/messages.json` is written by the Go test suite
(`UPDATE_FIXTURES=1`) and holds one example of every request, reply mode,
event, and error exactly as this build encodes them. Clankerdesk vendors a copy
and decodes every entry through its typed operation table, so a shape change
that is not mirrored there fails its tests; both files carry the revision.
Codec fixtures do not prove parser parity: the Go tests exercise real PTYs, and
a Go-produced snapshot fixture is restored by Clankerdesk's terminal-core tests.

## Controller

### Terminal key and guest link

The controller owns an Ed25519 terminal key created by `statefs` in its state
directory on first start. Machine preparation
installs its public key in the guest user's `authorized_keys` as

```text
restrict,command="/usr/local/bin/clankerbox-guest proxy" ssh-ed25519 … clankerbox-terminal
```

Preparation installs only the managed terminal key, replacing guest login access. The forced command ignores the requested command; PTY,
forwarding, and agent requests are denied by `restrict`. Generated sshd
configuration sets `MaxSessions 64` so the link can carry up to 48 session
streams plus control channels.

`guestLink` is the controller registry for session connections, using the
eligibility rule: prepared, running, accepted
generation, fresh observation, not suspended, and no pending or unresolved
source reservation (`sourceIdle`). Links are cancelled and awaited before a
fork or checkpoint is dispatched. Reconciliation runs every 3 s. The link uses
`transport.Connect` and `ssh.NewClientConn` with the pinned guest host key,
reads the daemon `hello` through one probe channel with a 10 s deadline before
it is `ready`, then repeats that probe every 15 s with a 45 s deadline as its
keepalive, refreshing the cached hello so a daemon-only restart or an
incompatible daemon changes the machine view and invalidates subscribers. A
session stream is one SSH `session` channel with `exec` on that connection. The
controller admits at most 48 attachment streams per link and answers `capacity`
beyond that; short-lived control streams such as `session.list` are not counted. Streams die with the link; consumers resume through the
protocol.

### Endpoints

- `GET /v1/machines/{id}/sessions/stream` with `Connection: Upgrade` and
  `Upgrade: clankerbox-session`. Requires a prepared running machine at the accepted generation, with fresh
  observation and no pending source reservation. 503 with
  the link status as the code (`guest_connecting`, `guest_suspended`,
  `guest_incompatible`, `guest_unreachable`, `guest_unavailable`) and the
  link's reason as the message when the link is not ready, so a consumer can
  tell a deployment problem from a link that is still coming up; 429
  `capacity` when the link is full. On success the raw frame stream is bridged; the first
  bytes the caller reads are the daemon `hello`.
- `GET /v1/machines/{id}/sessions` runs `session.list` over a control channel.
- `GET /v1/machines/{id}` gains `guest: {status ∈ ready | connecting |
  suspended | incompatible | unreachable | unavailable, incarnation?, protocol?,
  daemon_version?, wasm_sha256?, reason?}`. `ready`
  means a successful `hello`. These are materialized views of in-memory state
  and are included in machine change notifications.
- `POST /v1/machines/{id}/labels` with `{"labels": {...}}` replaces the label
  map (keys and values ≤ 64 printable characters, ≤ 32 entries, `{}` clears).
  Labels ride in the machine body and the replacement runs under the
  controller's machine mutex in its own transaction, so a lifecycle save of a
  stale in-memory record cannot restore old labels. `CreateInput` and `ChildInput` accept
  `labels`; a fork inherits the source labels and a restore inherits the labels
  recorded on the checkpoint at capture time (`{}` for older checkpoints) unless
  the request adds to or overrides them; request labels never clear inherited
  ones. `GET /v1/machines?label=k=v` requires every repeated pair to match a
  present label.
- `GET /v1/events` is a server-sent-event stream of change notifications:
  `{"type": "machine", "id"}` and `{"type": "operation", "id"}` after the
  corresponding transaction committed or the machine's guest/auth link view
  changed, plus `{"type": "reset"}` as the first
  message so a subscriber refetches inventory after subscribing. Events carry
  ids only; consumers refetch. Subscribers are bounded; an overflowing
  subscriber is closed and must resubscribe. Heartbeats every 15 s keep the
  connection past the server idle timeout.

### Guest binary delivery

`clankerbox-guest` binaries for both guest platforms are deployed next to the
host helper under the host `Root` (`guest/clankerbox-guest-<os>-<arch>`). The
host gains one runtime operation, "install guest", that runs a fixed installer
command through the trusted exec channel with the binary on stdin, on every
Linux and macOS path. The installer validates size and sha256 against values
passed in the command, writes a temporary file in `/usr/local/bin`, sets mode
0755 and root ownership (`sudo -n` on macOS), and renames atomically. A running
daemon keeps executing the old inode; it is never killed by installation.
Preparation runs the installer only when the installed hash differs, on new and
existing machines alike, and never starts a stopped machine to do so.

Replacing a daemon ends its sessions until descriptor handoff exists. A new
consumer build that requires a newer `wasm_sha256` therefore refuses old
daemons with `incompatible` and leaves them running; ending them is an explicit
operator action: send `SIGTERM` to the pid in `$HOME/.clankerbox/daemon.pid`
inside the guest, or restart the machine.

### CLI

`clankerbox sessions MACHINE` lists sessions. `clankerbox labels MACHINE k=v …`
sets labels. `clankerbox events` prints the change stream. No interactive
terminal client is added.

## Clankerdesk

- `CLANKERDESK_CLANKERBOX={"url":"https://…","tokenPath":"/private/token"}`
  replaces `CLANKERDESK_SSH`. `startServer({clankerbox})` takes the same shape.
- Identity: the Clankerdesk `TerminalId` stays an independent UUID. The catalog
  maps it to `(machineId, guestSessionId)` with a unique constraint on the pair.
  The catalog row is written in state `pending` with the canonical create
  arguments before `session.create` is sent. A lost reply is recovered by
  repeating the identical idempotent create, serialized per id, never by
  inspecting alone, and a `pending` row is never finalized from an inventory
  read. The persisted create carries the row's creation time as `created_at`,
  and an `expired` refusal finalizes the row with that reason. A `pending`
  row has three exits: confirmed by the guest, refused by the guest, or
  abandoned by the desk. `terminal.end` on a `pending` row whose machine
  cannot be reached abandons the intent (reason `abandoned`) instead of
  waiting for a link that may never come, dropping a handshake in flight so
  the create is never sent; a shell the guest may have started before is
  untracked and stays visible in `session.list`. A machine the
  controller does not have (`not_found` at the stream) finalizes the row like
  a deleted machine, and binding checks that the machine exists first.
  Copied sessions in a forked machine are not adopted automatically; an
  explicit `terminal.adopt` operation is later work. Rebinding a workspace's
  machine never retargets existing terminals.
- Each workspace binds one machine (`workspace_machines` table).
  `terminal.create` accepts an optional `machineId` and otherwise uses the
  workspace machine. `cwd` is absolute inside the guest or relative to the guest
  user's home; the default is `~/workspace` when it exists, else the home.
- Per live session the host keeps one guest stream with a reconnect loop
  (0.5 s to 10 s backoff), owned by an attachment module that holds the
  mirror, the committed offset and incarnation, and the link. It opens with
  the committed offset and incarnation, or without an offset when the mirror
  is fresh, and applies the open reply in wire order before any later frame.
  On `resume` it feeds bytes into the unchanged mirror; on `snapshot` it
  restores the mirror after complete validation and pushes a fresh `0x00`
  frame to every attached browser; on `unavailable` it keeps the mirror and
  retries every 2 s; on `ended` it records the outcome and the view, or the
  mirror's own screen when there is none. The catalog finalizes a terminal
  only from the ordered exit `session` event on its stream or from an ended
  open; the `session.end` reply is answered to the caller but never applied,
  so the recorded screen always holds the last output whatever order the
  daemon's control and stream writers took. Only the ordered `resize` event
  changes the mirror grid and the browsers' grid, serialized with output on
  each browser socket.
- Before attaching, the host compares `hello.wasm_sha256` with its own
  terminal-core digest. A mismatch puts the session into `disconnected` with
  reason `incompatible` and retries only every 60 s; the controller's
  `guest_incompatible` refusal is treated the same way, and its other
  `guest_*` codes set the reason to the link status with the normal backoff.
  Every wait a workspace worker can observe fits the supervisor's 30 s request
  bound, which exceeds the longest composed operation (a terminal create and
  its compensating end): controller calls time out after 5 s (at most three
  attempts for a mutation), the stream upgrade (wall-clock, including a refusal's body, which
  settles even when it ends early) and the hello after 10 s, and a guest reply
  or the next announced bootstrap bytes after 15 s, which closes the link so
  the reconnect loop takes over; `terminal.create` answers after its first
  attempt or after 10 s with the row as it stands. A finalized session whose
  catalog write fails keeps its owner, whose mirror still answers reads, and
  the write is tried again every 5 s. A browser announces the
  digest of the WASM it actually loaded in its first attachment message; the
  host refuses a mismatch with a close code that makes the client reload, so a
  page opened before a deployment never decodes a newer snapshot.
- The mirror installs no external reply sink; the wrapper's internal
  write-to-PTY callback serves only paste encoding.
- Status mapping: guest `starting`, `running` → `running`; guest `exited` →
  `exited` with exit code or signal; guest `lost` → `exited` without a code;
  link down or `unavailable` while the machine runs → `disconnected` with a
  reason: `link` for transport failures, the controller's code for a refusal
  (the link status for `guest_*`, else the code itself such as `capacity`),
  and `machine <state>` for a prerequisite refusal such as a stopped machine;
  a `lost` record ends the row with reason `lost`. Browsers keep their view
  during `disconnected` and resume when the host resyncs.
- Host restart reconciles every non-final catalog row (`pending`, `running`,
  and `disconnected`) by opening it: `pending` → repeat the create, then open;
  running → a fresh snapshot; `ended` → store the outcome with the view when
  present; `not_found` → `exited` without a code and no screen.
- A `machines` host capability in the SDK owns the controller client; the
  workspace binding (which machine new terminals start on) is the terminal
  capability's setting, so the machine service needs no terminal engine.
  Every mutation is submitted under one idempotency key per
  call; the desk repeats the identical request under that key a bounded number
  of times when the transport fails without a controller answer, so the
  accepted operation is recovered rather than duplicated. Beyond that a lost
  reply is resolved by listing machines (live names are unique and
  desk-created machines carry the workspace label) or by reading the operation
  whose id the card keeps. The `clankerbox` extension shows machines as canvas
  shapes with state, observation health, and activity and exposes
  `machines.list`, `machines.create`, `machines.fork`, `machines.start`,
  `machines.stop`, `machines.delete`, and `clankerbox.bind`, which calls the
  terminal capability. Machine shapes show machine state only; activity stays
  on terminal shapes in v1.
  Cards poll inspection through the desk, which coalesces concurrent and
  recent inspections per machine; the desk does not consume `/v1/events`.
- `ssh2` and `node-pty` leave the server. Tests use an in-process fake
  controller plus a fake guest daemon written against the conformance fixture,
  and terminal-core restores a Go-produced snapshot fixture.

## Failure matrix

| Event | Effect |
| --- | --- |
| Browser tab closes | Nothing. |
| Desk host loses the controller | Session keeps running. Desk marks `disconnected`, reconnect loop, resume or snapshot. |
| Controller restarts | Links re-establish on reconcile; desk resumes. |
| Guest SSH link drops | Same as above. |
| Linux RAM fork or restore | Link suspended for the copy; desk resumes afterwards. The child machine carries live copies of the sessions under a new machine id. |
| macOS disk fork or restore, reboot | New daemon incarnation; copied unfinished records are `lost`. |
| Slow desk | Guest drops that subscriber; desk reattaches with snapshot. |
| Snapshot larger than the tail queue, continuation overflow | Prefix streams outside the live queue; `unavailable` is a typed open outcome with bounded retry. |
| Large paste while the child floods output | Reader and writer progress independently; replies have reserved capacity; overflow is counted, never a deadlock. |
| Guest exits while desk is disconnected | Reconciliation records the exit outcome; never invented success or permanent `disconnected`. |
| Desk away for longer than a day with a pending create | The guest refuses the stale create as `expired` and the row is finalized with that reason; a remembered session answers instead. Never a second process. |
| Pending create on a machine that cannot be reached | `terminal.end` abandons it with reason `abandoned`; a shell the guest may have started stays in `session.list`. |
| Desk restart after persisting `disconnected` | Reconciled like `running`; fresh snapshot. |
| Old daemon, new desk | `incompatible`, sessions untouched. |
| Guest daemon dies | Shells receive SIGHUP; sessions listed as `lost` on the next daemon start. |
| Machine stop | Everything ends; sessions `lost`. |

## Later

- Daemon upgrade without ending sessions: PTY descriptor handoff between daemon
  generations, plus an on-disk journal so the ring survives.
- Explicit adoption of copied or externally created sessions into a workspace.
- Additional activity sources: OSC 9;4 progress, OSC 777 notifications, and
  Ghostty shell-integration prompt marks, which also enable last-command reads.
- TCP streams into the guest through the same link for browsers and MCP servers.
- Read-only attachments and history range reads.

## Verification

- Go unit tests, external packages, real PTYs on Linux and macOS: frame codec
  against the conformance fixture; ring offsets and eviction; attach modes and
  exactly-once delivery under concurrent output; drops at every attach boundary;
  two resizes at one offset; input admission and refusal after exit; large paste
  during output flood; reply overflow accounting; pid and start-time guard;
  process teardown and final drain; concurrent first proxies; stale socket;
  activity ranking with process exit override; the stale-create refusal with
  the horizon inside retention; terminal and ring release at exit with the
  view retained; logged record write failures and skipped records.
- Controller tests: link lifecycle exercised with the
  fake SSH guest, including source reservations and capacity; stream upgrade
  bridging; labels and inheritance; change notifications; guest status.
- Clankerdesk tests: the existing terminal suites against the fake controller
  and guest; lost create reply; restart after `disconnected`; browser opened
  during an outage; incompatible daemon; an end reply overtaking the stream's
  tail; abandoned and expired creates; unknown machines at bind and create;
  the controller's `guest_incompatible` refusal; a paused viewer under a
  snapshot larger than the live backlog limit; a guest that answers hello and
  nothing else; the browser acceptance test unchanged in intent.
- Live check on the private controller: create machine, open two browsers,
  kill the desk host, restart the controller, fork the machine, and verify each
  row of the failure matrix. Recorded in `docs/implementation-execution.md`.
