/**
 * The RAM budget, a step-3 check that a runtime's `admit` calls: the smolvm host's machines
 * must fit its budget, so the host refuses with `Capacity` before it boots one too many.
 */
import { Capacity, type HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import {
  type Activation,
  bootingActions,
  type MachineRef,
  type Observed,
  observeConcurrency,
} from "./runtime.ts";

/**
 * Sums the `ramMib` of every machine that is running or held by an action that boots it, each
 * once, and refuses when the sum passes `budgetMib`. The target is already held, so it is in
 * the sum. Counting the held ones keeps a booting action that is past its check from being
 * missed; the host checks booting actions one at a time, so two never count each other.
 */
export const checkRamBudget = (
  budgetMib: number,
  activation: Activation,
  observe: (machine: MachineRef) => Effect.Effect<Observed, HostError>,
): Effect.Effect<void, HostError> =>
  Effect.gen(function* () {
    const counted = yield* Effect.forEach(
      activation.machines,
      ({ machine, holder }) =>
        holder !== undefined && bootingActions.has(holder)
          ? Effect.succeed(machine.ramMib)
          : Effect.map(observe(machine), ({ state }) => (state === "running" ? machine.ramMib : 0)),
      { concurrency: observeConcurrency },
    );

    const total = counted.reduce((sum, ramMib) => sum + ramMib, 0);

    if (total > budgetMib) {
      return yield* new Capacity({
        message: `${activation.action} ${activation.machine.id} would bring the host's machines to ${total} MiB of RAM, past its budget of ${budgetMib} MiB`,
      });
    }
  });
