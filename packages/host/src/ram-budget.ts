/**
 * The RAM budget, a step-3 check that a runtime's `admit` calls: the smolvm host's machines
 * must fit its budget, so the host refuses with `Capacity` before it boots one too many.
 */
import { Capacity, type HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import type { Activation, Interface } from "./runtime.ts";

/**
 * Sums the `ramMib` of every machine that is running or that an action is booting, each once,
 * and refuses when the sum passes `budgetMib`. The target is booting, so it is in the sum.
 * Counting the booting ones keeps an action that is past its check from being missed; the host
 * checks booting actions one at a time, so two never count each other. The others' states come
 * from one `observe`.
 */
export const checkRamBudget = (
  budgetMib: number,
  activation: Activation,
  observe: Interface["observe"],
): Effect.Effect<void, HostError> =>
  Effect.gen(function* () {
    const booting = activation.machines.filter((held) => held.booting);
    const others = activation.machines.filter((held) => !held.booting);
    const observed = yield* observe(others.map(({ machine }) => machine));
    const running = others.filter((_, index) => observed[index]?.state === "running");

    const total = [...booting, ...running].reduce((sum, { machine }) => sum + machine.ramMib, 0);

    if (total > budgetMib) {
      return yield* new Capacity({
        message: `${activation.action} ${activation.machine.id} would bring the host's machines to ${total} MiB of RAM, past its budget of ${budgetMib} MiB`,
      });
    }
  });
