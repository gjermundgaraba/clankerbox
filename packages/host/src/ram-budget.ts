/**
 * The RAM budget, a step-3 check that a runtime's `admit` calls: the smolvm host's machines
 * must fit its budget, so the host refuses with `Capacity` before it boots one too many.
 */
import { Capacity, type HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Effect } from "effect";
import type { Activation, Held, MachineRef, Observed } from "./runtime.ts";

type Observe = (machines: ReadonlyArray<MachineRef>) => Effect.Effect<ReadonlyArray<Observed>>;

/**
 * What the budget counts: `used`, the sum of the `ramMib` of every machine that is running or
 * that an action is booting, each once, and `unread`, the machines among them whose state
 * couldn't be read, which count as running. The others' states come from one `observe`.
 */
export const ramInUse = (
  machines: ReadonlyArray<Held>,
  observe: Observe,
): Effect.Effect<{ readonly used: number; readonly unread: ReadonlyArray<MachineRef> }> =>
  Effect.gen(function* () {
    const booting = machines.filter((held) => held.booting);
    const others = machines.filter((held) => !held.booting);

    const observed = yield* observe(others.map(({ machine }) => machine));
    const read = Arr.zip(others, observed);

    const running = read
      .filter(([, { state }]) => state === "running" || state === "unknown")
      .map(([held]) => held);

    return {
      used: [...booting, ...running].reduce((sum, { machine }) => sum + machine.ramMib, 0),
      unread: read.filter(([, { state }]) => state === "unknown").map(([{ machine }]) => machine),
    };
  });

/**
 * Refuses when `ramInUse`'s sum passes `budgetMib`. The target is booting, so it is in the sum.
 * Counting the booting ones keeps an action that is past its check from being missed; the host
 * checks booting actions one at a time, so two never count each other.
 */
export const checkRamBudget = (
  budgetMib: number,
  activation: Activation,
  observe: Observe,
): Effect.Effect<void, HostError> =>
  Effect.gen(function* () {
    const { used: total } = yield* ramInUse(activation.machines, observe);

    if (total > budgetMib) {
      return yield* new Capacity({
        message: `${activation.action} ${activation.machine.id} would bring the host's machines to ${total} MiB of RAM, past its budget of ${budgetMib} MiB`,
      });
    }
  });
