import type { AnyStateMachine, EventObject, StateValue } from "xstate";

import type { Operation } from "./store.ts";

/** What a resource's write does: its next row, and the operation it begins or finishes. */
export interface Decision<R> {
  readonly next: R | "removed";
  readonly begin?: Omit<Operation, "sequence">;
  readonly finish: boolean;
}

/** `read` and `recheck` read, and `follow` polls the operation; `none` waits for a request. */
export type Activity = "read" | "follow" | "recheck" | "none";

/** `any` keeps whichever step was in flight when the leaf was entered. */
export type Step = Operation["kind"] | "any";

export interface LeafMeta<Phase> {
  readonly phase: Phase;
  readonly step?: Step;
  readonly activity: Activity;
}

/** A leaf's path from a chart's state value, as `{ made: "failed" }` is `made.failed`. */
export type PathOf<Value> = Value extends string
  ? Value
  : { [K in keyof Value & string]: `${K}.${PathOf<Value[K]>}` }[keyof Value &
      string];

interface Snapshot<L> {
  readonly status: string;
  readonly context: object;
  readonly matches: (leaf: L) => boolean;
}

/** A row: the chart's context, and the leaf it rests in. */
export type Stated<S extends Snapshot<L>, L extends string> = S["context"] & {
  readonly state: L;
};

/**
 * What `applied` needs of a machine. A chart's file writes `resolve` and `transition` over its own
 * machine, as they are typed only there.
 */
export interface Chart<S extends Snapshot<L>, L extends string, E> {
  readonly resolve: (value: StateValue, context: S["context"]) => S;
  readonly transition: (
    snapshot: S,
    event: E
  ) => readonly [after: S, ...effects: unknown[]];
  readonly leaves: readonly L[];
  readonly metaOf: (leaf: L) => LeafMeta<unknown>;
  readonly begin: (
    row: Stated<S, L>,
    kind: Operation["kind"],
    event: E
  ) => NonNullable<Decision<Stated<S, L>>["begin"]>;
}

const valueOf = (path: string): StateValue => {
  const dot = path.indexOf(".");

  return dot === -1
    ? path
    : { [path.slice(0, dot)]: valueOf(path.slice(dot + 1)) };
};

/** Every leaf of a chart's tree, in the order the tree declares them. */
export const leavesOf = (machine: AnyStateMachine): readonly string[] => {
  const under = (node: AnyStateMachine["root"]): readonly string[] =>
    Object.keys(node.states).length === 0
      ? [node.path.join(".")]
      : Object.values(node.states).flatMap(under);

  return under(machine.root);
};

/**
 * One event on one row: the row rebuilds a snapshot, `transition` runs once, and the snapshot goes
 * with the call, as a threaded one retains every step before it. A leaf with a `step` begins an
 * operation when none is in flight, and one without finishes the operation that is. An event the
 * leaf doesn't take answers the same row.
 */
export const applied = <
  S extends Snapshot<L>,
  L extends string,
  E extends EventObject,
>(
  chart: Chart<S, L, E>,
  row: Stated<S, L>,
  event: E,
  op: Operation | undefined
): Decision<Stated<S, L>> => {
  const before = chart.resolve(valueOf(row.state), row);
  const [after] = chart.transition(before, event);

  if (after === before) {
    return { next: row, finish: false };
  }

  if (after.status === "done") {
    return { next: "removed", finish: op !== undefined };
  }

  const leaf = chart.leaves.find((path) => after.matches(path));

  if (leaf === undefined) {
    throw new Error(`${row.state} moved outside the leaves a row can hold`);
  }

  const next = { ...after.context, state: leaf };
  const { step } = chart.metaOf(leaf);

  if (op !== undefined) {
    return { next, finish: step === undefined };
  }

  return step === undefined || step === "any"
    ? { next, finish: false }
    : { next, begin: chart.begin(row, step, event), finish: false };
};
