---
name: verify-machine-answers
description: Model-check, with TLA+ and TLC, that a clankerbox machine request's answer is true under every interleaving of concurrent requests, cut-short steps, leases, rechecks and one runtime failure. Use when a change touches packages/host/src/lifecycle.ts, reconcile.ts, leases.ts, the request, step or recheck paths in machines.ts, or the store's desire, before calling it done.
---

# Verify machine answers

## What it proves

**Property.** When `start`, `stop`, `pause` or `delete` answers success, the
VM is what the request asked for, and it stays that way while the machine
rests on that answer, given the bounds below. A `Superseded` answer names something another request
asked for, and once every recorded request has reached the actor, a resting
machine works toward what the store last recorded.

**Harm.** A user or agent told that a machine is stopped while it runs (or
the reverse) acts on a lie. It may exec into a machine it thinks it stopped,
or leave a VM holding RAM. Nothing corrects it until the next recheck, if any
does.

**Why tests can't settle it.** The answer depends on how requests interleave
with steps that later requests cut short. xstate's `@xstate/effect` cancels a
step's fiber when its state exits, without waiting for it (`cancel()` calls
`fiber.interruptUnsafe()`), and the next state's observe starts at once. A
runtime call under way may already have made its change. Only the machine's
lease keeps the next read behind it. `tests/machines.test.ts` checks one such
order. The model checks all of them that keep to the runtime assumption below.

The model is `model/MachineAnswers.tla`: one made machine, its actor, the
store's row, the lease, the recheck loop and the requests. TLC checks these
invariants on every reachable state:

| Invariant          | In plain words                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `AnswerTrue`       | A success answer finds the VM as asked: running, stopped, paused (or stopped, for a pause), or gone |
| `RestTrue`         | A machine resting `settled` holds the state the host last read                                     |
| `SupersededHonest` | `Superseded` names a state another request asked for, never the request's own                      |
| `StoreAgrees`      | Once no recorded desire is in flight, a resting actor's desired and generation are the row's        |
| `AllAnswered`      | (temporal, skipped by `--quick`) every request is answered, given fair scheduling                  |
| `LeaseSound`, `OneLiveInvoke`, `FiberRoom` | sanity checks of the model itself                                          |

## Run it

```sh
.agents/skills/verify-machine-answers/scripts/check.sh --quick   # the invariants, ~30 s
.agents/skills/verify-machine-answers/scripts/check.sh           # and AllAnswered, ~5 min
```

The script needs Java 11 or later on `PATH` and `curl`. It downloads
`tla2tools.jar` v1.8.0 to `~/.cache/clankerbox-tla/` and checks its sha256. Each
run copies `model/` into a fresh directory under `$TMPDIR` and runs TLC there,
so parallel runs never share files and `model/` stays clean. It prints TLC's
verdict. A pass deletes the directory. Any other result keeps it and prints
the paths of `tlc.out`, the full output, and of `trace.json`, the
counterexample, when there is one; delete it once you have read them.

Exit 0 is a pass, 12 a violated invariant, and 13 a violated `AllAnswered`. 11
is a deadlock, a model error such as no free fiber ID. Anything else means the
model or the tools are broken.

## Reading a trace

`tlc.out` lists the counterexample as numbered states. Each state's header
names the action that led to it, such as `<StepApply(1) line ...>`, followed by
every variable's value. `trace.json` holds the same states as data. Read it
state by state: the action, then what changed, mostly `st`, `vm`, `ctx`,
`fib` and `mbox`. Map each action to its code with the coverage table. If you
have pstack's `/pstack:statechart` skill, it tells the same path in plain
words.

## Bounds and assumptions

A pass covers this scope, and only it:

- **One machine, already made**, starting from `running`, `stopped` or `paused`
  as asked, read correctly on the first try. Creation (`creating`, `make`,
  `undone`) and copies (fork, restore, capture) are out. So is a host that
  starts with work due: a VM that differs from `desired`, a first read of
  `unknown`, or a row `startup.ts` marked `deleted`. A start or stop of such a
  row answers `Superseded` by `deleted` though no request asked for it.
- **Two requests**, each any of running, stopped, paused or deleted, at any
  moment. Every invariant and `AllAnswered` hold over all 5,767,482 distinct
  states (`check.sh` on these files, at commit `cf3d4fd`, 4 min 48 s). A
  third request is out of reach: a run of it passed 300 million distinct
  states in 27 minutes with its queue still growing, and was stopped.
- **At most one runtime failure** in the whole run: a failed step, a
  preparation that fails after the VM started, or a read that answers unknown.
- **The runtime changes the VM only in steps**, each change atomic. A step cut
  short may make its change or not, but always before it releases its lease.
  `owning` frees the lease as the step's fiber unwinds, so the runtime holds
  to this: Tart's and smolvm's stops mask interruption from the command that
  halts the VM until they read it halted, as Tart's pause does for its save.
  Starts and smolvm's pause aren't masked; the model assumes a VM one of them
  left part way reads as where it ends up. A change that runs on with the
  lease free violates `RestTrue`: the machine rests `running` and the guest
  then halts. So a runtime call that tells the VM to change and then waits
  masks the same way. The VM never dies or changes by itself. Resize, exec and capture, which run beside the actor, are
  out, as are the pin checks.
