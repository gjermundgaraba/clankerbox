# Acceptance tests

`make test` runs the unit tests. The harnesses here run against a live
deployment and create and delete disposable machines; do not point them at an
existing workload.

Build the test-only session adapter, then run the lifecycle and checkpoint
harnesses for each host:

```sh
go build -o bin/session-run ./tests/session-run
python3 tests/live_lifecycle.py --binary "$PWD/bin/clankerbox" \
  --session-runner "$PWD/bin/session-run" --config "$HOME/.config/clankerbox/config.json" \
  --host linux --profile linux-dev-v3 --result RESULTS/linux-lifecycle.json --keep
python3 tests/live_checkpoints.py --binary "$PWD/bin/clankerbox" \
  --session-runner "$PWD/bin/session-run" --config "$HOME/.config/clankerbox/config.json" \
  --lifecycle-result RESULTS/linux-lifecycle.json --result RESULTS/linux-checkpoints.json
```

Repeat with a macOS host and profile. The checkpoint harness needs
the machine the lifecycle harness kept with `--keep`. Failures leave named
resources in place for inspection.

Both harnesses create `--result` exclusively and update it atomically, recording
accepted operation and resource IDs before polling. Unresolved operations,
transport ambiguity and polling timeouts are recorded as pending, and neither
harness replays a mutation to resolve uncertainty. `live_lifecycle.py --resume`
reuses the disposable machine named in an existing report and refuses to
continue past a pending mutation; inspect and reconcile before rerunning.
Lifecycle cleans up its machine unless `--keep` is set; checkpoint failures keep
everything.

For the public HTTPS streaming boundary, use the built SDK against a running
disposable machine:

```sh
node protocol/test/public-session.mjs CLIENT_CONFIG_JSON MACHINE_ID
```

This creates and ends its own session, streams 64 MiB, and checks ordered
controls, a healthy sibling beside an unread viewer, bounded disconnection of a
stalled viewer, and cancel/resume on the same shell. It does not stop or delete
the machine. Keep restarts and lifecycle mutations out of the test window.

## session-run

`session-run` runs one command in a bearer-authenticated terminal session and
returns its exit status and ordered output through the guest protocol. It
installs an output gate before the command starts, disables echo and newline
conversion, and passes text stdin through a pipe. PTY stdout and stderr are
merged. It is a test adapter, not an exec API. The gate, quoted arguments and
quoted stdin must fit one 4096-byte protocol argument; oversize commands fail
locally.

Probes used by the harnesses:

- `--expect-stopped MACHINE_ID` makes an authenticated `SessionService` request
  and succeeds only on the typed `prerequisite` error.
- `--expect-delete-dependency MACHINE_ID` submits a delete of a checkpoint
  source and succeeds only on the typed `dependency` error. The harness journals
  the probe first and records any unexpectedly accepted operation. Use only the
  retained disposable source with its live descendant.
- `--describe-guest MACHINE_ID` walks the controller, host and guest route and
  prints the machine identity and manager incarnation as Protobuf JSON. Cold
  starts keep the machine identity and replace the incarnation; RAM forks and
  restores keep the incarnation and publish a new machine identity.
