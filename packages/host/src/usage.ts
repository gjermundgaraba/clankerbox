import { Capacity, formatMib, type Reading } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Effect } from "effect";
import type { Activation, Held, MachineRef, MachineState } from "./runtime.ts";

type Observe = (machines: ReadonlyArray<MachineRef>) => Effect.Effect<ReadonlyArray<MachineState>>;

interface InUse {
  /** Running or being booted, each once. */
  readonly running: ReadonlyArray<MachineRef>;
  /** Whose state couldn't be read: each may run. */
  readonly unread: ReadonlyArray<MachineRef>;
}

export const inUse = (machines: ReadonlyArray<Held>, observe: Observe): Effect.Effect<InUse> =>
  Effect.gen(function* () {
    const booting = machines.filter((held) => held.booting);
    const others = machines.filter((held) => !held.booting);

    const read = Arr.zip(others, yield* observe(others.map(({ machine }) => machine)));

    const inState = (state: MachineState) =>
      read.filter(([, observed]) => observed === state).map(([{ machine }]) => machine);

    return {
      running: [...booting.map(({ machine }) => machine), ...inState("running")],
      unread: inState("unknown"),
    };
  });

export const allotted = (
  running: ReadonlyArray<Pick<MachineRef, "cpu" | "ramMib">>,
  unread: ReadonlyArray<Pick<MachineRef, "id">>,
  ramBudgetMib?: number,
): ReadonlyArray<Reading> => {
  const rows = (["cpu", "ramMib"] as const).map((resource): Reading =>
    unread.length > 0
      ? { resource, unread: unread.map(({ id }) => id) }
      : { resource, used: running.reduce((sum, machine) => sum + machine[resource], 0) },
  );

  return ramBudgetMib === undefined
    ? rows
    : rows.map((row) => (row.resource === "ramMib" ? { ...row, limit: ramBudgetMib } : row));
};

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
