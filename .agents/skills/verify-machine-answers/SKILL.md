---
name: verify-machine-answers
description: Model-check, with TLA+ and TLC, that a clankerbox machine request's answer is true under every interleaving of concurrent requests, a control plane crash, a host restart, a partition and lost, repeated or late delivery of operations. Use when a change touches apps/server/src/chart.ts, machine-chart.ts, machines.ts, driver.ts, operations.ts, the store's advance, apps/host/src/operations.ts, or the SDK client's wait, before calling it done.
---

# Verify machine answers

## What it proves

**Property.** When a client's wait on `start`, `stop`, `pause`, `delete` or a
create ends in success, the VM is what the request asked for. A `Superseded`
answer names something another request asked for. A failed create leaves no VM
behind, however late an old delivery arrives. An operation runs once, however
often it is delivered. Every request gets an answer. All of that holds with the
control plane killed at any moment, the host restarted, the link cut, and
deliveries lost, repeated or late, given the bounds below.

**Harm.** A user or agent told that a machine is stopped while it runs (or the
reverse) acts on a lie. A create that a crash left half done must neither leak
a VM nor run its setup twice.

**Why tests can't settle it.** The row, the operation and the VM live in three
places and change at different moments. A control plane can die between
recording an operation and sending it, or after the host finished and before
the report was stored. `apps/server/tests/crash.test.ts` checks a few such
orders. The model checks all of them.

The model is `model/MachineAnswers.tla`: one machine, its row, the operation in
flight, the host's runner, the network, and the clients. It writes no rule of
the row's own: each write is a lookup, `Row(row, event, op)`, in `model/Chart.tla`,
a table `scripts/export-chart.ts` generates by walking every leaf, wish, flag and
abstract event through the real chart, `apps/server/src/machine-chart.ts`, with
`applied`. So the chart TLC checks is the chart that compiles. A stale table
fails `apps/server/tests/machine-chart.test.ts`, with no Java. `check.sh` exports
it first. The export also gives the model the chart's words it reads by name:
`Resting`, the phases a wait ends on; `FailedCreate`, the leaves of a failed
create; and `Undone`. A rename of one fails `vp check` on `export-chart.ts`.

TLC checks these invariants on every reachable state:

| Invariant          | In plain words                                                                       |
| ------------------ | ------------------------------------------------------------------------------------ |
| `AnswerTrue`       | A success answer finds the VM as asked: running, stopped, paused (or stopped), gone  |
| `RestTrue`         | A row resting `settled` with no operation holds the VM it says                       |
| `SupersededHonest` | `Superseded` names what another request asked for, never the request's own           |
| `NoOrphan`         | A failed create once undone, and a deleted machine, leave no VM                      |
| `OnceOnly`         | Each operation runs once, however often it is delivered                              |
| `FailedSays`       | A row resting `failed` carries its error                                             |
| `OpIsState`        | An operation is in flight exactly while the row's leaf has a step                    |
| `AllAnswered`      | (temporal, in `MachineAnswers.cfg`) every request is answered, given fair scheduling |

## Run it

```sh
.agents/skills/verify-machine-answers/scripts/check.sh --quick   # two clients, about 1 min
.agents/skills/verify-machine-answers/scripts/check.sh           # and every fault with AllAnswered, about 6 min
vpx .agents/skills/verify-machine-answers/scripts/breaks.ts      # every break below, or those named
```

`check.sh` and `breaks.ts` run TLC through `scripts/tlc.sh`, which holds its
flags. It needs Java 11 or later on `PATH` and `curl`, and downloads
`tla2tools.jar` v1.8.0 to `~/.cache/clankerbox-tla/` and keeps it there. That
tag is a rolling prerelease that TLA+'s CI rebuilds from master on every push,
so a machine runs the build it first fetched; delete the jar to take the latest.
Each `check.sh` run copies `model/` into a fresh directory under `$TMPDIR` and
runs TLC there, so parallel runs never share files and `model/` stays clean. It
prints TLC's verdict and distinct state count for each config. A pass deletes
the directory. Any other result keeps it and prints the paths of `tlc.out`, the
full output, and of `trace.json`, the counterexample, when there is one; delete
it once you have read them.

Exit 0 is a pass, 12 a violated invariant, 13 a violated `AllAnswered`, and 11
a deadlock: a row no action can move. Anything else means the model or the
tools are broken.

