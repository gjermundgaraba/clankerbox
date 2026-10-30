---
name: verify-clankerbox
description: Prove a clankerbox change the way a user sees it, by driving the built `clankerbox` CLI, from a scratch HOME, against a real host served over the fake runtime. Use after changing a command, the client, the contract, routes or the host, to show the change working end to end before calling it done; not a proof of anything smolvm or Tart does.
---

# Verify clankerbox

The user's surface is the `clankerbox` CLI talking to a host over HTTP.
`packages/host/tests/serve.ts` serves a real host (store, actors, routes, HTTP)
through `startHost` over the fake runtime the host's tests use. The CLI is the
built `apps/clankerbox/dist/clankerbox.mjs`, run with `HOME` set to a scratch
directory the host made. It reads its default config path there and keeps its
SSH config there, as a user's does, and never touches yours.

`apps/clankerbox/tests/host.test.ts` already runs most flows this way in CI,
from source and with `--config`. This skill adds the built CLI, the default
config path with its SSH config sync, and a place to drive the exact change
you made. [`features/README.md`](features/README.md) maps each feature to its
CI test and to the commands that drive it here.

Linux or macOS, with `vp install` done.

```sh
S=.agents/skills/verify-clankerbox/scripts
RUN=$($S/launch.sh)                  # or: $S/launch.sh mac, $S/launch.sh linux 2048
$S/cb.sh "$RUN" create dev --base ubuntu --cpu 1 --ram 1G --disk 10G
$S/cb.sh "$RUN" get linux_dev --json
$S/cleanup.sh "$RUN"
```

## Launch

`launch.sh [linux|mac] [ram-budget-mib]` records the tree of the sources it
builds, builds every package, makes a fresh run directory under `$TMPDIR`,
starts the host in the background and waits until it serves. It prints the
host's URL on stderr and the run directory on stdout. A build or start that
fails prints its log and the evidence directory. Each launch is a new run:
runs never share a directory, port or evidence.

While the host serves, the run directory holds `ready` (its URL), `host.pid`,
`home` (the path of the scratch HOME) and `evidence/`. When the host stops on
`TERM` it removes all but `evidence/`, and its scratch directory with the
store, the machines' roots and the HOME. `evidence/` holds:

| File                | What                                                      |
| ------------------- | --------------------------------------------------------- |
| `sources`           | the git tree of the sources built, for the report         |
| `build.log`         | the build's output                                        |
| `host.log`          | the host's log, warnings included                         |
| `runtime-calls.txt` | one line per runtime call as it happens, such as `capture linux_snap` |
| `transcript.txt`    | each `cb.sh` command as a JSON argv, its output and `[exit N]` |

The host's ID is its kind, so machines are `linux_<name>` or `mac_<name>`. The
base is `ubuntu` on linux and `macos` on mac. The recheck runs every 5 seconds.
The optional budget is the RAM, in MiB, that the host refuses to pass. The
HOME's config has the profile `web`: the kind's base, 1 vCPU, 1G RAM and 10G
disk, with the setup `web-recipe.sh`, which writes `$CLANKERBOX_ROOT/recipe-ran`.

## Doctor

`$S/cb.sh "$RUN" hosts --json` is the one check to run first, and again when
anything looks off. It's healthy with exit 0, a host whose `id` is the run's
kind, `runtimeVersion` `fake`, and an empty `unreachable`. Exit 3 is `cb.sh`
refusing: launch a new run.

## Drive

`cb.sh <run> <clankerbox args...>` runs the built CLI as the run's user, with
`CLANKERBOX_SSH_CONFIG=true`. It passes on the CLI's stdout and stderr and its
exit code, and appends both streams to `evidence/transcript.txt`.

It refuses, with exit 3, when the run's host is gone or when the sources'
tree differs from the one the run built, as after an edit, a new file or a
deletion. Test files don't count. In either case, launch a new run.

- IDs are `<host>_<name>`. Flags go before `--`, and the guest's argv after it.
- Assert on `--json`: the result, or `{"error":{"tag":...,"retryable":...}}`
  with exit 1. Check tags and fields, not wording.
- Under the fake, setup scripts and `exec` run **on this machine**, as you, with
  `CLANKERBOX_ROOT` as the guest's root and your own `HOME`. Only touch paths
  under `$CLANKERBOX_ROOT`.
- A setup must leave the login user `admin` and `sudo`, as on a real stock
  image (README's setup section). Start one from `web-recipe.sh`.

## Evidence

A proof is the transcript of your commands, plus:

- **a second read through the CLI**: `get --json` after a mutation,
  `checkpoint list` after a capture;
- **the runtime's side**: `evidence/runtime-calls.txt`;
- **errors by tag** in `--json`.

Drive only the CLI. Don't call the host's routes or read its database.
Failures in the runtime itself belong in `packages/host/tests/`. Report the
evidence directory and its `sources` with the result.

## Cleanup

`cleanup.sh <run>` stops the host this run started, and only while its PID
still runs `serve.ts` for this run; the host then removes what it made. It
deletes nothing itself. A host that died or needed `KILL` removes nothing, so
`cleanup.sh` prints its scratch directory: delete that too. Run it after every
run, failed ones included, and never kill by process name. Delete the run
directory once you have reported the evidence.

## What this does not prove

The fake stands in for the VM, so this proves none of:

- a VM's boot, pause, resume or stop under smolvm or Tart, or its pin;
- what a capture, fork or restore copies;
- setup and preparation in a real guest;
- `ssh`, `ssh-proxy` and `amp-orb`'s spawn (see the index);
- the tailnet.

Proving those takes a `linux` host with KVM and the pinned smolvm
(`bump-smolvm`), or a Mac with Tart (`bump-tart`), running `clankerbox host
--config`.
