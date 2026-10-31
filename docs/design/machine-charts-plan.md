# Machine charts plan

A machine's lifecycle moves from a hand-written loop and independent row fields into one xstate 6 chart, and clients see the same API. The maintainer gets one reducer in place of seven, and a model that imports the chart.

The rule is that a chart is a pure function run inside the SQLite write, and no snapshot outlives that write. Hosts keep operations. No resident actor holds a machine, as a request must land in the write that records it (Appendix B). A prebuild, short-lived and in memory, stays an Effect sequence, as CH7 settled.

The units run in order from CH1 to CH7, and CH1 to CH3 stand alone if you stop there.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. Each unit is a commit on `machine-actors`, with no forge involved, and the operator lands the branch. A CLI has no screenshots, so a lane saves its transcript. In this one-agent run, the gate per unit is `vp check`, `vp test` and `check.sh --quick`. Full `check.sh` runs at CH2, CH4, CH5 and the end, and the lanes run as one `verify-clankerbox` pass at CH5 and the end.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

One agent ran this program, so a box still open is one that didn't run as written. No owner was spawned, no audit tick was armed and no swarm ran. The ten lanes ran as one pass at the end, in `/tmp/ch7-evidence/`, beside five live runs at CH5 and `kill-host` at CH2, and CH7's was the one perf probe. The operator waived the review gates for one report at the end. CH7 changed `apps/host` and the host contract on the operator's order, past the file boundary below.

One agent ran this program, so a box still open is one that didn't run as written. No owner was spawned, no audit tick was armed and no swarm ran. The ten lanes ran as one pass at the end, in `/tmp/ch7-evidence/`, beside five live runs at CH5 and `kill-host` at CH2, and CH7's was the one perf probe. The operator waived the review gates for one report at the end. CH7 changed `apps/host` and the host contract on the operator's order, past the file boundary below.

### Arm the program

- [x] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [x] Decisions D1, D2 and D3 in Appendix B are made. The operator gave the go, with churn and compatibility no concern.
- [ ] Read these at program start. pstack ships locally, so `git show origin/main:<path>` applies only to this repo's files.
  - [ ] `git show origin/main:.github/workflows/ci.yml`
  - [ ] The local `skills/poteto-mode/playbooks/autopilot-stack.md` and `skills/swarm/SKILL.md`
  - [x] The repo's `verify-clankerbox` and `verify-machine-answers` skills, and the `effect` skill before any Effect code
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported. Name every such change and nothing else. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per unit, fresh, with this plan and the prior unit's report.
- [x] Follow this dependency graph. It is a straight line, CH1 to CH7, each on the one before it.
- [ ] Hold the file boundaries. Only CH4 onward touches `apps/server/src/*chart*`. No unit touches `apps/host`, `packages/sdk` or `apps/cli/src`.
- [ ] Hold the review gate. CH2, CH3 and CH5 change what a client reads. They wait for the operator's review.

### PR mechanics, for every PR

- [x] Commit on `machine-actors` with plain `git commit`. Leave `reports/`, `research_notes/` and `.claude/` out. Push only when asked.
- [ ] Run `/deslop` before each commit and `/no-comments` before review, where the session offers them.
- [x] Prove formatting from a clean clone, as bare `vp check` stops on `reports/`.

### Verdict and merge, for every PR

- [ ] A full swarm runs once at each unit's head, with one gates lane, the ten live lanes, the perf lane, and two audit lanes that read the diff and distrust the unit's report.
- [ ] A finding blocks if it breaks a You see box, an invariant in `SKILL.md` or the bar in Close the program. A failure on trunk behaviour in the regression lane is recorded against trunk.
- [x] The operator lands the branch. Nothing merges to `main` without them.

### Boot recipe, for every live lane

- [ ] `git checkout <head SHA>` in a worktree, then `vp install`.
- [x] Run `RUN=$(.agents/skills/verify-clankerbox/scripts/launch.sh)` with the lane's arguments. Wait for it to print the run directory.
- [x] Drive only `cb.sh` and `fault.sh`. Read `evidence/` and never the database.
- [ ] Save each transcript to `/tmp/swarm-<unit>/worker-<n>/` and run `cleanup.sh`.

## Run a setup only on a make from a base (CH1)

**Depends on.** None.

**Files.**

- [x] Edit `apps/server/src/store.ts`.
- [x] Edit `apps/server/src/machines.ts`.
- [x] Edit `apps/server/src/platform/sqlite.ts`.
- [x] Edit `apps/server/tests/crash.test.ts`.
- [x] Edit `apps/cli/tests/stack.test.ts`.

**Build.**

- [x] Move `scripted` into `Source` as `{ kind: "base"; scripted: boolean }`, so a scripted copy can't be written.
- [x] Send `setup` in `stepOf` only when `source.kind === "base"`. This fixes the regression `bcf4bcc` brought, where a prebuilt create runs its setup again.
- [x] Drop the `scripted` column by adding a migration. Editing the first one leaves a live database unmigrated, as `sqlite.ts` returns early when the version matches.

**You see.**