## Reading a trace

`tlc.out` lists the counterexample as numbered states. Each state's header
names the action that led to it, such as `<Collect line ...>`, followed by
every variable's value. `trace.json` holds the same states as data. Read it
state by state: the action, then what changed, mostly `row`, `vm`, `runs` and
`net`. Map each action to its code with the coverage table.

## Bounds and assumptions

A pass covers this scope, and only it:

- **One machine**, created once. Copies (fork, restore, capture), resize and
  the tailnet join are out, so a resize's `Operation.to`, and a failing step
  giving way to a resize owed, rest on `apps/server/tests`. A make's report may
  say it prepared the machine, as a copy's does, so the row rests with no start;
  the make is otherwise the scripted one below.
- **The table holds what the model holds of a row**: its leaf, wish, `prepared`
  and whether it has an error, and a make's report that it prepared the
  machine. A key it lacks is an event the chart leaves unhandled. `resize`,
  `sized`, `refused`, `ran`, `adopted`, a report's `move` and the rest of what a report
  tells rest on `machine-chart.test.ts`.
- **`MachineAnswers.cfg`**: one client beside the creator, with one of each
  fault: a step or read that fails, a control plane crash, a partition, a host
  restart and a lost delivery, and nine operations. Every invariant and
  `AllAnswered` hold over every reachable state. A run takes about 5 minutes.
- **`TwoClients.cfg`**: two clients beside the creator, with a crash and a
  partition and no other fault, and seven operations. Every invariant holds over
  every reachable state. A run takes about 1 minute. `AllAnswered` is not
  checked here.
- **`ThreeClients.cfg`**: three clients beside the creator, with no fault, and
  five operations. Every invariant holds over every reachable state. A run
  takes about 90 seconds. It is the one config where two cuts let a stale
  request land, which an answer of `lost` for a cut step never delivered breaks
  within seconds.
- **Both at once is out of reach.** When last tried, two clients with every
  fault ran for about 40 minutes, past 150 million distinct states, with no
  violation and its queue still growing, and was stopped. That is evidence, not
  a proof.
- **The setup script is lost with the control plane's memory**, as in the code.
  A make not yet delivered when the process dies is undone.
- **The runtime changes the VM only in steps**, each change atomic. A step cut
  short may make its change or not, and reports `cancelled` only once it ended,
  which is what Tart's and smolvm's masked stops give. A VM changes by itself
  never, and a host's restart leaves it where it is.
- **The sequence fence is global.** The model's operation ID is its sequence,
  and the host's `high` stands for the scope's sequence, which is one scope
  here. A fence per scope is the same for one machine.
- **An unscripted make is out.** The model's make always has a script, so
  `CanSend` covers only one the process still holds. The code also sends again a
  make with no script.
- **Only a definite failure moves a row.** The move to another host on
  `Capacity` is out; the model's create has one host.
- **A client's read fails with the link.** `Shown` is `waiting` only when the
  link is cut, though the code also shows it when the runtime can't read one
  machine. That read's fault reaches `Read`, which writes nothing either way.
- **A step may begin over a cut link.** `Decide` records a make or a delete with
  the boot it last knew, where a loop reads the host first for the boot its `read`
  event carries, and rests when it can't. The model is the wider of the two.

## Coverage and sync

Last confirmed against the commit that adds this table. Each model part stands
for this code:

| Model                            | Code                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| `Row`, `To`, `Chart.tla`         | `apps/server/src/chart.ts` `applied`; `machine-chart.ts`, the whole chart  |
| `Phase`, `IsStep`                | `machine-chart.ts` `phaseOf`, a leaf's `step`                              |
| `Wants`                          | `machine-chart.ts` `wants`, for a cut and for a failure                    |
| `Decide`                         | `machine-chart.ts` `read`; `machines.ts` `looking`; `store.advance`        |
| `Create`                         | `apps/server/src/machines.ts` `born`, `store.insertMachine`                |
| `Request`                        | `machine-chart.ts` `ask`, `delete`; `machines.ts` `asked`, `remove`        |
| `Read`                           | `machine-view.ts` `stateOf`                                                |
| `Send`, `Cut`                    | `apps/server/src/operations.ts` `poll`                                     |
| `Collect`                        | `machine-chart.ts` `reported`, `lost`; `machines.ts` `following`; `operations.ts` `poll`, `collect`; `store.advance` |
| `Deliver`, `Repeat`, `Lose`      | `apps/host/src/operations.ts` `run`, its boot and sequence fence           |
| `HostStep`, `HostFail`           | `apps/host/src/operations.ts` `perform`, and `picking`, `made` for a make, which may report it prepared |
| `HostCancel`                     | `apps/host/src/operations.ts` `cancel`, `ended`                            |
| `HostRestart`                    | a new process: `Operations.boot`, empty `entries` and `scopes`             |
| `Crash`, `Revive`                | a new process: the store stays, `creates` goes; `machines.ts` start-up     |
| `Shown`                          | `machine-view.ts` `phaseShown`, in `Machines.get` and `list`               |
| `Answer`                         | `packages/sdk/src/client.ts` `machineRest`, `machineGone`, `answerOf`      |

