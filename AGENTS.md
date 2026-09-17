# Disposable builds and qualification

- Use `scripts/work_runs.py` for new disposable build/qualification environments:
  one owned directory under `.work/runs/`, with bulky data in `scratch/` and
  logs/results/manifests in `evidence/`.
- Python drivers must register teardown callbacks for every owned VM, service and
  native job. Teardown must finish before scratch is deleted, including on failure.
  The command wrapper handles subprocesses, not independently managed VMs/jobs.
- Preserve scratch only for an explicit debugging need; record the reason and path.
  Do not leave full installs, exported filesystems or compiler trees as evidence.
- After a crash, inspect and stop the run's recorded native resources before using
  the cleanup command's explicit resources-stopped assertion. Never infer safety
  from a dead driver PID alone or delete arbitrary directories by name pattern.
- Before reporting completion, report remaining runtime resources and retained
  disk artifacts separately, including size and reason. Keep useful failure logs.
- Reusable VM seeds belong under `.work/inputs/`, with provenance and a ready
  marker. Never delete the only local seed during test teardown; run on private
  clones. Validate service startup before expensive image preparation or transfer.
- Published outputs and curated release inputs are not disposable scratch. Copy
  needed outputs to their intended destination before cleanup.

See [the work-run guide](scripts/WORK_RUNS.md) for usage.
