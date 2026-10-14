import { Capacity, formatMib, type Reading } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Effect } from "effect";
import type { Activation, Held, MachineRef, Observed } from "./runtime.ts";

type Observe = (machines: ReadonlyArray<MachineRef>) => Effect.Effect<ReadonlyArray<Observed>>;

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

    const inState = (state: Observed["state"]) =>
      read.filter(([, observed]) => observed.state === state).map(([{ machine }]) => machine);

    return {
      running: [...booting.map(({ machine }) => machine), ...inState("running")],
      unread: inState("unknown"),
    };
  });

/**
 * The `cpu` and `ramMib` given to the running machines, sized as the runtime runs them. With an
 * unread machine there is no sum, as it would be a guess: the row names the unread instead.
 */
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
