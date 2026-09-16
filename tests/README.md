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
resources in place for inspection. RAM copies preserve manager incarnation;
macOS disk copies must create fresh managers, including distinct incarnations
for independent restores. See the
[prepared Tart qualification](../scripts/release/inputs/tart-prepared-qualification.md)
for the image and signed-host prerequisites.

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

## Root and terminal qualification

Run the maintained checks against a disposable machine on each guest OS:

```sh
node protocol/test/real-vm.mjs CLIENT_CONFIG_JSON qualify MACHINE_ID
```

The `root` check verifies UID/GID 0, the root home and default cwd, root session
environment, and filtered daemon environment. It installs and runs a uniquely
named temporary executable in `/usr/local/bin`, removing it in `finally`, and
never touches daemon files. The `prefix` check verifies retained output, input
admission while response reads pause, and finite EOF without ending the shell.
Use `root` or `prefix` in place of `qualify` to select one check. Both checks
create and end their own sessions. Historical qualification reports describe
their original images and do not qualify the prepared-v2 root contract.

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

## Lifecycle timings

`benchmark_lifecycle.py` measures create, retained start, RAM fork, checkpoint,
restore and cleanup through the ordinary APIs on new disposable Linux machines.
See [lifecycle performance](../docs/lifecycle-performance.md) for invocation,
evidence handling and the separate live acceptance requirements.
