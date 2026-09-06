# Tart stopped-disk checkpoint experiment

Run from this directory on macOS:

```sh
python3 -m unittest -v test_safety.py
python3 checkpoints.py --run
```

The runner SSHes to `user@mac-workstation`, checks the expected hostname and Tart
2.32.1, and creates `/Users/example/clankerbox-tart-checkpoints.XXXXXX`. It uses only
that marked directory, exact VM names `public-seed`, `source`, `checkpoint`,
`branch`, and explicitly sets `TART_HOME` and `TART_NO_AUTO_PRUNE=1` on every
Tart invocation. The existing custom VM is never opened by Tart. Filesystem-only
inventories before/after compare names, metadata, symlink targets and config
hashes; disk contents are not hashed.

The public cached image is pinned to
`ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:61f6e857a3d65dd2f8daf9c51c7b837fa458bcc9181ae8556e645b534dab6bf6`.
Each file is copied into the isolated seed using Apple's `clonefile(2)`, which
fails instead of falling back to a full disk copy. Subsequent stopped clones
use Tart. Only one guest runs at a time, with 4 CPUs and 8192 MB memory.

1. Seed staged, unstaged and untracked Git changes, a marker, and a committed
   SQLite transaction. Capture the exact Git diffs and SQLite dump.
2. Shut down through the guest; require VMM exit 0. Clone source → checkpoint
   → branch, then verify the complete fixture on the branch.
3. Replace branch guest SSH host keys and authorized public key through Tart
   exec. Verify SSH with its agent-read host key pinned before the connection,
   its own disposable client key, and distinct MAC/IP/host-key identities.
4. Mutate branch Git, marker and SQLite state. Stop/start it and require a new
   boot-session UUID plus identical retained disk state. Boot source and
   checkpoint separately to verify their fixtures are unchanged.
5. Delete the stopped source and checkpoint, boot the child again, verify its
   state, then stop/delete all owned VMs and remove disposable client keys and
   known-hosts files. Retain only the small script, ownership marker and logs.

Host monotonic clocks measure clone, guest-agent readiness and shutdown. Host
free-space delta is sampled every 0.5 seconds, with a conservative 32 GiB abort
threshold below the 40 GiB budget. The delta includes unrelated host activity;
it is not an exact per-VM APFS physical-allocation attribution. `du` would count
shared APFS extents and is not used as new-allocation evidence.

Each invocation writes local `results/YYYYMMDD-HHMMSS/`, including the remote
path, console log, structured events, and before/after inventories. Connection
failure writes `NOT RUN` with the concrete SSH error. Remote failure still
attempts guarded cleanup; inspect the `cleanup` event before considering the
run complete. If SSH drops after launch, use the recorded remote path to inspect
`results.json`; do not assume a disconnected runner cleaned up successfully.

This is **cold disk recovery**, not RAM snapshot restoration or concurrent RAM
forking. SSH identity preparation happens after guest boot via the guest agent;
the test does not establish pre-egress quarantine. No host shares, production
credentials, backup endpoint, persistent job, host reboot, or host policy change
is used. No existing backup script is used. RAM suspend/resume and unattended
host boot recovery are explicitly outside this run's evidence.
