import { Capacity, formatMib } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Effect } from "effect";
import type { Activation, Held, MachineRef, Observed } from "./runtime.ts";

type Observe = (machines: ReadonlyArray<MachineRef>) => Effect.Effect<ReadonlyArray<Observed>>;

/** Each machine counts once; one whose state couldn't be read counts as running. */
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
 * The target is booting, so it is in the sum. Counting the booting ones keeps an action past its
 * check from being missed; the host checks them one at a time, so two never count each other.
 */
export const checkRamBudget = (
  budgetMib: number,
  activation: Activation,
  observe: Observe,
): Effect.Effect<void, Capacity> =>
  Effect.gen(function* () {
    const { used: total } = yield* ramInUse(activation.machines, observe);

    if (total > budgetMib) {
      const { id, ramMib } = activation.machine;
      const free = Math.max(0, budgetMib - (total - ramMib));

      return yield* new Capacity({
        message: `${activation.action} ${id} needs ${formatMib(ramMib)} of RAM, and ${free === 0 ? "none" : formatMib(free)} of the host's ${formatMib(budgetMib)} budget is free`,
      });
    }
  });