- [x] `create fast --profile web` after a prebuild leaves `recipe-ran` absent. It reappears today (measured, see Appendix A).

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Add "a make from a prebuild sends no setup" to `apps/cli/tests/stack.test.ts`, failing first. Run `vp test apps/cli/tests/stack.test.ts`.
- [x] Run `vp test apps/server` and `.agents/skills/verify-machine-answers/scripts/check.sh --quick`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run create, pause, stop, start and delete on `control-plane` at `1072a08` and at head, through the `features/README.md` row. Save `CH1-lifecycle.txt`. Pass when each read of `state`, `desired` and `phase` matches between the two, or differs only as this unit's You see names.
- [ ] Lane 2. Setup and failure. Drive the setup, host key and failing setup rows, then replace the failed row. Save `CH1-setup.txt`. Pass when `bad` reads `phase` `failed`, `state` `missing` with its error, and a create of the name replaces it.
- [ ] Lane 3. Prebuilds. Drive `prebuild --profile web`, delete `$RUN/recipe-ran`, then `create fast --profile web`. Save `CH1-prebuild.txt`. Pass when `runtime-calls.txt` has `restore fast` and `recipe-ran` stays absent.
- [ ] Lane 4. Copies. Drive the checkpoint, fork and restore row. Save `CH1-copies.txt`. Pass when `checkpoint get snap --json` has `machine` and `kind`, and `copy` and `twin` settle.
- [ ] Lane 5. Resize. Drive the resize and capacity row. Save `CH1-resize.txt`. Pass when each refusal has its tag and `capacity` counts no stopped machine.
- [ ] Lane 6. Moves. Run `launch.sh linux 2048 2` and create 2G twice, then a third. Save `CH1-moves.txt`. Pass when two settle one per host and the third rests failed with `Capacity`.
- [ ] Lane 7. A dead host. Run `fault.sh "$RUN" kill-host linux-2` on a two-host run. Save `CH1-host-down.txt`. Pass when a machine there reads `state` `unknown` and `phase` `waiting`, and a create lands on `linux-1`.
- [ ] Lane 8. A dead control plane. Create `slow` with `--no-wait`, wait for `$RUN/setup-began`, `fault.sh` `kill-server`, `setup-go`, `start-server`. Save `CH1-crash.txt`. Pass when the machine ends `settled` with one `create` in `runtime-calls.txt`.
- [ ] Lane 9. A mac run. Run `launch.sh mac` and drive create, stop, capture, restore and delete. Save `CH1-mac.txt`. Pass when a capture of a running machine is refused and the rest settle.
- [ ] Lane 10. A superseded request. Start `stop dev` with `--no-wait` while `slow` holds a step, then `start dev`. Save `CH1-superseded.txt`. Pass when the first wait answers `Superseded` and `get --json` agrees.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `create fast --profile web` on the fake runtime.
- [ ] Probe. Twenty runs each of trunk and head, interleaved, through `cb.sh`.
- [ ] Baseline. Record the time at `1072a08` first.
- [ ] Rule. Head is not slower. Its setup no longer runs, so a slower median by more than 10 percent fails.

**Review gate.** None. CH1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [x] The commit sits on `machine-actors`, and the operator lands the branch.

## Read waiting and stop storing it (CH2)

**Depends on.** CH1.

**Files.**

- [x] Edit `apps/server/src/machines.ts`.
- [x] Edit `apps/server/src/reconcile.ts`.
- [x] Edit `apps/server/src/store.ts`.
- [x] Edit `.agents/skills/verify-machine-answers/model/MachineAnswers.tla`.
- [x] Edit `.agents/skills/verify-machine-answers/SKILL.md`.

**Build.**

- [x] Add `phaseShown(row, seen)` in `machines.ts`. A failed read shows `waiting` unless the phase is `failed`.
- [x] Remove every write of `phase: "waiting"`, with the `waiting` answer of `next`.
- [x] Make `rest` at `machines.ts:1229` answer on a failed read as it does on a stored `waiting`, or a prebuild on a dead host polls forever.
- [x] Delete `Stall` and `Unstall` from the model.

**You see.**

