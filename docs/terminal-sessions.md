# Terminal sessions

Terminal sessions are guest-owned PTYs exposed through the generated
`SessionService` in [session.proto](../protocol/clankerbox/v1/session.proto).
The controller and host relay attachment messages without interpreting terminal
bytes; only the guest holds terminal state. A [pipe session](#pipe-sessions)
runs a command on the same API without a PTY, and
[`clankerbox shell`](#the-cli) is a client of both.

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

The guest daemon requires root on Linux and macOS; the session manager inherits
the daemon's account for child processes. There is no workload-user setting or
privilege boundary inside a guest: workloads can read machine binding keys,
reach the admin socket and modify guest state. Treat
a machine and its fork/checkpoint descendants as one trust lineage, since copies
inherit disk contents and RAM copies also inherit process memory and secrets.

The guest verifies the host certificate; the host verifies the guest
certificate's machine identity against the requested machine. Rebinding gives
a copy its own routing identity, but does not erase inherited secrets or make
it safe for a less-trusted tenant. Host/controller credentials and files remain
outside the guest, and private machine storage must never share writable backing
with another machine. The public bearer token grants root shell access to its
machines; it does not grant host or controller authority.

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
| `ProfileService` | Recipe uploads, builds, logs, cancellation, bases and revision management. |
| `MachineService` | Host and profile discovery, machine and checkpoint lifecycle, operation inspection, label replacement. |
| `SessionService` | `DescribeGuest`, `ListSessions`, `EndSession`, `AttachSession`, which also creates sessions. |
| `HostService` (private) | Operation submission and status, machine inspection, host description. |

`SessionService` is mounted on controller, host and guest with the same schema
and endpoint-specific authorization.

## Session lifecycle

Each session owns a PTY, a child process, a Ghostty VT and a bounded output
ring. The default command is `/bin/sh -l`. The process gets a fixed
environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL=/bin/sh`,
`TERM=xterm-256color`, `LANG=C.UTF-8`) followed by the caller's `env` entries,
which win for duplicate keys. The default identity is `USER=LOGNAME=root` and
`HOME` comes from root's account record; supported images use `/root` on Linux
and `/var/root` on macOS. An empty cwd means that root home, a relative cwd is
resolved against it, and the directory must already exist. The machine
ID is not placed in the environment, because forked processes would keep the
parent's value.

Session state lives under the guest's private state directory as
`sessions/<id>/manifest.json`, written atomically with fsync. A session ID is
durable before its process is published and stays taken even if a later write
fails. Unreadable records become known `lost` IDs so a repeated create cannot
spawn a second process. Children inherit no management socket or lock descriptors, or daemon-only
environment entries; guest root can still read on-disk credentials.

States are `starting`, `running`, `exited` and `lost`. Exit code, signal, end
time, PID and incarnation are recorded separately. On child exit the daemon
drains the output to its end, publishes the final record with the final screen
text and cursor, and releases the terminal. A descendant that keeps the output
open cannot hold the session: output that stays idle for two seconds is closed.
Output a consumer is still working through is not idle, however slow the
consumer. Ended records are
retained for a week and still deduplicate a repeated create. Daemon loss,
machine stop or reboot ends live ownership; network loss, controller or host
restart, or closing a viewer only detaches consumers, unless the session was
created with `end_on_detach`.

`end_on_detach` makes the guest end the session when its last attachment
closes, whatever closed it: a clean detach, a killed client, or a connection
that a relay or the transport's keepalive declares dead. The guest owns this
lifetime, so it holds when the client cannot run any cleanup.

`EndSession` signals the foreground process group, then escalates against the
child's process group with bounded waits. Its reply is not an output barrier:
consumers finalize their screen from the ordered `SessionExited` event or from
an `ENDED` opening after reconnecting.

## Creating sessions

A session is created by the attachment that opens it: `Open.create` carries the
label, cwd, argv, env, grid and the caller's RFC 3339 `created_at`, under the
`Open`'s machine ID and caller-minted session ID. The guest registers the
subscriber and then starts the process, so the opening is `RESUME` from offset
zero with nothing to replay and no output, however brief the command, can
precede its first reader. No resume cursor or `DescribeGuest` round trip is
needed. There is no way to start a process nobody is attached to; a consumer
that wants one detaches once the session is open.

Repeating the same ID with the same cwd, argv, env and options opens the session
that exists, for as long as its record does; changing them is a conflict. Only a
create the guest never started is subject to the horizon: one older than a day
is expired and one more than an hour in the future is invalid. A client that
lost the reply therefore repeats its `Open` with the original identity and
timestamp and, for a retained range, its cursor.

Failures return a Connect status plus an `ErrorDetail` with a stable
`ErrorReason` and retryable flag. Classify on the reason, not the message. A
prerequisite refusal means the machine is not ready for sessions: not running
at its accepted generation, not prepared, or deleted. Attaching never starts a
machine. An unavailable transport does not prove a mutation was refused.

### Pipe sessions

`create.pipes` runs the command with stdin, stdout and stderr as pipes: no PTY,
no VT, no grid (`cols` and `rows` must be zero) and no `TERM`. It is the mode
for programs that consume or produce data. `Output.stream` marks stderr;
stdout leaves it unspecified. `Input` writes to stdin with no size limit across
controls, and bytes pass unmodified in both directions. `CloseInput` delivers
end of input after the input queued before it. It is final: repeating it changes
nothing, and an `Input` after it is refused as `input_closed`. Its input admission budget is
4 MiB instead of a terminal's 256 KiB, so a consumer sending ahead keeps the
pipe busy across a round trip.

A pipe session retains nothing, which shapes the rest of its contract: it
implies `end_on_detach` and refuses a second attachment, a resume and `Resize`.
Because there is nothing to resume from, its consumer is never dropped with a
`Gap`: a full tail holds the guest's reader, and through the pipe the process,
until the consumer catches up. That covers everything up to and including
`SessionExited`, also when the process has already exited with output still in
the pipe. The transport's stall limit still applies: a consumer that accepts
nothing for 30 seconds is cut off like any other stalled stream, which ends the
session.

## Attachment

An `AttachmentRequest` is exactly one of `Open`, `Input`, `Resize` or
`CloseInput`. `Open` comes first and only once, with the machine and session
IDs, an optional expected engine digest, an optional
`ResumeCursor {offset, incarnation}`, optional [create arguments](#creating-sessions)
and the [terminal options](#queries-and-real-terminals) below. Later controls
use strictly increasing positive sequence IDs.

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
incarnation, boot ID, daemon version, session user (`root`), engine digest and capacity.
A consumer that decodes snapshots supplies its expected engine digest; a
mismatch is reported without ending sessions. A consumer that names no digest
accepts whatever engine the guest runs, and must not decode a snapshot. The guest binary belongs to the
prepared image; changing it requires a new image/bundle and is not a live PTY
handoff. Retained starts do not install binaries.

### Queries and real terminals

Programs ask their terminal questions: device attributes, cursor position,
colours, keyboard protocol. Measured at startup in a guest: plain shells, `less`
and `top` ask nothing; `fish`, `vim`, `nvim`, `tmux`, `claude` and `codex` ask
five to eleven each. The guest VT answers them on the PTY, at once and with
nobody attached, and it is the only responder.

A mirror renders cells and never shows those bytes to a terminal. A consumer
that writes output straight into a real terminal does, and that terminal would
answer too: the program receives a second reply, late, as if typed. Two `Open`
fields make such a consumer safe without a second responder:

- `omit_answered_queries` removes from this attachment's output exactly the
  escape sequences the guest VT answered. Nothing lists what a query is: the
  guest finds sequence boundaries, writes each terminating byte to the engine
  alone and omits a sequence when the engine replied during that write, so the
  set follows the pinned engine. A sequence longer than 4 KiB is passed through
  as it arrives. Queries the guest does not answer still reach the terminal,
  which answers them alone. Offsets stay in unfiltered coordinates:
  `next_offset` may advance by more than `data` carries, and it is still the
  cursor to resume from. A filtered resume replays the retained range without
  the omitted sequences.
- `terminal_profile` gives the attached terminal's default foreground and
  background colours as `0xRRGGBB`. The guest VT answers colour
  queries with them, so a program picks colours for the screen the user sees
  rather than the guest's built-in dark theme. The latest attachment to supply
  a profile decides; a mirror attached at the same time does not see the change
  until its next snapshot.

### Input and replies

An `Input` acknowledgement means the bytes were admitted to the bounded
writer, not that the program read them. Repeated sequence IDs are refused. A
`Resize` acknowledgement means the request was accepted; the mirror follows the
ordered `Resized` event, which may arrive before or after the acknowledgement.

Every `Input` names `offset`, the number of input bytes the guest has accepted
from this attachment, and the guest refuses an `Input` at any other offset as
`out_of_order`. Every acknowledgement reports that count as `input_offset`. Two
things follow. A consumer can send ahead of acknowledgements instead of paying a
round trip per `Input`: if one is refused for lack of room, everything sent
behind it is at the wrong offset and refused too, so later bytes never overtake
earlier ones, and the consumer continues from `input_offset` once its
outstanding acknowledgements have arrived. And an `Input` repeated after a lost
acknowledgement is safe on the same attachment: if the original was accepted,
the repeat is at a stale offset and is refused rather than applied twice. The
count belongs to the attachment, so never carry unacknowledged input over to
another one. A consumer that prefers to drop refused input simply sends its next
bytes at `input_offset`.

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
the shell. Disconnecting never calls `EndSession`; only `end_on_detach` ties a
session's life to its attachments.

## The CLI

`clankerbox shell MACHINE [-- COMMAND [ARG...]]` creates a session inside its
attachment with `end_on_detach`, stays attached until the program exits, and
exits with its status. It never creates or starts a machine.

With a terminal on stdin and stdout the session is a PTY. The CLI asks the
local terminal for its colours, sends them as the `terminal_profile`, sets
`omit_answered_queries`, puts the terminal in raw mode and passes bytes through
in both directions, so scrollback, selection and rendering stay the terminal's
own. It follows window size changes with `Resize`. Ctrl-C is a byte for the
remote program. Otherwise the session is a pipe session: stdout and stderr stay
separate, stdin is forwarded to its end, and nothing is translated.

What the session is does not depend on what is attached locally. `--tty` gives
the command a terminal from a script or a pipeline, 80 by 24, with output passed
through as it comes and no end of input, since a terminal has none. `--no-tty`
uses pipes from a terminal. `--cwd`, `--env KEY=VALUE` and `--label` set the
create arguments.

Input is sent ahead of its acknowledgements, within a window below the guest's
admission budget and [addressed by offset](#input-and-replies): a round trip
delays neither typing nor a transfer, and refused input is sent again in order.
A failure to read local input is not an end of input: the command fails with
255 and the guest ends the session, so the program never succeeds on a prefix.
Output waits for whatever reads it, so a slow pipeline loses nothing; one that
reads nothing for 30 seconds, such as a pager left idle on a large output, hits
the transport's stall limit and the command fails with 255.

| Exit status | Meaning |
| --- | --- |
| the program's | It exited. |
| 128 + signal | A signal ended it. |
| 130 | The CLI was interrupted. |
| 255 | Local or connection failure, including a machine that is not running. |

The program can itself exit 255 or 130; with `--json` a CLI failure is one
`{"error":{"message","code","reason","retryable"}}` object on stderr, which tells
the two apart. A dropped connection ends the command with 255 and resets the
terminal modes a cut-off program leaves behind; it does not reconnect. The
guest then ends the session, at the latest when the transport's keepalive
declares the connection dead.

`clankerbox guest MACHINE` prints the guest description, and
`clankerbox sessions MACHINE` lists sessions, including ended ones.

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
| Viewer closes or a network hop fails | The PTY continues; the consumer resumes or restores a snapshot. With `end_on_detach`, the guest ends the session once its last attachment is gone. |
| Controller or host restart | Operations reconcile and routing reconnects. Accepted work is not canceled. |
| RAM fork or restore | PTYs and memory continue; the new binding revokes inherited authentication before access is published. |
| Cold copy, guest reboot or daemon restart | New incarnation; unfinished sessions become `lost`. |
| Slow consumer | That attachment is shed; others and the PTY continue. A pipe session holds its process instead. |
| Lost open reply while creating | Repeat the same `Open.create` with its original identity and timestamp; never allocate a replacement silently. |
| Lost input acknowledgement | Repeat the `Input` on the same attachment; its offset keeps it from being applied twice. Never carry it to another attachment. |
| Lost resize acknowledgement | Outcome uncertain; the ordered `Resized` event is the truth. |
| Session ends while no one is attached | An `ENDED` opening returns the outcome and final view. |
| Engine digest mismatch | Snapshot decoding is refused; sessions stay alive. |

Tests in `internal/rpctransport`, `internal/rpcidentity` and `internal/guest`
cover authentication, ordering, cancellation and bounded queues.
`protocol/test/public-session.mjs` exercises a deployed public endpoint,
including backpressure and resume.
