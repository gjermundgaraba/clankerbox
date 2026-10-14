import { Capacity, formatMib } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import type { Activation } from "./runtime.ts";
import { inUse, type Observe } from "./usage.ts";

/**
 * The target is booting, so it is in the sum, and a machine whose state couldn't be read counts
 * as running. Counting the booting ones keeps an action past its check from being missed; the
 * host checks them one at a time, so two never count each other.
 */
export const checkRamBudget = (
  budgetMib: number,
  activation: Activation,
  observe: Observe,
): Effect.Effect<void, Capacity> =>
  Effect.gen(function* () {
    const { running, unread } = yield* inUse(activation.machines, observe);
    const total = [...running, ...unread].reduce((sum, { ramMib }) => sum + ramMib, 0);

    if (total > budgetMib) {
      const { id, ramMib } = activation.machine;
      const free = Math.max(0, budgetMib - (total - ramMib));

      return yield* new Capacity({
        message: `${activation.action} ${id} needs ${formatMib(ramMib)} of RAM, and ${free === 0 ? "none" : formatMib(free)} of the host's ${formatMib(budgetMib)} budget is free`,
      });
    }
  });