- [x] A `settled` machine on a dead host reads `waiting` as soon as its read fails, not at the next recheck. Decision D2 owns that.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Rewrite the row read at `machines.test.ts:329` over `getMachine`, and add "a prebuild on a dead host ends". Run `vp test apps/server`.
- [x] Run `check.sh` in full. It passes with `AllAnswered`. This is the first run with only `Stall` and `Unstall` gone, as the probe also dropped `generation`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run create, pause, stop, start and delete on `control-plane` at `1072a08` and at head, through the `features/README.md` row. Save `CH2-lifecycle.txt`. Pass when each read of `state`, `desired` and `phase` matches between the two, or differs only as this unit's You see names.
- [ ] Lane 2. Setup and failure. Drive the setup, host key and failing setup rows, then replace the failed row. Save `CH2-setup.txt`. Pass when `bad` reads `phase` `failed`, `state` `missing` with its error, and a create of the name replaces it.
- [ ] Lane 3. Prebuilds. Drive `prebuild --profile web`, delete `$RUN/recipe-ran`, then `create fast --profile web`. Save `CH2-prebuild.txt`. Pass when `runtime-calls.txt` has `restore fast` and `recipe-ran` stays absent.
- [ ] Lane 4. Copies. Drive the checkpoint, fork and restore row. Save `CH2-copies.txt`. Pass when `checkpoint get snap --json` has `machine` and `kind`, and `copy` and `twin` settle.
- [ ] Lane 5. Resize. Drive the resize and capacity row. Save `CH2-resize.txt`. Pass when each refusal has its tag and `capacity` counts no stopped machine.
- [ ] Lane 6. Moves. Run `launch.sh linux 2048 2` and create 2G twice, then a third. Save `CH2-moves.txt`. Pass when two settle one per host and the third rests failed with `Capacity`.
- [x] Lane 7. A dead host. Run `fault.sh "$RUN" kill-host linux-2` on a two-host run. Save `CH2-host-down.txt`. Pass when a machine there reads `state` `unknown` and `phase` `waiting`, and a create lands on `linux-1`.
- [ ] Lane 8. A dead control plane. Create `slow` with `--no-wait`, wait for `$RUN/setup-began`, `fault.sh` `kill-server`, `setup-go`, `start-server`. Save `CH2-crash.txt`. Pass when the machine ends `settled` with one `create` in `runtime-calls.txt`.
- [ ] Lane 9. A mac run. Run `launch.sh mac` and drive create, stop, capture, restore and delete. Save `CH2-mac.txt`. Pass when a capture of a running machine is refused and the rest settle.
- [ ] Lane 10. A superseded request. Start `stop dev` with `--no-wait` while `slow` holds a step, then `start dev`. Save `CH2-superseded.txt`. Pass when the first wait answers `Superseded` and `get --json` agrees.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `machines --json` with 50 machines.
- [ ] Probe. Twenty runs each of trunk and head, interleaved.
- [ ] Baseline. Record the time at `1072a08` first.
- [ ] Rule. No read is added, so a median more than 10 percent slower fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1 transcript, which stands in for a screenshot, into the unit's report.
- [ ] A CLI has no video, so the transcript of lanes 7 and 10 stands in for it.
- [ ] Post both in chat. Stop until the operator answers.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [x] The commit sits on `machine-actors`, and the operator lands the branch.

## Decide a late report by what is wanted now (CH3)

**Depends on.** CH2.

**Files.**

- [x] Edit `apps/server/src/reconcile.ts`.
- [x] Edit `apps/server/src/machines.ts`.
- [x] Edit `apps/server/src/store.ts`.
- [x] Edit `apps/server/src/platform/sqlite.ts`.
- [x] Edit `.agents/skills/verify-machine-answers/model/MachineAnswers.tla`.

**Build.**

- [x] Add `wants(kind, desired)` in `reconcile.ts`. It replaces `cuts` and `askedSince`.
- [x] Move a resize's target to `Operation.to` at `begin`, so a later resize needs no generation.
- [x] Keep a failing step from swallowing a request that left `desired` alone. A step other than a resize that fails with a resize owed rests `observing`, so the resize runs and its waiter isn't answered with the step's failure.
- [x] Add a test for the case in Appendix C of a request that goes A, B, A during a step.
- [x] `generation` stays until CH5, which removes it with the writes that need it.

**You see.**

- [x] A repeated `stop` during a failing `stop` answers the failure instead of trying once more. Decision D3 owns that.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Add "a resize asked during a failing stop still runs" to `machines.test.ts`, failing first. Run `vp test apps/server`.
- [x] Run `check.sh` in full, and each break in `SKILL.md`, which fails its invariant.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run create, pause, stop, start and delete on `control-plane` at `1072a08` and at head, through the `features/README.md` row. Save `CH3-lifecycle.txt`. Pass when each read of `state`, `desired` and `phase` matches between the two, or differs only as this unit's You see names.
- [ ] Lane 2. Setup and failure. Drive the setup, host key and failing setup rows, then replace the failed row. Save `CH3-setup.txt`. Pass when `bad` reads `phase` `failed`, `state` `missing` with its error, and a create of the name replaces it.
- [ ] Lane 3. Prebuilds. Drive `prebuild --profile web`, delete `$RUN/recipe-ran`, then `create fast --profile web`. Save `CH3-prebuild.txt`. Pass when `runtime-calls.txt` has `restore fast` and `recipe-ran` stays absent.
- [ ] Lane 4. Copies. Drive the checkpoint, fork and restore row. Save `CH3-copies.txt`. Pass when `checkpoint get snap --json` has `machine` and `kind`, and `copy` and `twin` settle.
- [ ] Lane 5. Resize. Drive the resize and capacity row. Save `CH3-resize.txt`. Pass when each refusal has its tag and `capacity` counts no stopped machine.
- [ ] Lane 6. Moves. Run `launch.sh linux 2048 2` and create 2G twice, then a third. Save `CH3-moves.txt`. Pass when two settle one per host and the third rests failed with `Capacity`.
- [ ] Lane 7. A dead host. Run `fault.sh "$RUN" kill-host linux-2` on a two-host run. Save `CH3-host-down.txt`. Pass when a machine there reads `state` `unknown` and `phase` `waiting`, and a create lands on `linux-1`.
- [ ] Lane 8. A dead control plane. Create `slow` with `--no-wait`, wait for `$RUN/setup-began`, `fault.sh` `kill-server`, `setup-go`, `start-server`. Save `CH3-crash.txt`. Pass when the machine ends `settled` with one `create` in `runtime-calls.txt`.
- [ ] Lane 9. A mac run. Run `launch.sh mac` and drive create, stop, capture, restore and delete. Save `CH3-mac.txt`. Pass when a capture of a running machine is refused and the rest settle.
- [ ] Lane 10. A superseded request. Start `stop dev` with `--no-wait` while `slow` holds a step, then `start dev`. Save `CH3-superseded.txt`. Pass when the first wait answers `Superseded` and `get --json` agrees.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. A full create, stop, start and delete on the fake runtime.
- [ ] Probe. Twenty cycles each of trunk and head, interleaved.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. The change is a pure function, so a median more than 10 percent slower fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1 transcript, which stands in for a screenshot, into the unit's report.
- [ ] A CLI has no video, so the transcript of lanes 7 and 10 stands in for it.
- [ ] Post both in chat. Stop until the operator answers.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [x] The commit sits on `machine-actors`, and the operator lands the branch.

