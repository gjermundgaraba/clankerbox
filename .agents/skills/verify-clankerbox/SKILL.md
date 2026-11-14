---
name: verify-clankerbox
description: Prove a clankerbox change the way a user sees it, by driving the built `clankerbox` CLI, from a scratch HOME, against a real control plane over real hosts served on the fake runtime. Use after changing a command, the client, a contract, routes, the server or a host, to show the change working end to end before calling it done, or to kill the control plane or a host mid-step; not a proof of anything smolvm or Tart does.
---

# Verify clankerbox

The user's surface is the `clankerbox` CLI talking to a control plane over HTTP.
`apps/host/tests/serve.ts` serves a real host (operations, routes, HTTP) over the
fake runtime the host's tests use, and `apps/server/tests/serve.ts` a real
control plane (store, loops, routes, HTTP) over those hosts, with real HTTP
between them. The CLI is the built `apps/cli/dist/clankerbox.mjs`, run with
`HOME` set to a scratch directory the server made. It reads its default config
path there and keeps its SSH config there, as a user's does, and never touches
yours.

`apps/cli/tests/stack.test.ts` already runs most flows this way in CI, from
source and with `--config`. This skill adds the built CLI, the default config
path with its SSH config sync, killed processes, and a place to drive the exact
change you made. [`features/README.md`](features/README.md) maps each feature to
its CI test and to the commands that drive it here.

Linux or macOS, with `vp install` done.

```sh
S=.agents/skills/verify-clankerbox/scripts
RUN=$($S/launch.sh)                  # or: $S/launch.sh tart, $S/launch.sh smolvm 2048 2, $S/launch.sh fixed:1,smolvm:1
$S/cb.sh "$RUN" create dev --base ubuntu --cpu 1 --ram 1G --disk 10G
$S/cb.sh "$RUN" get dev --json
$S/cleanup.sh "$RUN"
```

## Launch

`launch.sh [fleet] [ram-budget-mib] [hosts]` records the tree of the sources
it builds, builds the CLI, makes a fresh run directory under `$TMPDIR`,
starts the hosts and the control plane in the background and waits until they
serve. It prints the control plane's URL on stderr and the run directory on
stdout. A build or start that fails prints its log and the evidence directory.
Each launch is a new run: runs never share a directory, port or evidence.

The fleet is a runtime, `smolvm` by default, with `hosts` of it, 1 by default:
`launch.sh smolvm 2048 2`. Or it is `runtime:count` entries, comma-separated,
with no `hosts` argument: `launch.sh fixed:1,smolvm:1`. Hosts start in the
fleet's order and are named `<runtime>-<n>`, numbered per runtime: `fixed-1`,
`smolvm-1`. Each fakes its runtime with that runtime's traits:

- `smolvm` and `tart`, as the real runtimes are;
- `fixed`, which stands for no provider: size classes (`small` 1 vCPU, 1G, 10G;
  `default` 2, 4G, 20G; `large` 4, 8G, 40G), a pause that stops, disk
  checkpoints, machines that stop unasked, and machines that carry the host's
  mark, so that at each recheck the host deletes what it marked whose instance
  the control plane retired and no step it holds names. Its base is `ubuntu`;
- `smol-cloud` and `boat`, which are no fake runtimes: each is the real
  adapter over a fake of its provider's API, `fake-smol-cloud.ts` or
  `fake-boat.ts`, that runs as its own process so it outlives a host
  `fault.sh` kills, shared by every host of that runtime in the run. Its base
  is `ubuntu`, and it takes no budget. On `smol-cloud`, `drift` is refused, as a
  smol cloud host isn't told a machine's instance by its name. On `boat`, each
  sandbox's SSH is a relay the fake opens, and the host's `ssh` runs the command
  on this machine once the fake admits its key, host key alias and `--`; a create
  takes one of boat's types, `small` (2 vCPUs, 4G, 80G), `default` (4, 8G, 80G)
  or `large` (8, 16G, 149G); a capture or fork takes a stopped machine; and
  `CLANKERBOX_FAKE_BOAT_WARM_SECONDS` sets how long a stopped sandbox stays warm,
  so a start within it spends no start, which the fake keeps for minutes
  otherwise. Set `CLANKERBOX_FAKE_TAILNET=1` for `fault.sh start-host` too, or
  the restarted host joins nothing.

