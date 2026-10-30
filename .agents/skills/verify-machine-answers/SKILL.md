---
name: verify-machine-answers
description: Model-check, with TLA+ and TLC, that a clankerbox machine request's answer is true under every interleaving of concurrent requests, a control plane crash, a host restart, a partition and lost, repeated or late delivery of operations. Use when a change touches apps/server/src/machines.ts, reconcile.ts, operations.ts, the store's desire, begin or finish, apps/host/src/operations.ts, or the SDK client's wait, before calling it done.
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
flight, the host's runner, the network, and the clients. TLC checks these
invariants on every reachable state:

| Invariant          | In plain words                                                                       |
| ------------------ | ------------------------------------------------------------------------------------ |
| `AnswerTrue`       | A success answer finds the VM as asked: running, stopped, paused (or stopped), gone  |
| `RestTrue`         | A row resting `settled` with no operation holds the VM it says                       |
| `SupersededHonest` | `Superseded` names what another request asked for, never the request's own           |
| `NoOrphan`         | A failed create once undone, and a deleted machine, leave no VM                      |
| `OnceOnly`         | Each operation runs once, however often it is delivered                              |
| `FailedSays`       | A row resting `failed` carries its error                                             |
| `AllAnswered`      | (temporal, in `MachineAnswers.cfg`) every request is answered, given fair scheduling |

## Run it

```sh
.agents/skills/verify-machine-answers/scripts/check.sh --quick   # two clients, about 1 min
.agents/skills/verify-machine-answers/scripts/check.sh           # and every fault with AllAnswered, up to 9 min
```

The script needs Java 11 or later on `PATH` and `curl`. It downloads
`tla2tools.jar` v1.8.0 to `~/.cache/clankerbox-tla/` and keeps it there. That
tag is a rolling prerelease that TLA+'s CI rebuilds from master on every push,
so a machine runs the build it first fetched; delete the jar to take the latest.
Each run copies `model/` into a fresh directory under `$TMPDIR` and runs TLC there,
so parallel runs never share files and `model/` stays clean. It prints TLC's
verdict for each config. A pass deletes the directory. Any other result keeps
it and prints the paths of `tlc.out`, the full output, and of `trace.json`, the
counterexample, when there is one; delete it once you have read them.

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
  the tailnet join are out.
- **`MachineAnswers.cfg`**: one client beside the creator, with one of each
  fault: a step or read that fails, a control plane crash, a partition, a host
  restart and a lost delivery, and nine operations. Every invariant and
  `AllAnswered` hold over all 9,034,147 distinct states, 5 to 8 minutes.
- **`TwoClients.cfg`**: two clients beside the creator, with a crash and a
  partition and no other fault, and seven operations. Every invariant holds over
  all 11,175,654 distinct states, about 1 minute. `AllAnswered` is not checked
  here.
- **Both at once is out of reach.** Two clients with every fault passed 152
  million distinct states in about 40 minutes with no violation and its queue
  still growing, and was stopped. That is evidence, not a proof.
- **The setup script is lost with the control plane's memory**, as in the code.
  A make not yet delivered when the process dies is undone.
- **The runtime changes the VM only in steps**, each change atomic. A step cut
  short may make its change or not, and reports `cancelled` only once it ended,
  which is what Tart's and smolvm's masked stops give. A VM changes by itself
  never, and a host's restart leaves it where it is.
- **The sequence fence is global.** The model's operation ID is its sequence,
  and the host's `high` stands for the scope's sequence, which is one scope
  here. A fence per scope is the same for one machine.
- **Only a definite failure moves a row.** The move to another host on
  `Capacity` is out; the model's create has one host.

## Coverage and sync

Last confirmed against the commit that adds this table. Each model part stands
for this code:

| Model                            | Code                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| `Next_`, `Decide`                | `apps/server/src/reconcile.ts` `next`; `machines.ts` `advance`           |
| `Create`                         | `apps/server/src/machines.ts` `born`, `store.insertMachine`              |
| `Request`                        | `machines.ts` `asked`, `remove`; `store.desire`                          |
| `Read`                           | `machines.ts` `stateOf`                                                  |
| `Send`, `Cut`                    | `apps/server/src/operations.ts` `poll`                                   |
| `Collect`, `Failing`, `Done`     | `machines.ts` `follow`, `ended`; `reconcile.ts` `settled`; `store.finish` |
| `Lost`                           | `operations.ts` `poll`; `reconcile.ts` `lost`                            |
| `Stall`, `Unstall`               | `machines.ts` `follow`'s `unreachable` and `running` cases               |
| `Deliver`, `Repeat`, `Lose`      | `apps/host/src/operations.ts` `run`, and the network                     |
| `HostStep`, `HostFail`           | `apps/host/src/operations.ts` `perform`                                  |
| `HostCancel`                     | `apps/host/src/operations.ts` `cancel`, `ended`                          |
| `HostRestart`                    | a new process: `Operations.boot`, empty `entries` and `scopes`           |
| `Crash`, `Revive`                | a new process: the store stays, `plans` goes; `machines.ts` start-up     |
| `Answer`                         | `packages/sdk/src/client.ts` `machineRest`, `machineGone`, `answerOf`    |

When a covered function changes, update the matching action so the model still
describes the code, then rerun. Move the sync commit forward only after you have
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

Each check was run against a broken copy of the model, TLC run, then reverted.

| Break                                                        | Violated           |
| ------------------------------------------------------------ | ------------------ |
| The host accepts any delivery: no sequence or boot fence     | `OnceOnly`         |
| A failed make skips undoing and rests undone                 | `NoOrphan`         |
| A client answers without waiting for rest                    | `AnswerTrue`       |
| `store.desire` leaves the row at rest                        | `RestTrue`         |
| `Superseded` names what the client asked                     | `SupersededHonest` |
| Failing a step records no error                              | `FailedSays`       |
| A start's report rests the row settled without a new read    | `RestTrue`         |
| A make the host never got is never given up                  | deadlock           |
| A host restart isn't noticed                                 | `AllAnswered`      |

Removing the client's generation check broke nothing, because `store.desire`
leaves rest in the write that records the request. That is why the check, and
`Machine.generation`, are gone.

Repeat this kind of break whenever you add an invariant. A check you haven't
seen fail proves nothing.