## Write the chart and make the model import it (CH4)

**Depends on.** CH3.

**Files.**

- [x] Edit `pnpm-workspace.yaml`, pinning `xstate` at `6.0.0-alpha.71` and `@xstate/effect` at `1.0.0-alpha.10`, with `minimumReleaseAgeExclude`. `@xstate/effect` was dropped with CH7's actor.
- [x] Edit `apps/server/package.json`.
- [x] Create `apps/server/src/chart.ts`.
- [x] Create `apps/server/src/machine-chart.ts`.
- [x] Create `apps/server/tests/machine-chart.test.ts`.
- [x] Create `.agents/skills/verify-machine-answers/scripts/export-chart.ts`.
- [x] Create `.agents/skills/verify-machine-answers/model/Chart.tla`.
- [x] Edit `.agents/skills/verify-machine-answers/model/MachineAnswers.tla`.
- [x] Edit `oxlint.config.ts`.

**Build.**

- [x] Write the 21 leaf chart from the table in `research_notes/Machine charts/candidate-1.md` section 5, with `meta` of `{ phase, step, activity }` on each leaf. `chart.sketch.mjs` is a start and no more, as it has no `resize` edge, no `sized`, no `event.move` and no `undoneAt`, and its `resizing` never clears `resize`.
- [x] Record a make's `port` on every report edge, `deleting.draining` included, or `others` drops it and two VMs on a host can take one port.
- [x] Add `applied`, which turns a row and event into a `Decision` through `resolveState` and `transition`. No snapshot outlives the call.
- [x] Export the chart's row writes to `Chart.tla`, and write `row' = Row(row, event, op)` in the model.
- [x] Fence `chart.ts` and `*-chart.ts` to `xstate` and each other, with no `Date`, `Math.random`, `crypto` or `Effect`.
- [x] Nothing live calls the chart yet.

**You see.**

- [x] TLC passes over the table generated from the chart, as it did in the probe at 12,250,270 distinct states (measured). The server's behaviour doesn't change.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Add to `machine-chart.test.ts` the 320 input table against `next`, every event from every leaf against `settled`, `lost` and the store's SQL, every leaf reached through `getAdjacencyMap`, no `ask` or `delete` from a rest ending in a rest, a stale `Chart.tla`, a throw reaching the caller, and a flat heap over 100,000 writes. Run `vp test apps/server/tests/machine-chart.test.ts`.
- [x] Run `check.sh` in full. Each break mutates the chart, re-exports, and fails its invariant.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run create, pause, stop, start and delete on `control-plane` at `1072a08` and at head, through the `features/README.md` row. Save `CH4-lifecycle.txt`. Pass when each read of `state`, `desired` and `phase` matches between the two, or differs only as this unit's You see names.
- [ ] Lane 2. Setup and failure. Drive the setup, host key and failing setup rows, then replace the failed row. Save `CH4-setup.txt`. Pass when `bad` reads `phase` `failed`, `state` `missing` with its error, and a create of the name replaces it.
- [ ] Lane 3. Prebuilds. Drive `prebuild --profile web`, delete `$RUN/recipe-ran`, then `create fast --profile web`. Save `CH4-prebuild.txt`. Pass when `runtime-calls.txt` has `restore fast` and `recipe-ran` stays absent.
- [ ] Lane 4. Copies. Drive the checkpoint, fork and restore row. Save `CH4-copies.txt`. Pass when `checkpoint get snap --json` has `machine` and `kind`, and `copy` and `twin` settle.
- [ ] Lane 5. Resize. Drive the resize and capacity row. Save `CH4-resize.txt`. Pass when each refusal has its tag and `capacity` counts no stopped machine.
- [ ] Lane 6. Moves. Run `launch.sh linux 2048 2` and create 2G twice, then a third. Save `CH4-moves.txt`. Pass when two settle one per host and the third rests failed with `Capacity`.
- [ ] Lane 7. A dead host. Run `fault.sh "$RUN" kill-host linux-2` on a two-host run. Save `CH4-host-down.txt`. Pass when a machine there reads `state` `unknown` and `phase` `waiting`, and a create lands on `linux-1`.
- [ ] Lane 8. A dead control plane. Create `slow` with `--no-wait`, wait for `$RUN/setup-began`, `fault.sh` `kill-server`, `setup-go`, `start-server`. Save `CH4-crash.txt`. Pass when the machine ends `settled` with one `create` in `runtime-calls.txt`.
- [ ] Lane 9. A mac run. Run `launch.sh mac` and drive create, stop, capture, restore and delete. Save `CH4-mac.txt`. Pass when a capture of a running machine is refused and the rest settle.
- [ ] Lane 10. A superseded request. Start `stop dev` with `--no-wait` while `slow` holds a step, then `start dev`. Save `CH4-superseded.txt`. Pass when the first wait answers `Superseded` and `get --json` agrees.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median time of one `applied` call, and TLC's time on `MachineAnswers.cfg`.
- [ ] Probe. 300,000 calls in five rounds, then `check.sh`.
- [ ] Baseline. Record `check.sh` at trunk first. Trunk has no chart, so `applied` takes an absolute budget.
- [ ] Rule. `applied` above 200 microseconds, or any round's heap growing more than 1 KB per call, fails. TLC above 15 minutes fails.

**Review gate.** None. CH4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [x] The commit sits on `machine-actors`, and the operator lands the branch.

## Put every machine write through the chart (CH5)

**Depends on.** CH4.

**Files.**

- [x] Edit `apps/server/src/platform/sqlite.ts`.
- [x] Edit `apps/server/src/store.ts`.
- [x] Edit `apps/server/src/machines.ts`.
- [x] Delete `apps/server/src/reconcile.ts`.
- [x] Edit `apps/server/tests/support.ts`.
- [x] Edit `apps/server/tests/crash.test.ts`.

**Build.**

- [x] Replace `stage` and `phase` with one `state` column holding the leaf path, in a new migration, and add `store.advance(resource, name, decide)`. The store stays ignorant of leaf names.
- [x] Narrow `desired` to three values. `deleted` is the `deleting` region, and the wire `desired` derives.
- [x] Run requests and the loop's writes through `store.advance` and `applied`. The loop's shape stays. `read` carries `boot` from a fresh `hosts.read`, as a `hosts.known` boot goes stale and `poll` then calls each new step lost.
- [x] Keep the homes in `candidate-1.md` section 6 for the tailnet checks, the Capacity move, the sizes read after a lost resize, `creates`, `tick`, `adopted` and expiry.
- [x] Delete `reconcile.ts`, `Stage`, `Finish`, `next`, `settled`, `lost`, `holds`, `stepPhases`, `phaseOfKind`, `released`, and `generation` from `MachineRow` and `Operation`.

**You see.**

- [x] A delete during a step reads `deleting` at once, not the step's phase. Every other read matches lane 1.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Run `vp test apps/server`. Add `phaseOf(row)` to `support.ts` for the 18 row readers, and rewrite the `generation` helper at `machines.test.ts:92`.
- [x] Open a v1 database from a copy of a fresh `control-plane` run. It migrates, or refuses with `CannotStart`. Lane 1 runs on fresh directories and can't see this.
- [x] Run `crash.test.ts` alone. All 15 cases keep their statements.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run create, pause, stop, start and delete on `control-plane` at `1072a08` and at head, through the `features/README.md` row. Save `CH5-lifecycle.txt`. Pass when each read of `state`, `desired` and `phase` matches between the two, or differs only as this unit's You see names.
- [ ] Lane 2. Setup and failure. Drive the setup, host key and failing setup rows, then replace the failed row. Save `CH5-setup.txt`. Pass when `bad` reads `phase` `failed`, `state` `missing` with its error, and a create of the name replaces it.
- [ ] Lane 3. Prebuilds. Drive `prebuild --profile web`, delete `$RUN/recipe-ran`, then `create fast --profile web`. Save `CH5-prebuild.txt`. Pass when `runtime-calls.txt` has `restore fast` and `recipe-ran` stays absent.
- [ ] Lane 4. Copies. Drive the checkpoint, fork and restore row. Save `CH5-copies.txt`. Pass when `checkpoint get snap --json` has `machine` and `kind`, and `copy` and `twin` settle.
- [ ] Lane 5. Resize. Drive the resize and capacity row. Save `CH5-resize.txt`. Pass when each refusal has its tag and `capacity` counts no stopped machine.
- [ ] Lane 6. Moves. Run `launch.sh linux 2048 2` and create 2G twice, then a third. Save `CH5-moves.txt`. Pass when two settle one per host and the third rests failed with `Capacity`.
- [ ] Lane 7. A dead host. Run `fault.sh "$RUN" kill-host linux-2` on a two-host run. Save `CH5-host-down.txt`. Pass when a machine there reads `state` `unknown` and `phase` `waiting`, and a create lands on `linux-1`.
- [ ] Lane 8. A dead control plane. Create `slow` with `--no-wait`, wait for `$RUN/setup-began`, `fault.sh` `kill-server`, `setup-go`, `start-server`. Save `CH5-crash.txt`. Pass when the machine ends `settled` with one `create` in `runtime-calls.txt`.
- [ ] Lane 9. A mac run. Run `launch.sh mac` and drive create, stop, capture, restore and delete. Save `CH5-mac.txt`. Pass when a capture of a running machine is refused and the rest settle.
- [ ] Lane 10. A superseded request. Start `stop dev` with `--no-wait` while `slow` holds a step, then `start dev`. Save `CH5-superseded.txt`. Pass when the first wait answers `Superseded` and `get --json` agrees.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. A full create, stop, start and delete on the fake runtime.
- [ ] Probe. Twenty cycles each of trunk and head, interleaved.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. A median more than 20 percent slower fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1 transcript, which stands in for a screenshot, into the unit's report.
- [ ] A CLI has no video, so the transcript of lanes 7 and 10 stands in for it.
- [ ] Post both in chat. Stop until the operator answers.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [x] The commit sits on `machine-actors`, and the operator lands the branch.

## Give checkpoints the same chart and one driver (CH6)

**Depends on.** CH5.

**Files.**

- [x] Create `apps/server/src/checkpoint-chart.ts`.
- [x] Create `apps/server/src/driver.ts`.
- [x] Edit `apps/server/src/checkpoints.ts`.
- [x] Edit `apps/server/src/machines.ts`.
- [x] Edit `apps/server/src/store.ts`.
- [x] Edit `apps/server/src/platform/sqlite.ts`.

**Build.**

- [x] Port the checkpoint tree in `research_notes/Machine charts/candidate-1.md` section 5.
- [x] Replace `looped`, `drive`, `driven` and the checkpoint's `work`, `driving` and `asked` with one `driver.ts`, where `activityOf(state)` picks the turn.
- [x] Delete `CheckpointPhase`, `CheckpointPatch` and `patchCheckpoint`.

**You see.**

- [x] A capture that loses its host, and one deleted mid-capture, end as they do today. `from` and the re-read are gone.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Run `vp test apps/server/tests/checkpoints.test.ts`. All 52 keep their statements.
- [x] Add the lost wake case from `1b8f35a`, which has no deterministic test, to `driver.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run create, pause, stop, start and delete on `control-plane` at `1072a08` and at head, through the `features/README.md` row. Save `CH6-lifecycle.txt`. Pass when each read of `state`, `desired` and `phase` matches between the two, or differs only as this unit's You see names.
- [ ] Lane 2. Setup and failure. Drive the setup, host key and failing setup rows, then replace the failed row. Save `CH6-setup.txt`. Pass when `bad` reads `phase` `failed`, `state` `missing` with its error, and a create of the name replaces it.
- [ ] Lane 3. Prebuilds. Drive `prebuild --profile web`, delete `$RUN/recipe-ran`, then `create fast --profile web`. Save `CH6-prebuild.txt`. Pass when `runtime-calls.txt` has `restore fast` and `recipe-ran` stays absent.
- [ ] Lane 4. Copies. Drive the checkpoint, fork and restore row. Save `CH6-copies.txt`. Pass when `checkpoint get snap --json` has `machine` and `kind`, and `copy` and `twin` settle.
- [ ] Lane 5. Resize. Drive the resize and capacity row. Save `CH6-resize.txt`. Pass when each refusal has its tag and `capacity` counts no stopped machine.
- [ ] Lane 6. Moves. Run `launch.sh linux 2048 2` and create 2G twice, then a third. Save `CH6-moves.txt`. Pass when two settle one per host and the third rests failed with `Capacity`.
- [ ] Lane 7. A dead host. Run `fault.sh "$RUN" kill-host linux-2` on a two-host run. Save `CH6-host-down.txt`. Pass when a machine there reads `state` `unknown` and `phase` `waiting`, and a create lands on `linux-1`.
- [ ] Lane 8. A dead control plane. Create `slow` with `--no-wait`, wait for `$RUN/setup-began`, `fault.sh` `kill-server`, `setup-go`, `start-server`. Save `CH6-crash.txt`. Pass when the machine ends `settled` with one `create` in `runtime-calls.txt`.
- [ ] Lane 9. A mac run. Run `launch.sh mac` and drive create, stop, capture, restore and delete. Save `CH6-mac.txt`. Pass when a capture of a running machine is refused and the rest settle.
- [ ] Lane 10. A superseded request. Start `stop dev` with `--no-wait` while `slow` holds a step, then `start dev`. Save `CH6-superseded.txt`. Pass when the first wait answers `Superseded` and `get --json` agrees.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. A capture and delete cycle on the fake runtime.
- [ ] Probe. Twenty cycles each of trunk and head, interleaved.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. A median more than 20 percent slower fails.