A host runs `apps/host/tests/<runtime>/serve.ts` where its runtime has one, and
`apps/host/tests/serve.ts` otherwise. Each is a thin entry over
`apps/host/tests/serving.ts`, which serves a host for the run's protocol and, for
a provider, its fake API and the faults it takes.

The budget applies to each host. A `fixed` host's fake has no admission, so no
start there is checked against it; it shows only as the limit its `capacity`
reports. The control plane lists its hosts as it finds them in `hosts/`, not in
the fleet's order, so name a host with `--host` where placement matters.


While it serves, the run directory holds `runtime` (the first host's runtime,
whose base the recipes name), `server.ready` and `server.url` (the control
plane's URL), `server.pid`, `hosts/<id>.url`, `hosts/<id>.pid` and
`hosts/<id>.runtime`, `home` (the path of the scratch HOME), `recipes/`,
`server-state`, `runtimes/<id>` (what a fake runtime keeps on disk, which
outlives its host as a real runtime's does) and `evidence/`.
`evidence/` holds:

| File                | What                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `sources`           | the git tree of the sources built, for the report                     |
| `build.log`         | the build's output                                                    |
| `server.log`        | the control plane's log, warnings included                            |
| `host-<id>.log`     | that host's log                                                       |
| `runtime-calls.txt` | one line per runtime call as it happens, such as `capture snap`; `find <name>` each time the host searches its runtime for a machine whose handle it wasn't given; and on `tart`, whose fake is relayed as Tart is, `relay <name>` each time a relay opens |
| `transcript.txt`    | each `cb.sh` command as a JSON argv, its output and `[exit N]`, and each fault |
| `<provider>-calls.txt` | on `smol-cloud` or `boat`, one line per call the fake API answers, `METHOD /path STATUS` with no body, and on `boat` `dropped` where `drop-answer` lost the answer |
| `boat-requests.jsonl` | on `boat`, the same calls, each with its JSON body, so a proof can show what reached the provider and what didn't |
| `<provider>-api.log` | the fake API's own log                                         |

The control plane's authorized keys are `server-keys.pub`, read at each start.
It holds the test operator key and is kept across restarts: append a key, then
`fault.sh <run> kill-server` and `start-server`, to rotate them. The HOME's
config names no keys.

IDs are bare names. The base is `macos` on tart and `ubuntu` on every other
runtime. A create on a fixed or boat host takes one class's sizes, and the
recipes' template files name `small`'s on boat. The recheck
runs every 2 seconds. The optional budget is the RAM, in MiB, that a host refuses
to pass. The run has two recipes, each a directory with a `setup.sh`, and
beside each a template file naming it with the runtime's base and 1 vCPU, 1G of
RAM and a 10G disk, or on boat 2 vCPUs, 4G and 80G: `$S/cb.sh "$RUN" template build "$RUN/recipes/web.yaml"`
builds the template `web`, and a copy beside it under another name builds
another. A create runs no setup. `$RUN/recipes/web` writes `$RUN/recipe-ran`.
`$RUN/recipes/slow` touches `$RUN/setup-began` and waits for
`fault.sh <run> setup-go`, so a template build can be caught mid-setup.

## Doctor

`$S/cb.sh "$RUN" hosts --json` is the one check to run first, and again when
anything looks off. It's healthy with exit 0 and each host `up`, with
`runtimeVersion` `fake` on a fake runtime, and its adapter's API version on
`smol-cloud` and `boat`. Exit 3 is `cb.sh` refusing: launch a new run.

## Drive

`cb.sh <run> <clankerbox args...>` runs the built CLI as the run's user, with
`CLANKERBOX_SSH_CONFIG=true`. It passes on the CLI's stdout and stderr and its
exit code, and appends both streams to `evidence/transcript.txt`.

It refuses, with exit 3, when the sources' tree differs from the one the run
built, as after an edit, a new file or a deletion. Test files don't count. Then
launch a new run. A control plane that is down answers `Unavailable`, exit 1.

- Flags go before `--`, and the guest's argv after it.
- Assert on `--json`: the result, or `{"error":{"tag":...,"retryable":...}}`
  with exit 1. Check tags and fields, not wording.
- `--no-wait` answers once the request is recorded. `get --json` shows `phase`.
- Under the fake, setup scripts run **on this machine**, as you, with
  `CLANKERBOX_ROOT` as the guest's root and your own `HOME`. Only touch paths
  under `$CLANKERBOX_ROOT`.
- The host prepares the base before a setup, as on a real host (README's setup
  section), and runs the setup through the fake's `sudo` as `admin`, with
  `HOME` at `$CLANKERBOX_ROOT/home/admin`. Start one from
  `$RUN/recipes/web/setup.sh`.

## Faults

`fault.sh <run> kill-server` sends `KILL` to the control plane and
`fault.sh <run> start-server` starts it again on the same port and state.
`fault.sh <run> kill-host <id>` kills a host, `fault.sh <run> stop-host <id>`
stops it with `TERM`, as its unit's stop does, and `fault.sh <run> start-host <id>`
starts either again on the same port under a new `boot`.
`fault.sh <run> freeze-host <id>` sends `STOP` to a host, so every call to it
times out while it keeps its machines and steps, and `fault.sh <run> thaw-host
<id>` sends `CONT`.
`fault.sh <run> hold-capture <id>` makes a host hold its next capture until it
dies, as the fake's captures are too quick for a kill to catch one.
`fault.sh <run> drift <id> <machine>` has a fixed or boat host's fake stop that
running machine on its own, as `drift <machine>` in `runtime-calls.txt` on
fixed; the control plane starts it again, a `start <machine>`, at the next
recheck that reads it.
`fault.sh <run> land-late <id>` has the host's fake fail its next make and
make the machine anyway 5 seconds later, as `landed <machine>` on fixed. The
failed make's undo searches for the machine well within that and finds nothing,
so the row rests undone with its instance retired, and the host's sweep deletes
the machine at the first recheck after it lands, logging `sweep: deleting machine <instance> (<handle>)` in
`host-<id>.log`, and `delete <instance>` in `runtime-calls.txt` on fixed.
`fault.sh <run> quota <id> on|off` has the host's fake refuse every make for
want of room until it is off, which a create reads as `Capacity`.
`fault.sh <run> drop-answer <id> make|delete` has the host's fake do its next
make or delete and lose the answer, so the host finds or retries it.
`fault.sh <run> repin <id> <pin>` has a fake runtime's host run another
runtime pin from then on, keeping its machines, as an operator's runtime upgrade
leaves a VM booted under the old one; the fake's pin is `fake 1` on `smolvm`,
and none on `tart` and `fixed`.
`fault.sh <run> setup-go` lets the `slow` recipe's setup finish. Each is written
to the transcript.

`hold-capture`, `drift`, `land-late`, `quota`, `drop-answer` and `repin` ask the host itself: `fault.sh` writes
the fault to `hosts/<id>.fault`, sends the host `USR2`, and waits up to 10
seconds for its answer, `hosts/<id>.fault.ok` or `hosts/<id>.fault.refused`. The
host logs the answer as a `fault:` line in `host-<id>.log`, with its time, and
`fault.sh` writes it to the transcript. A refusal also goes to stderr, with exit
1: `smolvm` and `tart`, whose fakes keep their machines running, refuse
`drift`, as does `smol-cloud`, which isn't told a machine's instance by its
name, and any host with no running machine of that name; one whose fake marks nothing refuses `land-late`, since nothing would
sweep what landed; and `boat` refuses `hold-capture`, and `smol-cloud` and `boat` refuse `repin`. A host started with `CLANKERBOX_FAKE_FAIL_FIND` set to
names, comma-separated, as by `start-host` or `upgrade.sh`, fails each search
for a machine of those names, as smolvm does when its database is locked.

What a kill catches decides the outcome:

| When the control plane dies                 | Where it must end                                       |
| ------------------------------------------- | ------------------------------------------------------- |
| A create's make, before or after it reached the host | The restart sends it, or finds it by ID, and the machine is `settled` |
| A template build, during its setup          | The setup died with the process: the build is `failed`, the template's current build is as it was, and the builder is gone from the host |

Run the second with `template build "$RUN/recipes/slow.yaml" --no-wait`,
waiting for `$RUN/setup-began` before the kill.
`apps/server/tests/crash.test.ts` covers the first, which a user can't time
from the CLI.

So does what a restarted host held:

| What the host held when it died     | Where it must end                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| A capture                           | `capturing` while the host is down, then `failed` with its error: the row went `discarding`, which a client reads as `failed`, and the restarted host deletes the checkpoint its runtime names for that instance, which holds nothing, as `deleteCheckpoint <name>` in `runtime-calls.txt` |
| A delete of a checkpoint            | `deleting` while the host is down, then `NotFound`                              |

Run them with `hold-capture <id>`, then `checkpoint capture <machine> <name>
--no-wait`, then `kill-host <id>`. For the second, ask `checkpoint delete <name>
--no-wait` before `start-host <id>`.

## Upgrade

`upgrade.sh <run> <worktree>` moves a run to the build of another tree, as an
operator upgrades a control plane and its hosts. It stops the run's control
plane and hosts with `cleanup.sh`, rewrites a run's `kind` file (`linux` or
`mac`, as launches before runtimes wrote) to its `runtime` (`smolvm` or `tart`),
as an operator rewrites a host config's `kind`, gives each host of a run
launched before fleets a `hosts/<id>.runtime` of the run's `runtime`, records the worktree's sources,
builds it, and starts its hosts under the same IDs and ports and its control
plane on the same port and state. Run it from the worktree it names, so that
tree's `cb.sh` drives the run: launch from a trunk worktree, drive it, then
`$S/upgrade.sh "$RUN" "$PWD"` here. Its `cleanup.sh` stops a `smol-cloud` or
`boat` run's fake API with the hosts, so every host restarts with no machines,
whatever its runtime, and each machine reads `missing` while its row keeps what
the old build stored.

## Evidence

A proof is the transcript of your commands, plus:

- **a second read through the CLI**: `get --json` after a mutation,
  `checkpoint list` after a capture;
- **the runtime's side**: `evidence/runtime-calls.txt`;
- **errors by tag** in `--json`.

Drive only the CLI, plus `fault.sh`. Don't call a host's routes or read the
database. Failures in the runtime itself belong in `apps/host/tests/`. Report the
evidence directory and its `sources` with the result.

## Cleanup

`cleanup.sh <run>` stops the control plane and the hosts this run started, and
only while each PID still runs `serve.ts` for this run. It deletes nothing
itself. A stopped host removes its scratch directory under `$TMPDIR`, and a host
killed with `fault.sh` leaves it behind. Run it after every run, failed ones
included, and never kill by process name. Delete the run directory once you have
reported the evidence.

## What this does not prove

The fake stands in for the VM, so this proves none of:

- a VM's boot, pause, resume or stop under smolvm or Tart, or its pin;
- what smol cloud's or boat's real API answers, which only its live suite under
  `apps/host/tests/live/` shows, on the operator's account;
- what a capture, fork or restore copies;
- setup and preparation in a real guest;
- `ssh` and `ssh-proxy` (see the index);
- the tailnet;
- what a restarted host keeps of its VMs: on `smolvm`, `tart` and `fixed`,
  `start-host` starts a new fake with no machines, so each of its machines reads
  `missing`, where a real runtime keeps its VMs. It keeps every checkpoint the
  host's runtime held, in `runtimes/<id>`, as a real runtime keeps them on disk,
  so a create from a template build after a restart restores from it. On
  `smol-cloud` and `boat` the fake API
  is its own process and outlives the host, so the restarted host finds its
  machines there and each reads as it was, such as `running`.

Proving those takes a Linux host with KVM and the pinned smolvm
(`bump-smolvm`), or a Mac with Tart (`bump-tart`), running
`clankerbox-host --config` behind `clankerbox-server --config`.