- **Lease acquisition is any order the lease allows** (owned excludes everyone,
  shared excludes an owner). That includes orders `leases.ts`'s gate forbids,
  so a pass holds for the real gate too.
- **xstate semantics, read from the installed packages:** the mailbox is FIFO,
  and a cancelled invoke's result is dropped: `active` in `@xstate/effect`'s
  `startHostedEffect` stops one still in its fiber, and xstate's
  `matchesActorSession` one already queued. Leaving a state cancels its
  invoke, the next invoke starts without waiting, and `waitFor` checks the
  snapshot it starts on, then every later one.
- **Rechecks are seconds apart.** A recheck never finds an earlier tell still
  queued. No tailnet: `join` answers at once.
- **The start's preparation isn't checked against the request that asked
  for it.** A second start that arrives while a start runs is answered by that
  start ("a second request for what a step already works toward lets the
  step finish", `tests/lifecycle.test.ts`), even when its preparation had
  already run.

## Coverage and sync

Last confirmed against commit `cf3d4fd` (Release 0.29.1). Each model part
stands for this code:

| Model                                            | Code                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `Next_`, `Decide`                                | `packages/host/src/reconcile.ts` `next`; `lifecycle.ts` `decide`                            |
| `Wanted`, `Again`, `Reread`, `Failing`, `Handle` | `lifecycle.ts` `wanted`, `again`, `reread`, `failing`, `interrupting`, the states' `on` and `onDone` |
| `Satisfies`                                      | `lifecycle.ts` `answer`, `isResting`                                                        |
| `Result`, `By`, `Answer`, `StartWait`            | `packages/host/src/machines.ts` `answered`, `remove`                                        |
| `Pick`                                           | `machines.ts` `settledOn` (the deleted check), `remove`                                     |
| `Record`                                         | `packages/host/src/platform/sqlite.ts` `updateDesire`, via `machines.ts` `sent`             |
| `Ask`                                            | `lifecycle.ts` `ask`, from `machines.ts` `sent`                                             |
| `Init`                                           | `machines.ts` `bornOf`, after `startup.ts`                                                  |
| `Applies`, `Effect`                              | the runtimes' `start`, `stop` and `pause`, `platform/smolvm.ts` and `platform/tart/tart.ts` |
| `Move`, `Deliver`, `Gone`                        | `@xstate/effect` invoke cancellation; `lifecycle.ts` `stepping`, `observing`, `joining`    |
| `ObserveLease`, `ObserveRead`                    | `machines.ts` `observeOne` and its `leases.hold({ machine: shared(name) })`                 |
| `StepLease`, `StepApply`, `StepFail`, `StepAbort`, `StepFinish`, `PrepareFail` | `machines.ts` `owning`, `steps.start`, `steps.stop`, `steps.pause`, `steps.remove`; `leases.ts` |
| `JoinDone`                                       | `machines.ts` `steps.join` with no `Tailnet`                                                |
| `RcSnap`, `RcRead`, `RcTell`                     | `machines.ts` `recheck`, whose `context !== at.life` guard `renewed` models                           |

To see whether a change needs another look, diff the covered files since the
sync commit:

```sh
git diff cf3d4fd -- packages/host/src/lifecycle.ts packages/host/src/reconcile.ts \
  packages/host/src/leases.ts packages/host/src/machines.ts packages/host/src/startup.ts \
  packages/host/src/platform/sqlite.ts packages/host/src/platform/smolvm.ts \
  packages/host/src/platform/tart/tart.ts
```

When a covered function changes, update the matching action so the model
still describes the code, then rerun. Move the sync commit forward only after
you have read the changed code against the model at that commit. A passing
check alone doesn't move it. An `@xstate/effect` or `xstate` bump also
needs the xstate assumptions above re-read in the new dist.

## Reading a failure

1. Read the counterexample (see Reading a trace): the shortest path to the
   violated invariant, state by state.
2. Map each step's action name to its code with the coverage table, and
   replay the order against the real code.
3. **A real bug** is an order the code allows. Report it in the code's words,
   for example: "a start takes the lease; a stop cuts it short; observe reads
   stopped; the machine settles and the stop answers stopped; the cut-short
   start then boots the VM". Don't weaken the invariant or the model to make it
   pass, and don't change product code unless asked.
4. **A modeling error** is a step the code can't take, such as an event the
   real state wouldn't handle. Fix that action and say what you fixed.
5. **An intended change** (new semantics) updates the action and, if the
   promise itself changed, the invariant and this file's plain-words statement.

## Proven able to fail

Each check was run against a broken copy of the code it guards: the code
changed, the mapped action changed to match, TLC run, then both reverted.

| Break                                                                                          | Violated                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `observeOne` reading while a step owns the lease (`ObserveLease` without `own = None`)          | `LeaseSound`                   |
| `observeOne` without its shared lease (`ObserveLease` without `own = None` or the `share` update) | `RestTrue`, then `AnswerTrue` |
| `wanted` without the `desire.generation <= life.generation` guard                              | `StoreAgrees`                  |
| `answered`'s Superseded `by: desired` instead of `by: life.desired`                             | `SupersededHonest`             |
| `answer` waiting for `generation > g` instead of `>= g`                                         | `AllAnswered`                  |

Repeat this kind of break whenever you add an invariant. A check you haven't
seen fail proves nothing.