**Review gate.** None. CH6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [x] The commit sits on `machine-actors`, and the operator lands the branch.

## Close the gaps and bring the docs up (CH7)

**Dropped.** The operator kept a prebuild as an Effect sequence, `building` in `checkpoints.ts`, so the actor, `@xstate/effect` and the boxes that ask for them stay open. Nine gaps found in review took their place, `e448f40` to `1ceab6e`. One of them refuses a capture of a machine being deleted, which replaced the test of a capture queued behind that delete.

**Depends on.** CH6.

**Files.**

- [ ] Edit `apps/server/src/prebuilds.ts`.
- [x] Edit `apps/server/src/checkpoints.ts`.
- [ ] Edit `oxlint.config.ts`.
- [x] Edit `AGENTS.md`.
- [x] Edit `README.md`.
- [x] Edit `docs/design/control-plane.md`.
- [x] Edit `.agents/skills/verify-machine-answers/SKILL.md`.

**Build.**

- [ ] Port the build tree in `research_notes/Machine charts/candidate-1.md` section 5 on `setupEffect`, started as `Effect.forkIn(Effect.scoped(create then join), scope)`.
- [ ] Make each invoke total through `Effect.matchCause`, and have the spawner read `Effect.exit`, so a dead actor reads `failed` and its builder goes.
- [ ] Keep the setup in a `Map` in `Checkpoints`, never in input or context.
- [x] Rewrite the row, step and lease bullets in `AGENTS.md`, and `control-plane.md`'s statement that the plain loop replaced the chart.