A change to the chart needs no change here: rerun `check.sh`, which exports it.
When any other covered function changes, update the matching action so the model
still describes the code, then rerun. Move the sync commit forward only after you have
read the changed code against the model at that commit. A passing check alone
doesn't move it.

## Reading a failure

1. Read the counterexample (see Reading a trace): the shortest path to the
   violated invariant, state by state.
2. Map each step's action name to its code with the coverage table, and
   replay the order against the real code.
3. **A real bug** is an order the code allows. Report it in the code's words,
   for example: "the control plane records a make, dies, comes back with no
   setup; the host never had it; the row must be undone, and the remove's higher
   sequence must fence a late delivery". Don't weaken the invariant or the model
   to make it pass, and don't change product code unless asked.
4. **A modeling error** is a step the code can't take. Fix that action and say
   what you fixed.
5. **An intended change** (new semantics) updates the action and, if the
   promise itself changed, the invariant and this file's plain-words statement.

## Proven able to fail

`scripts/breaks.ts` breaks a copy of the chart or the model, re-exports the table
and runs TLC, for each row here, and stops at an edit that finds nothing to
change.

| Break                                                        | In    | Violated           |
| ------------------------------------------------------------ | ----- | ------------------ |
| `ask` leaves the row at rest                                 | chart | `RestTrue`         |
| A start's report rests the row settled without a new read    | chart | `RestTrue`         |
| A read that fails writes a rest                              | chart | `RestTrue`         |
| A prepared make's report rests the row settled without a read | chart | `RestTrue`         |
| A failed make skips undoing and rests undone                 | chart | `NoOrphan`         |
| Failing a step records no error                              | chart | `FailedSays`       |
| A report enters a leaf with a step                           | chart | `OpIsState`        |
| The host accepts any delivery: no sequence or boot fence     | model | `OnceOnly`         |
| A client answers without waiting for rest                    | model | `AnswerTrue`       |
| `Superseded` names what the client asked                     | model | `SupersededHonest` |
| A make the host never got is never given up                  | model | deadlock           |
| A host restart isn't noticed                                 | model | `AllAnswered`      |

The last two rows break `Collect`, which stands for `poll`, outside the chart. An
edge taken off the chart isn't a deadlock: `Collect` clears the operation and
`OpIsState` fails.

Two breaks pass, on purpose, and `breaks.ts` fails if they stop passing.

`no-overtaken` rests every failure `failed`, also of a step no longer wanted, and
broke nothing over `MachineAnswers.cfg`, with `AllAnswered`. So a report's `wants`
is a product rule and not safety: the machine moves to what is asked in place of
a client reading a failure of what it no longer wants. A failure reads what is
asked now: a wish that goes stopped, running, stopped during a stop that fails
rests failed with its error, and a repeated request answers that failure with no
more tries. `TwoClients.cfg` injects no failure, so this break only counts on the
full config.

`stop-keeps-prepared` leaves `prepared` set across a stop. It broke nothing here,
as `ask` clears it for a start in the write that records the request, and the
model's VM changes only under a step.

The chart has no generation. A write decides from the row as it stands, a request
leaves rest in that write, and a VM changes only under an operation, so a read
from before a request is still true of the VM when it is decided. No invariant
needed more.

`Shown` has no such row. A client that reads the stored phase, or that reads
`waiting` over a failed row, gets a different answer, and no invariant reads the
difference: both ran clean over both configs. `apps/server/tests/machines.test.ts`
holds what it shows.

Repeat this kind of break whenever you add an invariant. A check you haven't
seen fail proves nothing.
