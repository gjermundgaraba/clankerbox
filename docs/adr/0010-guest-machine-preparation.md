# 0010. Guest-run machine preparation and machine identity

Status: accepted

## Context

A profile can install tools, but it cannot prepare a machine for use. Linux
guests have no init system of their own and sessions source no shell profiles,
so nothing runs when a machine starts and nothing puts a variable in every
process. Some tools need per-machine state refreshed on every start, including
after a stop, a restore or a fork, and must not be captured into an image. Forks
and restores copy the disk, so state that identifies a machine is copied too.

## Decision

The guest daemon, which already owns every session process, prepares its
machine from `/etc/clankerbox/machine.json` in the image. The rules are in
[profiles](../profiles.md#machine-preparation).

- **The guest, not the host, runs the start command.** Native work is serialized
  per host, so a command run inside a lifecycle operation would hold up every
  other operation on that host and a fork's source. In the guest, a slow command
  delays only its own machine's sessions, and lifecycle operations do not wait.
- **The start command is a session.** Its outcome is an ordinary session record
  and final screen, with no new result, log or API field. The host knows nothing
  of it, so it is not in operation results or host logs.
- **Each machine a daemon comes to serve is a start.** The daemon prepares a
  machine whenever it comes to serve an ID it did not serve before: its first
  binding after the daemon starts, and the new binding of a live RAM copy.
  Renewal is not a start.
- **Profile variables are defaults.** A caller's entry wins, as it already does
  over the fixed environment. Every caller runs as root and chooses its own
  command, so no ordering could stop a caller removing a variable.
- **The machine ID is a file, not a variable.** It is written before any session
  of a new machine is admitted. A variable would stay stale in processes a RAM
  copy inherits.
- **The image pins the file.** No controller, host or API field describes it.
  The build checks it after setup. An invalid file inside a machine, which an edit
  there can leave, prepares nothing and fails the start run with its reason, so
  it never keeps the daemon from starting.

## Consequences

A failed or timed-out start command never stops the machine, so commands must be
idempotent and leave existing state alone when they fail. Processes a RAM fork or
restore inherits keep running with what they read before their machine's command
and ID, as ADR 0006 already accepts. clankerbox still stores no application
credentials: it runs an image's command without knowing what it does.