**You see.**

- [x] `prebuild --profile web` and `getPrebuild` read as they do today, and a killed builder is deleted at restart.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add each build path to `checkpoints.test.ts`, and a transition throw reading `failed`. Run `vp test apps/server`.
- [x] From a clean clone, run `vp check`, `vp test`, `vp run ready` and `check.sh` in full.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Run create, pause, stop, start and delete on `control-plane` at `1072a08` and at head, through the `features/README.md` row. Save `CH7-lifecycle.txt`. Pass when each read of `state`, `desired` and `phase` matches between the two, or differs only as this unit's You see names.
- [x] Lane 2. Setup and failure. Drive the setup, host key and failing setup rows, then replace the failed row. Save `CH7-setup.txt`. Pass when `bad` reads `phase` `failed`, `state` `missing` with its error, and a create of the name replaces it.
- [x] Lane 3. Prebuilds. Drive `prebuild --profile web`, delete `$RUN/recipe-ran`, then `create fast --profile web`. Save `CH7-prebuild.txt`. Pass when `runtime-calls.txt` has `restore fast` and `recipe-ran` stays absent.
- [x] Lane 4. Copies. Drive the checkpoint, fork and restore row. Save `CH7-copies.txt`. Pass when `checkpoint get snap --json` has `machine` and `kind`, and `copy` and `twin` settle.
- [x] Lane 5. Resize. Drive the resize and capacity row. Save `CH7-resize.txt`. Pass when each refusal has its tag and `capacity` counts no stopped machine.
- [x] Lane 6. Moves. Run `launch.sh linux 2048 2` and create 2G twice, then a third. Save `CH7-moves.txt`. Pass when two settle one per host and the third rests failed with `Capacity`.
- [x] Lane 7. A dead host. Run `fault.sh "$RUN" kill-host linux-2` on a two-host run. Save `CH7-host-down.txt`. Pass when a machine there reads `state` `unknown` and `phase` `waiting`, and a create lands on `linux-1`.
- [x] Lane 8. A dead control plane. Create `slow` with `--no-wait`, wait for `$RUN/setup-began`, `fault.sh` `kill-server`, `setup-go`, `start-server`. Save `CH7-crash.txt`. Pass when the machine ends `settled` with one `create` in `runtime-calls.txt`.
- [x] Lane 9. A mac run. Run `launch.sh mac` and drive create, stop, capture, restore and delete. Save `CH7-mac.txt`. Pass when a capture of a running machine is refused and the rest settle.
- [x] Lane 10. A superseded request. Start `stop dev` with `--no-wait` while `slow` holds a step, then `start dev`. Save `CH7-superseded.txt`. Pass when the first wait answers `Superseded` and `get --json` agrees.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Wall time of `prebuild --profile web` on the fake runtime.
- [x] Probe. Ten runs each of trunk and head, interleaved.
- [x] Baseline. Record the trunk median first.
- [x] Rule. A median more than 20 percent slower fails.

