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
pnpm live:tart --seed SEED --address TAILNET_ADDRESS
pnpm live:boat [--address TAILNET_ADDRESS]
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
  use. The driver builds the bundles there and removes `tools/release/dist/`
  once it has taken the binary out of its bundle.
- Each run is a work run (`scripts/WORK_RUNS.md`): it owns
  `.work/runs/live-<runtime>-<id>/`, whose `evidence/` it keeps (driver log,
  `resources.json`, the suite's verbose log with its `[timing]` lines, the
  host's log, teardown results) and whose `scratch/` it removes. Evidence can
  hold credentials; don't publish it. Nothing in a run logs a setup script, a
  packed recipe or the preparation script.

## smolvm: `pnpm live:smolvm`

Runs the linux-x64 binary as root on a Linux test host, over the tailnet, and
the suite with the darwin-arm64 binary as the CLI.

- `--ssh USER@HOST`: the Linux/amd64 test host with KVM, reachable by ssh with
  a key (`BatchMode`), where `USER` has passwordless `sudo` (the host runs as
  root in a transient system unit). A root-mode run needs the owner's approval
  first.
- `--address`: that host's tailnet address, which the host listens and
  publishes on.
- `--root`: the run's owned root on the test host, as an absolute path (such as
  `~/clankerbox-rewrite/` expanded). The run's directory is `runs/l<3 hex>/`
  there, and `CLEANUP.md` there is its ledger.
- `--smolvm-prefix`: smolvm 1.22.2 installed from upstream, with `READY` and
  its `.zst` disk templates; the run expands the templates and removes them
  again. The base is `ubuntu:26.04` from `mirror.gcr.io`, pulled by digest
  (`smolvm/remote.py`).

## Tart: `pnpm live:tart`

Runs the darwin-arm64 binary as two Tart hosts on this Mac, from a private Tart
home in the run's scratch, and the suite with the same binary as the CLI.

