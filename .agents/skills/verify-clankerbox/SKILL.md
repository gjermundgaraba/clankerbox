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
RUN=$($S/launch.sh)                  # or: $S/launch.sh mac, $S/launch.sh linux 2048 2
$S/cb.sh "$RUN" create dev --base ubuntu --cpu 1 --ram 1G --disk 10G
$S/cb.sh "$RUN" get dev --json
$S/cleanup.sh "$RUN"
```

## Launch

`launch.sh [linux|mac] [ram-budget-mib] [hosts]` records the tree of the sources
it builds, builds every package, makes a fresh run directory under `$TMPDIR`,
starts the hosts and the control plane in the background and waits until they
serve. It prints the control plane's URL on stderr and the run directory on
stdout. A build or start that fails prints its log and the evidence directory.
Each launch is a new run: runs never share a directory, port or evidence.

Hosts are named `<kind>-<n>`: `linux-1`, `linux-2`. The budget applies to each.

While it serves, the run directory holds `server.ready` and `server.url` (the
control plane's URL), `server.pid`, `hosts/<id>.url` and `hosts/<id>.pid`, `home`
(the path of the scratch HOME), `server-state` and `evidence/`. `evidence/` holds:

| File                | What                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `sources`           | the git tree of the sources built, for the report                     |
| `build.log`         | the build's output                                                    |
| `server.log`        | the control plane's log, warnings included                            |
| `host-<id>.log`     | that host's log                                                       |
| `runtime-calls.txt` | one line per runtime call as it happens, such as `capture snap`       |
| `transcript.txt`    | each `cb.sh` command as a JSON argv, its output and `[exit N]`, and each fault |

IDs are bare names. The base is `ubuntu` on linux and `macos` on mac. The recheck
runs every 2 seconds. The optional budget is the RAM, in MiB, that a host refuses
to pass. The HOME's config has two profiles, each with the kind's base, 1 vCPU,
1G RAM and 10G disk. `web` has the setup `web-recipe.sh`, which writes
`$RUN/recipe-ran`. `slow` has a setup that touches `$RUN/setup-began` and waits
for `fault.sh <run> setup-go`, so a create can be caught mid-make.

## Doctor

`$S/cb.sh "$RUN" hosts --json` is the one check to run first, and again when
anything looks off. It's healthy with exit 0 and each host `up` with
`runtimeVersion` `fake`. Exit 3 is `cb.sh` refusing: launch a new run.

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
- A setup must leave the login user `admin` and `sudo`, as on a real stock
  image (README's setup section). Start one from `web-recipe.sh`.

## Faults

`fault.sh <run> kill-server` sends `KILL` to the control plane and
`fault.sh <run> start-server` starts it again on the same port and state.
`fault.sh <run> kill-host <id>` kills a host. `fault.sh <run> setup-go` lets the
`slow` profile's setup finish. Each is written to the transcript.

The make a kill catches decides the outcome:

| When the control plane dies                 | Where it must end                                       |
| ------------------------------------------- | ------------------------------------------------------- |
| After the make reached the host             | The restart finds it by ID and the machine is `settled` |
| Before the make reached the host            | The setup died with the process: `failed`, state `missing`, its error says so, and no VM on the host |

Run the first with `slow` and `--no-wait`, waiting for `$RUN/setup-began` before
the kill. `apps/server/tests/crash.test.ts` covers the second, which a
user can't time from the CLI.

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
- what a capture, fork or restore copies;
- setup and preparation in a real guest;
- `ssh` and `ssh-proxy` (see the index);
- the tailnet.

Proving those takes a `linux` host with KVM and the pinned smolvm
(`bump-smolvm`), or a Mac with Tart (`bump-tart`), running
`clankerbox-host --config` behind `clankerbox-server --config`.