**Review gate.** None. CH7 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [x] The commit sits on `machine-actors`, and the operator lands the branch.

## Close the program

- [ ] Every box above is checked with its evidence.
- [x] `vp check`, `vp test` and `vp run ready` pass from a clean clone, `check.sh` passes in full, and the fault run ends as Faults says.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

Each result is measured. The spike is `spike/xstate6` at `19782ba`, in `apps/server/tests/spike/`, and is not for landing. The chart probes and both designs are kept, uncommitted, in `research_notes/Machine charts/`.

| Question | Result |
| --- | --- |
| A resident actor per machine with an invoked step | 16.6 KB per recheck, with step time rising from 1.4 to 16.9 ms over 1000 loops. Pure `transition()` threading one snapshot leaks the same way, and plain `createActor` stays flat. The retainer is a `RuntimeSystem` chain from `createSnapshotSystem`. A resident `createEffectActor` with no `invoke` is flat, 22 MB and 0.055 ms per step over 100,000 events, and the same actor with an invoked step grew about 15 KB per cycle, from 5 to 67 ms. `createSnapshotSystem` chains only when children exist |
| A fleet machine with `enq.spawn` | 75 ms per actor and 406 MB at 1500 |
| Rebuilding from the row per write | Flat, 43 to 48 µs and 10 B per cycle over 300,000 writes. A second probe found the JSON route flat too, on a chart with children |
| Saved snapshots | A setup script lands in the JSON twice, and a restore reruns the invoke. A chart with no invoke has neither problem |
| A throw in a transition | Plain `transition()` throws to the caller, so a write rolls back. `createEffectActor` dies even with `onError` |
| The chart against `next` | 320 of 320 inputs agree, rerun by me |
| TLC over a table exported from the chart | `MachineAnswers.cfg` with `AllAnswered`, 12,250,270 distinct states, and `TwoClients.cfg`, 8,776,070, both with no error. `generation`, `Stall` and `Unstall` were gone |
| Breaks through the chart | `RestTrue`, `NoOrphan` and `FailedSays` each fail. `no-overtaken` passes on the full config, so a report's `wants` is a product rule and not safety |
| A prebuilt create | `create fast --profile web` runs its setup again. `recipe-ran` returned after I deleted it, with `restore fast` then two `exec fast` in the calls. `d914524` passed no script for a checkpoint source, so this is a regression from `bcf4bcc` |

