# Acceptance tests

Provision disposable environments with [owned work runs](../scripts/WORK_RUNS.md).
The live harnesses below operate on an existing endpoint; the provisioning driver
owns service/VM teardown and scratch cleanup, including when a harness fails.

`make test` runs the unit tests. The harnesses here run against a live
deployment and create and delete disposable machines; do not point them at an
existing workload.

Run the lifecycle and checkpoint harnesses for each host. They drive only the
product CLI, which must match the guest image of the machines it creates:

```sh
python3 tests/live_lifecycle.py --binary "$PWD/bin/clankerbox" \
  --config "$HOME/.config/clankerbox/config.json" \
  --host linux --profile linux-dev-v3 --result RESULTS/linux-lifecycle.json --keep
python3 tests/live_checkpoints.py --binary "$PWD/bin/clankerbox" \
  --config "$HOME/.config/clankerbox/config.json" \
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

## Guest commands and probes

The harnesses reach a guest the way a user does, through
[`clankerbox shell`](../docs/terminal-sessions.md#the-cli) in its pipe mode:
`run_guest` passes a script on stdin, reads stdout and fails on a non-zero
exit status. Stdout and stderr stay separate, and nothing is quoted into an
argument or limited by one.

Probes used by the harnesses, all in `acceptance.py`:

- `expect_refusal(binary, config, reason, command...)` runs a `--json` command
  and succeeds only when it fails with that stable `reason`, read from the
  structured error on stderr. The lifecycle harness requires `prerequisite`
  from `guest MACHINE_ID` while the machine is stopped.
- `Acceptance.expect_delete_dependency(MACHINE_ID)` submits
  `delete --async --idempotency-key KEY` for a checkpoint source and succeeds
  only on the typed `dependency` refusal. The key is journaled with the command
  before the request and `--async` never waits, so an unexpectedly accepted
  operation is recorded at once and never waited on, retried or cleaned up; any
  other failure leaves the pending entry and names the key for inspection. Use
  only the retained disposable source with its live descendant.
- `describe_guest` runs `--json guest MACHINE_ID`, which walks the controller,
  host and guest route and prints the machine identity and manager incarnation
  as Protobuf JSON. Cold starts keep the machine identity and replace the
  incarnation; RAM forks and restores keep the incarnation and publish a new
  machine identity.

## Lifecycle timings

`benchmark_lifecycle.py` measures create, retained start, RAM fork, checkpoint,
restore and cleanup through the ordinary APIs on new disposable Linux machines.
See [lifecycle performance](../docs/lifecycle-performance.md) for invocation,
evidence handling and the separate live acceptance requirements.


## Runtime profile publication

Use an explicitly disposable environment with a deployed base and spare capacity.
The harness publishes two revisions, checks running/stopped machine pins, forks
and checkpoints across updates, revision deletion dependencies, failed builds,
cancellation, and lifecycle overlap during setup. It deletes its machines,
checkpoints, profile and revisions on success. Failures retain
recorded build and resource IDs for inspection; do not replay uncertain mutations.

```sh
python3 tests/live_profiles.py --binary bin/clankerbox --config CLIENT_CONFIG \
  --host local --base linux-base \
  --result RESULTS/profiles.json
```

Setup recipes must follow the root-run tools contract described in
[profiles](../docs/profiles.md). Run native lifecycle/checkpoint acceptance against
a successfully published profile as well.

Use `--cpu 4 --ram-mib 8192 --setup-delay 60` for the Tart fixture. Resource
settings and the setup delay are configurable so the host has enough capacity
and stop/start can finish while setup is still running. The suite stops the new
machine before later build checks to stay within the native two-macOS-VM limit;
run Tart qualification without unrelated macOS VMs competing for those slots. `--setup-script FILE`
adds a real root-run package installation script to both successful recipes.
`--keep-profile` retains the second revision for lifecycle and benchmark tests;
the report records its profile name and revision ID. The caller must remove it
after those checks. Unresolved builds continue polling until a terminal outcome
or the build timeout (default one hour).

Host/controller crash recovery, base retirement and upload-expiry checks require
control of the disposable environment's services and state. They are performed
by the environment qualification driver, not by exposing test-only product APIs.
