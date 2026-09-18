# `clankerbox shell` and the attachment contract — completed implementation

Status: released in Clankerbox 0.8.0 with SDK 0.4.0.

One command creates, streams, uses and ends a guest session:
`clankerbox shell MACHINE [-- COMMAND [ARG...]]`. The session API changed to
make that client small and correct, and the controller and host relay it
unchanged.

## Current references

- [Session contract and CLI behaviour](../terminal-sessions.md)
- [ADR 0009: attachment-owned sessions and one client-informed responder](../adr/0009-attachment-owned-sessions.md)
- [ADR 0005: the session API is the only path to a guest process](../adr/0005-terminal-sessions-only.md)
- [Live harnesses and their probes](../../tests/README.md)

## Scope retained

The command addresses an existing running machine and never creates or starts
one. A dropped attachment ends the session and the command; it does not
reconnect. `tests/session-run` is gone: the live harnesses drive only the
product CLI, through `shell`, `guest` and typed `--json` errors.

## Release notes

- The session contract broke: `CreateSession` is removed, `Open.create` takes
  `NewSession`, and `Input` carries `offset`. Release the TypeScript SDK with it
  and update its consumers: create through the attachment, send each `Input` at
  the `input_offset` the guest last reported.
- The guest binary is part of the prepared image, so machines need a bundle
  built from this source; the CLI and guest must match.
- `go.mod` gained `golang.org/x/term`: regenerate the dependency notices with
  `scripts/release/notices.py`, or `bundle.py` refuses the provenance.
- `protocol/test/public-session.mjs` and `real-vm.mjs` were moved to the new
  contract but need a deployment to run.

## Known limits

- Every control costs a round trip to the guest, about 170 ms on one
  workstation; machine reads pay it too through host inspection. Sending input
  ahead hides it from transfers and typing bursts, not from a single keystroke's
  echo. Its cause is not established.
- Output applies backpressure, but the relays cut off a stream whose consumer
  accepts nothing for 30 seconds. `shell m -- cat big | less` left idle fails
  rather than waiting; lifting that would mean buffering in the CLI.
- Reconnect needs a bootstrap any terminal can consume. The pinned engine's
  formatter already emits its state as ordinary escape sequences (`VT`, with
  palette, modes, scrolling region, tabstops and keyboard state); attaching from
  that instead of an engine-private snapshot is the follow-up.
