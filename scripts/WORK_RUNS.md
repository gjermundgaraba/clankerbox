# Disposable work runs

Use `scripts/work_runs.py` for build and qualification scratch. Each run owns:

```text
.work/runs/<label>-<id>/
  manifest.json   ownership, outcome and cleanup state
  evidence/       retained logs, results and resource inventory
  scratch/        disposable installations, images and build output
```

Run directories are private. Evidence can contain credentials; do not publish it
without inspection. Keep evidence small. Copy release outputs and necessary
curated inputs to their intended destination before leaving the run.

## Foreground build commands

```sh
python3 scripts/work_runs.py run --label build-check -- sh -c '
  python3 some-build-driver.py --output "$WORK_RUN_SCRATCH/output" \
    >"$WORK_RUN_EVIDENCE/build.log" 2>&1
'
make work-list
make work-clean
```

Replace `some-build-driver.py` with the actual build command. The wrapper supplies
`TMPDIR`, `WORK_RUN_SCRATCH` and `WORK_RUN_EVIDENCE`; it does not redirect arbitrary
output paths or compiler caches automatically. For example, set `CARGO_TARGET_DIR`
to a scratch subdirectory for disposable Rust compilation. The Mac host signing
script respects `TMPDIR`.

Success, command failure and ordinary interruption stop the command's process
group and remove scratch. `--keep` retains scratch for an explicit debugging need;
record that reason in evidence. Logs are only retained if the driver writes them
there, as above.

**Do not use the command wrapper alone for drivers that create VMs, launchd jobs,
remote services or detached processes.** Those require resource-specific teardown.
The existing live harnesses act on an endpoint; their provisioning driver owns
that teardown, including resources left by a failed harness.

## Python provisioning drivers

From a driver with the repository root on its Python import path:

```python
from scripts.work_runs import WorkRun

with WorkRun('profile-qualification') as run:
    # Record resource names/remote roots in evidence before creating them.
    # Register teardown before starting anything that could partially succeed.
    run.on_cleanup(teardown_owned_environment)
    provision_owned_environment(run.scratch, run.evidence)
    qualify_environment(run.evidence)
```

The three environment functions above belong to the provisioning driver; they
are not APIs provided by this helper. Teardown must stop and wait for all owned
VMs/processes, unregister native jobs, and verify their absence. Register callbacks
in acquisition order; they run in reverse order, even if qualification raises.
All callbacks are attempted. If one fails, scratch remains with state
`needs_teardown`; cleanup must not erase the evidence needed to recover.

Use the same layout on remote hosts, and collect their evidence before deleting
remote scratch. The local helper does not automatically manage remote resources.

## The live suites

`tests/live/smolvm/driver.py` is the provisioning driver for `tests/live` against
a smolvm host on a Linux test machine: it runs the host there as root, from a run
directory with this layout under the machine's owned root, and gives the suite
its host-control program (`tests/live/tests/live.ts`). Its teardown removes the
run's VMs and scopes natively, by the run's own smolvm data dir, so a test that
leaves the host down leaves nothing behind. The driver's docstring shows its
invocation.

`tests/live/tart/driver.py` is its counterpart on this Mac: it runs a Tart host
from a private Tart home in the run's scratch, whose base is an APFS clone of the
Cirrus seed named by `--seed` (the main checkout's
`.work/inputs/tart-cirrus-tahoe-base`), on the tailnet address named by
`--address`, and gives the suite the same host-control program. Its teardown
stops the host, then deletes the home's VMs and boots out the launchd jobs
carrying the run's host ID, natively, before scratch is deleted. Its docstring
shows its invocation.

`tests/live/boat/driver.py` runs a boat host on this Mac, unprivileged, against
the operator's boat account on its trial, on loopback or the tailnet address
named by `--address`. The host's config, in scratch with mode 0600, holds the
boat CLI's API key, which nothing else writes down: the driver logs its own
calls as method, path, status and boat's code, and its last teardown step
redacts the key from every evidence file and fails the run if it was there. A
read-only pre-flight records the account's counts (never the operator's names
or IDs) and stops the run before it makes anything unless two active sandboxes
are free and its starts and named snapshots have room for the run. When the
account's active limit isn't the trial's two, the suite skips only its test of
boat's 429 for a third sandbox. The run's host ID carries its run ID, so its sandboxes' display names start
`<host ID>_` and its named snapshots `cbx-<host ID>-`. Its teardown stops the
host, deletes by ID every sandbox the host's database records or the suite's
host-control program saw, sweeps those two prefixes, and checks that nothing of
the run's remains; it touches nothing else on the account. The evidence keeps
the suite's starts and the account's start count before and after. Its
docstring shows its invocation.

The drivers share `tests/live/driver_common.py`, which holds their evidence
(`driver.log`, `resources.json` and each command's log) and runs the suite with
its temporary directory in the run's scratch. They refuse a tree with
uncommitted changes (`git status --porcelain`, which leaves out ignored files),
so the commit each records in its evidence (`resources.json` `commit`) names the
code the run built and tested.

## Abandoned runs

```sh
python3 scripts/work_runs.py list
python3 scripts/work_runs.py clean RUN_ID
python3 scripts/work_runs.py clean --all
```

Cleanup removes only scratch from recognized owned runs, retaining their evidence
and manifests. It refuses symlink roots and active runs. A dead driver does not
prove its VMs stopped: runs left in `running` or `needs_teardown` are refused too.

After inspecting the run's inventory, stopping its resources and confirming their
absence, explicitly acknowledge that work:

```sh
python3 scripts/work_runs.py clean --resources-stopped RUN_ID
```

That acknowledgement never overrides an active-run lock. `SIGKILL`, power loss
and machine crashes require this recovery path; no exit handler can guarantee
cleanup in those cases. Legacy directories without an ownership manifest require
an explicit audit rather than automatic adoption or deletion by prefix.

Before reporting completion, state separately whether runtime resources remain
and how much disk data was retained, with its reason.

## Reusable VM inputs

Keep prepared seeds under `.work/inputs/` with source provenance and an explicit
ready marker. Those are retained inputs, not run scratch. Clone a stopped seed
into each run (APFS clones on macOS), then delete only the run's clones during
teardown. Validate host/controller startup before expensive image work. A failed
qualification must not force another download of its unchanged input.

A Tart home can be a run's own `scratch/`: Tart 2.40.1 changes into the VM's
directory and binds and dials its control socket by the relative name
`control.sock`, so macOS's socket-path limit doesn't apply to the home
(T:ControlSocket.swift:30-46; P11 ran homes of up to 106 bytes,
evidence.md). Record the home's path in the run's evidence, and register its
VMs' teardown with `run.on_cleanup` before creating them, so they are stopped
and deleted before scratch is.