The chart in the real store stays unproven until CH4 and CH5. No run covers smolvm or Tart. Whether the leak survives past alpha.71 is unknown.

A review by a second model (fable) found the CH3 scope, the migration trap, the swallowed resize, the sketch's gaps, the lost port and the `rest` hang, and each is now a box above. Its claim that the TLC totals had no log was wrong, as `tlc-full.out` and `tlc-two.out` hold them.

Two model drifts surfaced, and CH4 ends both by importing the chart. `updateDesire` on a deleted row writes `observing` where the model leaves the row. A cancelled make with no delete is undone in `settled`, and the model's `Collect` keeps it.

## Appendix B. Alternatives rejected, and the operator's decisions

The arena ran two runners, opus and fable, and both reached a pure chart in the write with no resident actors, independently of each other. The base is candidate 1. The cross-judge was skipped, as the pool holds no family other than the parent's.

| Alternative | Why it lost |
| --- | --- |
| A resident actor per machine | A request can't share the SQLite write, as `send` returns before the mailbox runs. Its memory would be a second copy of the row, and leases span rows, so the database stays their authority. With no `invoke` it does no I/O, so it would be the design here plus a mailbox hop and a persistence hop. With an `invoke` it leaks |
| One actor per wake | Flat, but it holds nothing, keeps the loop it was meant to replace, and adds overlap on a masked step |
| Whole snapshots in a JSON column, candidate 2 | Loses typed columns and `UNIQUE (host, port)` as plain columns, and its TLC replay is unproven. Candidate 1's model import is measured |
| The row as truth, with a chart rebuilt from `stage` and `phase` | A hand-kept mapping, and the fields stay |
| `xstate/durable` | It wants a journal we don't have |
| A chart on the host | `Entry.status` is a fiber's exit. A chart would be a second truth |
| Replaying TLC traces | It samples, and checks one direction. The exported table is exhaustive |

The shape follows xstate's own backend pattern, one actor per entity for the length of an event with state in the database (`docs/backend-workflows.md`, `examples/effect-workflows/src/persistence.ts`). Two choices are this plan's and not the docs'. It runs `transition()` with no actor, as the SQLite write is synchronous, and it keeps columns where the docs keep a persisted snapshot. It also has no `invoke`, where the docs invoke work a state owns.

From candidate 2, the plan takes reachability through `getAdjacencyMap` and the spawner reading `Effect.exit`.

**D1.** Decided. xstate owns the chart and an Effect fiber owns each resource's lifetime, as in rat-king's `advanceAlarm`. The operator can still ask for a resident actor, which costs the two reasons above.

**D2.** Decided. `waiting` shows on a `settled` row once a read fails. Otherwise the row needs a stored bit.

**D3.** Decided. A repeated request answers a failure, without one more try. No invariant needs the extra try.

## Appendix C. Risks

- CH3. `wants` compares the current wish with the step, so a request that goes A, B, A during a step looks unasked. The model passes with this (measured), and a review found no user-visible harm (inferred).
- CH4. The model leaves out resize, join, capacity moves and checkpoints, so those edges rest on the chart tests alone.
- CH4. An alpha library sits on the write path. The surface is `transition`, `resolveState`, `meta` and choice states, pinned exactly, and `Chart.tla` is a golden file for a bump.
- CH4. A threaded snapshot is the leak. `advance` takes a row, so it can't be threaded, and the heap test watches it.
- CH5. Leaf names enter the database, so renaming a leaf is a migration.
- CH5. `read` adds one host read per machine per recheck, as it carries `boot` and `pin`.
- CH7. A throw in a build transition kills its actor, so the spawner's `Effect.exit` is required. Moot, as no actor was built. Moot, as no actor was built.
- All. The 209 server tests that read no row should survive, which is inferred until CH5 runs.

## Appendix D. Links and reading list

- `docs/design/control-plane.md`, whose statement that the loop replaced the chart CH7 rewrites.
- `research_notes/Machine charts/candidate-1.md` and `candidate-2.md`.
- The spike branch `spike/xstate6`.
- CH3 and CH5 get `skills/interrogate/SKILL.md`. Every unit logs to `docs/design/control-plane-decisions.tsv` per `skills/show-me-your-work/SKILL.md`.
