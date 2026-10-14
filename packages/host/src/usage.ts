import { Array as Arr, Effect } from "effect";
import type { Held, MachineRef, Observed, Usage } from "./runtime.ts";

export type Observe = (
  machines: ReadonlyArray<MachineRef>,
) => Effect.Effect<ReadonlyArray<Observed>>;

export interface InUse {
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

export type Sizes = Pick<MachineRef, "cpu" | "ramMib">;

/**
 * The `cpu` and `ramMib` given to the running machines, sized as the runtime runs them. With an
 * unread machine there is no sum, as it would be a guess: the row names the unread instead.
 */
export const allotted = (
  running: ReadonlyArray<Sizes>,
  unread: ReadonlyArray<Pick<MachineRef, "id">>,
  ramBudgetMib?: number,
): ReadonlyArray<Usage> => {
  const rows = (["cpu", "ramMib"] as const).map((resource): Usage =>
    unread.length > 0
      ? { resource, unread: unread.map(({ id }) => id) }
      : { resource, used: running.reduce((sum, machine) => sum + machine[resource], 0) },
  );

  return ramBudgetMib === undefined
    ? rows
    : rows.map((row) => (row.resource === "ramMib" ? { ...row, limit: ramBudgetMib } : row));
};
