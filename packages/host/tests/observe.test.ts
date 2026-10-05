/**
 * A runtime's `observe` answers one state per machine, in order. Its consumers hold it to that
 * through one helper, which fails `Internal` on any other answer.
 */
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { checkRamBudget } from "../src/ram-budget.ts";
import { type MachineRef, type Observed, observeAll, observeOne } from "../src/runtime.ts";

const machine = (name: string): MachineRef => ({
  id: `linux_${name}`,
  name,
  instance: "0123456789abcdef0123456789abcdef",
  native: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: undefined,
});

/** An `observe` that always answers `states`, whatever it is asked. */
const answering =
  (states: ReadonlyArray<Observed>) =>
  (_machines: ReadonlyArray<MachineRef>): Effect.Effect<ReadonlyArray<Observed>> =>
    Effect.succeed(states);

const [a, b] = [machine("a"), machine("b")];

test("observeAll passes one state per machine through", async () => {
  const states: ReadonlyArray<Observed> = [{ state: "running" }, { state: "stopped" }];

  expect(await Effect.runPromise(observeAll(answering(states), [a, b]))).toEqual(states);
});

test("too few or too many states fail Internal, naming the machines", async () => {
  const errors = await Promise.all(
    [
      observeAll(answering([{ state: "running" }]), [a, b]),
      observeAll(answering([{ state: "running" }, { state: "running" }]), [a]),
    ].map((observing) => Effect.runPromise(Effect.flip(observing))),
  );

  expect(errors.map(({ _tag, message }) => [_tag, message])).toEqual([
    ["Internal", "observe read 1 states for 2 machines: linux_a, linux_b"],
    ["Internal", "observe read 2 states for 1 machines: linux_a"],
  ]);
});

test("a single read of no state fails Internal instead of reading the machine as missing", async () => {
  const error = await Effect.runPromise(Effect.flip(observeOne(answering([]), a)));

  expect([error._tag, error.message]).toEqual([
    "Internal",
    "observe read 0 states for 1 machines: linux_a",
  ]);
});

test("the RAM budget fails Internal instead of skipping machines it read no state for", async () => {
  const activation = {
    action: "start" as const,
    machine: a,
    machines: [
      { machine: a, booting: true },
      { machine: b, booting: false },
    ],
  };

  const error = await Effect.runPromise(
    Effect.flip(checkRamBudget(4096, activation, answering([]))),
  );

  expect([error._tag, error.message]).toEqual([
    "Internal",
    "observe read 0 states for 1 machines: linux_b",
  ]);
});
