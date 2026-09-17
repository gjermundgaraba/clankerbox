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

Tart's per-VM control socket also has a macOS path-length limit. If the repository
path is too long, use `WorkRun('t', root=Path('/private/tmp/cbt'))`, record its full
path in the qualification evidence, and manage it with
`python3 scripts/work_runs.py --root /private/tmp/cbt list` (or `clean`). The same
ownership, locking and teardown rules apply; the reusable seed stays in
`.work/inputs/`. Validate the full native socket path before creating VMs.
