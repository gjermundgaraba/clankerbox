import { Capacity, formatMib } from "@gjermundgaraba/clankerbox-sdk";
import type { Reading } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

import { stateIn } from "./runtime.ts";
import type {
  Activation,
  Held,
  MachineRef,
  MachineState,
  Observed,
} from "./runtime.ts";

type Observe = (machines: readonly MachineRef[]) => Effect.Effect<Observed>;

interface InUse {
  readonly running: readonly MachineRef[];
  readonly unread: readonly MachineRef[];
}

export const inUse = (
  machines: readonly Held[],
  observe: Observe
): Effect.Effect<InUse> =>
  Effect.gen(function* () {
    const booting = machines.filter((held) => held.booting);

    const others = machines.flatMap((held) =>
      held.booting ? [] : [held.machine]
    );

    const read = yield* observe(others);

    const inState = (state: MachineState) =>
      others.filter((machine) => stateIn(read, machine) === state);

    return {
      running: [
        ...booting.map(({ machine }) => machine),
        ...inState("running"),
      ],
      unread: inState("unknown"),
    };
  });

export const allotted = (
  running: ReadonlyArray<Pick<MachineRef, "cpu" | "ramMib">>,
  unread: ReadonlyArray<Pick<MachineRef, "id">>,
  ramBudgetMib?: number
): readonly Reading[] => {
  const rows = (["cpu", "ramMib"] as const).map((resource): Reading =>
    unread.length > 0
      ? { resource, unread: unread.map(({ id }) => id) }
      : {
          resource,
          used: running.reduce((sum, machine) => sum + machine[resource], 0),
        }
  );

  return ramBudgetMib === undefined
    ? rows
    : rows.map((row) =>
        row.resource === "ramMib" ? { ...row, limit: ramBudgetMib } : row
      );
};

export const checkRamBudget = (
  budgetMib: number,
  activation: Activation,
  observe: Observe
): Effect.Effect<void, Capacity> =>
  Effect.gen(function* () {
    const { running, unread } = yield* inUse(activation.machines, observe);

    const total = [...running, ...unread].reduce(
      (sum, { ramMib }) => sum + ramMib,
      0
    );

    if (total > budgetMib) {
      const { id, ramMib } = activation.machine;
      const free = Math.max(0, budgetMib - (total - ramMib));

      return yield* new Capacity({
        message: `${activation.action} ${id} needs ${formatMib(ramMib)} of RAM, and ${free === 0 ? "none" : formatMib(free)} of the host's ${formatMib(budgetMib)} budget is free`,
      });
    }
  });