- `--seed`: the stock Cirrus seed, absolute, in the main checkout's
  `.work/inputs/tart-cirrus-tahoe-base` (its VM under `home/vms`, `PROVENANCE`
  with the files' checksums, and `READY`). The run clones it with APFS clones
  and checks its checksums before and after; it never boots or changes it.
- `--address`: this Mac's tailnet address; loopback when it isn't assigned.
- Tart 2.40.1 at `.work/inputs/tart-2.40.1/tart.app` in the checkout the
  driver runs from, and Softnet 0.24.0 installed SUID root at
  `/usr/local/bin/softnet` (mode 4755, root:wheel).
- No macOS VM running on this Mac: Apple allows two, and the suite uses both.
- The second host, `<host ID>-b`, serves only the placement test; see the
  driver's docstring.

## boat: `pnpm live:boat`

Runs the darwin-arm64 binary as a boat host on this Mac, unprivileged (the
driver refuses root), and the suite with the same binary as the CLI.

- The boat CLI's API key: the `token` in
  `~/Library/Application Support/ascii/boat/config.json`. The driver writes it
  only into the host's config in scratch (mode 0600) and fails the run if it
  ever reaches evidence.
- Room on the account, which a read-only pre-flight checks before anything is
  made: two free active sandboxes, 7 starts left this hour and this day (one
  run makes 7, of the trial's 5 a minute, 25 an hour and 75 a day, which the
  owner's own use shares), and room for 2 named snapshots under boat's cap of
  ten. The suite's 429 test runs only when the account's active limit is the
  trial's 2, and its large create only on the trial tier.
- `--address`, optional: this Mac's tailnet address; loopback otherwise.

## Coverage

What live acceptance must cover, as the rewrite's plan set it out, item by
item, and where each is checked: a suite's test, named by the start of its
title, or a unit test where the item is checked against the real host process
or the client library instead. "smolvm", "Tart" and "boat" are
the live suites.

| Item                                                                                                                         | Covered by                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create, start, stop, delete                                                                                                  | smolvm, Tart, boat: "create … runs its setup once", "stop and a cold start …", "delete removes …"                                                                                                                                                                                            |
| Placement: a create by name lands on the first host in list order that offers its base                                       | Tart (two hosts): "placement: …", both list orders, one where only the later host offers the base. Unit: `packages/contract/tests/client.test.ts`                                                                                                                                            |
| Placement: a full ID sends the create to the named host                                                                      | Tart: "placement: …", with the other host first in the list and offering the base. Every other live create also names a full ID                                                                                                                                                              |
| Placement: no host offering the base replies `Precondition` with each host's bases                                           | Tart: "placement: …" (two hosts). smolvm, Tart, boat: "a taken name is Conflict{exists}, and a base no host offers …" (one host)                                                                                                                                                             |
| The refusal rule: boat's refusals leave no row                                                                               | boat: "with two sandboxes active, boat refuses a third create with 429" (trial limit only), "a large create … 403", "a size no boat type covers". Tart and smolvm refusals: Tart "with two VMs running …", smolvm "one list reads … a capture or a fork of a stopped machine"                |
| A native resource already carrying a machine's name is left alone by its create and delete                                   | smolvm: "a native machine that already carries a machine's name …"                                                                                                                                                                                                                           |
| Setup runs once at create                                                                                                    | smolvm, Tart, boat: "create … runs its setup once", and every later test's `setups` count                                                                                                                                                                                                    |
| A failing setup fails the create with its output                                                                             | smolvm: "a failing setup fails the create with its exit code and output". Unit: `apps/clankerbox/tests/host.test.ts`                                                                                                                                                                         |
| An overrunning setup fails the create with its output                                                                        | smolvm: "a setup past its timeout fails the create …"                                                                                                                                                                                                                                        |
| A recipe directory with `files/` packed and run as one script                                                                | smolvm: "create packs the recipe …" (`main` is a recipe whose `files/` carry a payload, checked by hash)                                                                                                                                                                                     |
| A profile with `host` creates on that host, whatever placement by base would pick                                            | Tart: "placement: …" (`--profile`, with the other host first and offering the base). Unit: `client.test.ts`, `apps/clankerbox/tests/cli.test.ts`                                                                                                                                             |
| `new-identity` runs on create, fork and restore, not on `start`                                                              | smolvm: "create packs the recipe …", "a ram capture, a fork and two restores …", "start on a fork and on a restore …". Tart: "create runs setup …", "a disk checkpoint …", "stop and a cold start …". boat: "create runs setup …", the fork and restore tests, "stop archives the sandbox …" |
| A failing hook fails the action                                                                                              | smolvm: "a failing new-identity hook fails the create". For fork and restore, unit: `packages/host/tests/checkpoints.test.ts`, `prepare.test.ts`                                                                                                                                             |
| A guest is refused its own host's API port                                                                                   | smolvm: "a guest can't reach its own host's API port …". Tart: "under Softnet a guest can't reach its host's API port …". Not boat; see below                                                                                                                                                |
| A guest is refused 100.100.100.100, and the host's routes to the tailnet stay unchanged                                      | smolvm: "a guest can't reach the tailnet's 100.100.100.100 …". No peer check, as the item says                                                                                                                                                                                               |
| smolvm's RAM budget refuses with `Capacity`; of two concurrent creates that each fit only alone, one passes                  | smolvm: "the RAM budget refuses with Capacity …"                                                                                                                                                                                                                                             |
| RAM fork, `ram` capture, restore and delete on smolvm                                                                        | smolvm: "a ram capture, a fork and two restores …", "checkpoint delete removes a ram checkpoint …"                                                                                                                                                                                           |
| A capture of a stopped smolvm machine is `Precondition`                                                                      | smolvm: "one list reads … a capture or a fork of a stopped machine is Precondition …"                                                                                                                                                                                                        |
| `disk` checkpoints on Tart                                                                                                   | Tart: "a disk checkpoint of a stopped machine, a fork of it and a restore …", "delete removes … a checkpoint delete its VM"                                                                                                                                                                  |
| boat: stop and start bring a new endpoint and host key                                                                       | boat: "stop archives the sandbox and start resumes it …"                                                                                                                                                                                                                                     |
| boat: a fork of a running machine holds a file written just before it                                                        | boat: "a checkpoint captures a running machine … and a fork of it …"                                                                                                                                                                                                                         |
| boat: a checkpoint captured from a running machine restores after its source is deleted                                      | boat: "a fork keeps running once its source is deleted, and a checkpoint captured from the running source restores after it …"                                                                                                                                                               |
| boat: preparation finds `/var/lib/clankerbox/` from before a start                                                           | boat: "stop archives the sandbox …" (same instance, no new-identity)                                                                                                                                                                                                                         |
| boat: `delete` replies once boat answers 404                                                                                 | boat: "delete removes a running machine's sandbox once boat answers 404"                                                                                                                                                                                                                     |
| `clankerbox ssh` with the pinned host key, and scp and rsync of a binary file by hash, on each runtime                       | smolvm, Tart, boat: "scp and rsync move a binary file both ways …"; every `inGuest` call is a `clankerbox ssh`                                                                                                                                                                               |
| A fork and two restores of one checkpoint each get their own port and host key, and ssh works into all while the source runs | smolvm: "a ram capture, a fork and two restores of one checkpoint …"                                                                                                                                                                                                                         |
| `start` runs to completion after every activation                                                                            | smolvm, Tart, boat: the `starts` count after every create, start, fork and restore                                                                                                                                                                                                           |
| A failing `start` fails the action with its output                                                                           | smolvm: "a failing start fails the action with its output …". Unit: `prepare.test.ts`                                                                                                                                                                                                        |
| Instance and machine-ID files updated on fork and restore, including a restore under a reused name                           | smolvm: "a ram capture, a fork and two restores …", "a fork's source is stopped … a restore under the source's reused name …". Tart and boat: their fork and restore tests                                                                                                                   |
| A fork's source stopped, cold-started and deleted while its forks run, and the fork's own store gone after                   | smolvm: "a fork's source is stopped, cold-started and deleted …" (the forks area is empty after each fork)                                                                                                                                                                                   |
| A host restart keeps VMs, smolvm's published ports and the machine-ID file, and wipes the forks area                         | smolvm: "a host restart keeps running machines …"                                                                                                                                                                                                                                            |
| Tart's forwarded endpoints come back after the forwarder restarts                                                            | Tart: "a host restart keeps the VMs running, brings their forwarded endpoints back …"                                                                                                                                                                                                        |
| `stop` and `delete` after an interrupted operation, on every runtime                                                         | smolvm: "after the host is killed during a create's setup …", "a host stopped while a fork's or a restore's VM is made but not booted …", "a stop the guest won't confirm …". Tart and boat: "after the host is killed during a create's setup …"                                            |
| A mutation whose client disconnects still finishes and records its outcome                                                   | smolvm: "a taken name is Conflict{exists}, … and a create whose client goes away still finishes …" (the CLI is SIGKILLed mid-create). Unit: `packages/host/tests/server.test.ts`, `machines.test.ts`                                                                                         |
| A call that runs past 300 s replies normally                                                                                 | smolvm: "a create whose setup runs past 300 s replies normally"                                                                                                                                                                                                                              |
| A duplicate name is `Conflict{exists}`                                                                                       | smolvm, Tart, boat: "a taken name is Conflict{exists}, and a base no host offers …"; smolvm also while the name's create runs                                                                                                                                                                |
| A second action on a claimed machine is `Conflict{busy}`                                                                     | smolvm: "a taken name is Conflict{exists}, an action on a claimed machine is Conflict{busy} …". Unit: `machines.test.ts`, `checkpoints.test.ts`                                                                                                                                              |
| Tart's two-VM limit refused with `Capacity` before any clone, with nothing written                                           | Tart: "with two VMs running, Apple's limit refuses a third create and a start …"                                                                                                                                                                                                             |
| List fan-out with one host down, and `--json` error tags                                                                     | Unit, as the item says: `apps/clankerbox/tests/host.test.ts`, against the real host process over the fake runtime                                                                                                                                                                            |
| SEA smoke tests on each target                                                                                               | Not the live suites: `tools/release/smoke.sh` (`pnpm sea:smoke`), in CI on both targets                                                                                                                                                                                                      |
| `vp check`, `vp run -r test`, `vp run -r build` on every change                                                              | `vp run ready`, and CI                                                                                                                                                                                                                                                                       |
| Every live run goes through `scripts/work_runs.py`, running `clankerbox host` from its own config                            | All three drivers                                                                                                                                                                                                                                                                            |

### Not covered live, and why

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
  covers fork and restore, whose preparation is the same code.
- **A native name already taken, on Tart and boat:** Tart's native names carry
  the instance like smolvm's, so the smolvm test covers the naming rule; boat
  assigns sandbox IDs itself and the host deletes by the recorded ID.
- **100.100.100.100 and the tailnet route, on Tart:** the item is smolvm's
  egress floor and its host routes; on Tart, Softnet's block of every host
  address is checked instead.
- **List fan-out with a host down:** the unit suite covers it against the real
  host process, as the item says.
