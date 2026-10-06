# Live acceptance

The live suites drive real hosts through the `clankerbox` binary, one suite per
runtime: `tests/smolvm.test.ts`, `tests/tart.test.ts` and `tests/boat.test.ts`,
with the harness in `tests/live.ts`. Under `vp run -r test` they are skipped:
they run only with `CLANKERBOX_LIVE=1` and the environment their driver sets.
`tests/live.ts` documents that environment and the host-control program's ops.

Each runtime has one entry point, a Python driver that builds the binary from
the committed tree, provisions the host, runs that runtime's suite once, tears
everything down and exits with the suite's code. Run them from the repository
root:

```sh
pnpm live:smolvm --ssh USER@HOST --address TAILNET_ADDRESS --root OWNED_ROOT --smolvm-prefix PREFIX
pnpm live:tart --tart TART --seed SEED --address TAILNET_ADDRESS
pnpm live:boat --key-file KEY_FILE [--address TAILNET_ADDRESS]
```

Each is `python3 tests/live/<runtime>/driver.py`, whose `--help` prints its full
usage. Every driver takes `--suite-args`, passed to `vp test`, to run a subset
(`--suite-args "-t 'placement'"`). The tests within a suite run in order and
share machines, so a subset can fail where the whole suite passes.

## What every run needs

- This Mac (Apple Silicon), with the workspace installed (`pnpm install`),
  `vp`, `python3`, and `ssh`, `scp`, `rsync` and `ssh-keygen` on the path.
- A tree with no uncommitted changes: the driver refuses one, so the commit it
  records names the code it ran.
- The release tooling's Node archives, for the Node `.node-version` pins, with
  their checksums in `tools/release/release-inputs.json`;
  `tools/release/build.sh` downloads them into `tools/release/cache/` on first
  use. The driver builds the bundles into its run's scratch, smokes the
  darwin-arm64 one with `tools/release/smoke.sh` and runs the binary it holds;
  it leaves `tools/release/dist/` alone.
- Each run is a work run (`scripts/WORK_RUNS.md`): it owns
  `.work/runs/live-<runtime>-<id>/`, whose `evidence/` it keeps (driver log,
  `resources.json`, the suite's verbose log with its `[timing]` lines, the
  host's log, teardown results) and whose `scratch/` it removes. A first
  Ctrl-C or SIGTERM stops the run and starts its teardown, which ignores any
  further one until it ends. Evidence can hold credentials; don't publish it.
  Nothing in a run logs a setup script, a packed recipe or the preparation
  script.

## smolvm: `pnpm live:smolvm`

Runs the linux-x64 binary as root on a Linux test host, over the tailnet, and
the suite with the darwin-arm64 binary as the CLI. The test host gets the
linux-x64 bundle and its `.sha256`, checks one against the other and extracts
the binary (`smolvm/remote.py`).

It covers create, stop, cold start, start and delete; a start of a running
machine, which keeps its VM's boot, and of one smolvm reads unreachable (its
VMM stopped with SIGSTOP, so its agent doesn't answer), which refuses a fork
until start boots it again; a setup packed from a recipe with `files/` and run
once, then preparation's `start` and `new-identity`; a failing setup, an
overrunning setup, a failing `start` and a failing `new-identity` hook;
`clankerbox ssh`, scp and rsync pinned to the host key, and a re-mint under a
running sshd; a guest refused its own host's API port and 100.100.100.100, with
the host's route to the tailnet unchanged; `Conflict{exists}`,
`Conflict{busy}`, a client that goes away mid-create and a call past 300 s; the
RAM budget's `Capacity`, with two concurrent creates of which one fits; `ram`
checkpoints, forks and restores, each with its own port, host key and identity,
a restore under a reused name, and a fork's source stopped, cold-started and
deleted while the fork runs; `Precondition` for a capture or fork of a stopped
machine; a host restart, a host killed during a setup, a host stopped while a
fork's or a restore's VM is made but not booted, and a stop the guest won't
confirm; and a native machine that already carries a machine's name.

- `--ssh USER@HOST`: the Linux/amd64 test host with KVM, reachable by ssh with
  a key (`BatchMode`), where `USER` has passwordless `sudo` (the host runs as
  root in a transient system unit). A root-mode run needs the owner's approval
  first.
- `--address`: that host's tailnet address, which the host listens and
  publishes on.
- `--root`: the working root on the test host that the run owns, as an
  absolute path; on the current test host, `~/clankerbox-rewrite/` expanded.
  The run's directory is `runs/l<3 hex>/` there, reserved under a free name
  before the build and removed again if the run stops before it writes there,
  and `CLEANUP.md` there is its ledger of every change outside that root.
- `--smolvm-prefix`: smolvm 1.22.2 installed from upstream, with `READY` and
  its `.zst` disk templates; the run expands the templates and removes them
  again. The base is `ubuntu:26.04` from `mirror.gcr.io`, pulled by digest
  (`smolvm/remote.py`).

The run's host ID, systemd units and machine names start `clankerbox-live-l`,
followed by the run's ID. A VMM the unreachable test leaves stopped, should it
fail before its start, goes with teardown's `smolvm machine stop`, which ends
an unreachable machine's VMM with SIGKILL, or the scope's SIGKILL after it.

## Tart: `pnpm live:tart`

Runs the darwin-arm64 binary as two Tart hosts on this Mac, from a private Tart
home in the run's scratch, and the suite with the same binary as the CLI.

It covers create, stop, cold start, start and delete on macOS guests, with
setup and preparation; scp and rsync through the forwarder, pinned to the host
key, and a re-mint on start of a running VM, which keeps its boot; Softnet's
block of the host's API port and every host address; placement over two hosts,
in both list orders: the first host offering the base, a full ID, a profile's
`host`, and `Precondition` when no host offers it; `disk` checkpoints, forks
and restores of a stopped machine, and `Precondition` for a capture or fork of
a running one; Apple's two-VM limit, refused with `Capacity` before any clone;
a disk below the base's; a host restart that brings the forwarded endpoints
back; and a host killed during a setup.

- `--tart`: the `tart` binary of Tart 2.40.1, absolute, such as
  `.work/inputs/tart-2.40.1/tart.app/Contents/MacOS/tart` in the checkout the
  driver runs from.
- `--seed`: the stock Cirrus seed, absolute, in the main checkout's
  `.work/inputs/tart-cirrus-tahoe-base` (its one VM under `home/vms`,
  `PROVENANCE` with the files' checksums, and `READY`). The run clones it with
  APFS clones and checks its checksums before and after; it never boots or
  changes it.
- `--address`: this Mac's tailnet address; loopback when it isn't assigned.
- Softnet 0.24.0 installed SUID root at `/usr/local/bin/softnet` (mode 4755,
  root:wheel).
- No macOS VM running on this Mac: Apple allows two, and the suite uses both.

The run's host ID starts `clankerbox-live-t`, followed by the run's ID; its
second host, `<host ID>-b`, serves only the placement test.

## boat: `pnpm live:boat`

Runs the darwin-arm64 binary as a boat host on this Mac, unprivileged (the
driver refuses root), and the suite with the same binary as the CLI.

It covers create, stop (boat's archive), start (a resume on a new machine, with
a new endpoint and host key) and delete once boat answers 404; setup and
preparation, with `/var/lib/clankerbox/` kept across a resume; scp and rsync
through boat's endpoint; a start of the running machine its create made, right
after the create, which waits for no restore marker and keeps its boot, and a
re-mint without a resume; the create's mark (`/run/clankerbox-created`) on that
machine alone, and boat's restore marker on every resumed, forked and restored
one; a size no boat type covers, a large create on the trial (boat's 403) and a
third active sandbox (boat's 429), each refused leaving no row; checkpoints and
forks of a running and a stopped machine, a fork holding a file written just
before it, and a checkpoint restored after its source is deleted; a host
restart; and a host killed during a setup.

- `--key-file`: a file holding the boat API key alone, outside the repository
  and mode 0600. The boat CLI's config holds the key as its JSON `token`; this
  writes it to `KEY_FILE` without the key reaching an argument list:

  ```sh
  python3 -c 'import json, os, sys; key = json.load(open(sys.argv[1]))["token"]; \
    os.write(os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), key.encode())' \
    "$HOME/Library/Application Support/ascii/boat/config.json" KEY_FILE
  ```

  The driver writes the key only into the host's config in scratch (mode 0600)
  and fails the run if it ever reaches evidence.

- Room on the account, which a read-only pre-flight checks before anything is
  made: two free active sandboxes, 7 starts left this hour and this day (one
  run makes 7, of the trial's 5 a minute, 25 an hour and 75 a day, which the
  owner's own use shares), and room for 2 named snapshots under boat's cap of
  ten. The suite's 429 test runs only when the account's active limit is the
  trial's 2, and its large create only on the trial tier.
- `--address`, optional: this Mac's tailnet address; loopback otherwise.

The run's host ID starts `clankerbox-live-b`, followed by the run's ID, so its
sandboxes' display names start `<host ID>_` and its named snapshots
`cbx-<host ID>-`.

## Not covered live, and why

- **A guest refused its own host's API port, on boat:** a boat host runs on
  the operator's side and listens on its tailnet address or loopback, which a
  sandbox in boat's cloud can't route to; there is no host port beside the
  guest to probe.
- **Placement on smolvm and boat:** placement is the client library's, the
  same for every runtime, so one live run over two hosts (Tart, where a second
  host costs no VM) covers it. A second smolvm host would need another root
  host on the test machine, and creates on a second boat host would cost boat
  starts.
- **A client that goes away, and a call past 300 s, on Tart and boat:** both
  are the host's HTTP handling and the client's timeouts, the same for every
  runtime, so smolvm, whose creates are the cheapest, covers them. On boat they
  would cost starts.
- **`Conflict{busy}`, a failing setup and a failing `start`, on Tart and
  boat:** the claim, setup and preparation are the host's core, shared by
  every runtime; smolvm covers them live, and the unit suite on every runtime
  module. On boat each would cost a start.
- **A failing hook on fork or restore:** live on create only; the unit suite
  covers fork and restore (`packages/host/tests/checkpoints.test.ts`,
  `prepare.test.ts`), whose preparation is the same code.
- **A native name already taken, on Tart and boat:** Tart's native names carry
  the instance like smolvm's, so the smolvm test covers the naming rule; boat
  assigns sandbox IDs itself and the host deletes by the recorded ID.
- **100.100.100.100 and the tailnet route, on Tart:** they check smolvm's
  egress floor and its host routes; on Tart, the suite checks Softnet's block
  of every host address instead.
- **boat's repeats of a call whose outcome is unclear, or that boat
  throttled:** they need a dropped connection, a timeout or a 5xx from boat,
  which a live run can't cause, or a `rate_limited` 429, which would take more
  starts in a minute than the trial's 5 and cost more on repeat; the unit suite
  covers them, and the refusals it no longer trusts after an unclear one,
  against a fake boat (`packages/host/tests/boat-api.test.ts`). Live, a 429
  `limit_reached` to a create on the first attempt is still `Capacity`.
- **A machine whose state can't be read (`unknown`):** it needs the runtime's
  read to fail; the unit suite covers it on smolvm and boat and in the core
  (`packages/host/tests/machines.test.ts`).
- **List fan-out with a host down, and `--json` error tags:** the unit suite
  covers them against the real host process over the fake runtime
  (`apps/clankerbox/tests/host.test.ts`).
- **The linux-x64 bundle's smoke test:** a driver runs `tools/release/smoke.sh`
  on the darwin-arm64 bundle it built, and the smolvm run checks the linux-x64
  one against its `.sha256` and runs its binary as the host; CI smokes both
  targets (`pnpm sea:smoke`).
