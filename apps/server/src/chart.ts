import type {
  AnyStateMachine,
  EventObject,
  SnapshotFrom,
  StateValue,
} from "xstate";

import type { FreshBoot } from "./hosts.ts";
import type { Facts, Lease, Operation } from "./store.ts";

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

/** A leaf a row can hold. `gone` isn't one: the row goes in the write that reaches it. */
export type LeafOf<M extends AnyStateMachine> = Exclude<
  PathOf<SnapshotFrom<M>["value"]>,
  "gone"
>;

/** A row: the chart's context, and the leaf it rests in. */
export type Stated<C, L> = C & { readonly state: L };

/** What a `read` carries for the operation it begins, when the leaf it enters has a step. */
export interface Read {
  readonly boot: FreshBoot;
  /** The ID of the operation this read begins. */
  readonly id: string;
}

type ReadOf<E> = Extract<E, { readonly type: "read" }>;

interface Snapshot<L> {
  readonly status: string;
  readonly context: { readonly name: string; readonly host: string };
  readonly matches: (leaf: L) => boolean;
}

/**
 * What `applied` needs of a machine. A chart's file writes `resolve` and `transition` over its own
 * machine, as they are typed only there. `begins` gives what an operation takes from the chart and
 * the `read` that begins it.
 */
export interface Chart<
  S extends Snapshot<L>,
  L extends string,
  E extends EventObject,
> {
  readonly resource: Lease["resource"];
  readonly resolve: (value: StateValue, context: S["context"]) => S;
  readonly transition: (
    snapshot: S,
    event: E
  ) => readonly [after: S, ...effects: unknown[]];
  readonly leaves: readonly L[];
  readonly metaOf: (leaf: L) => LeafMeta<unknown>;
  readonly begins: (
    row: Stated<S["context"], L>,
    kind: Operation["kind"],
    read: ReadOf<E>
  ) => Pick<Operation, "id" | "boot" | "leases" | "to">;
}

interface Failed {
  readonly status: "failed" | "cancelled";
  readonly error: NonNullable<Facts["error"]>;
}

interface Reported<D> {
  readonly event: D | Failed;
}

/**
 * The region a delete enters, with no edge out of it. `draining` follows the step in flight to its
 * end, then `step` runs until its host reports it done, again at each recheck while it fails.
 */
export const deletingRegion = <
  const Id extends string,
  const Phase extends string,
  const Draining extends object,
>(
  id: Id,
  step: Operation["kind"],
  phases: { readonly due: Phase; readonly held: Phase },
  draining: Draining
) =>
  ({
    initial: "due",
    entry: () => ({ context: { error: undefined } }),
    on: { delete: { context: { error: undefined } } },
    states: {
      draining: {
        meta: { phase: "deleting", step: "any", activity: "follow" },
        on: { lost: { target: "due" }, ...draining },
      },
      due: {
        meta: { phase: phases.due, activity: "read" },
        on: { read: { target: "sent" } },
      },
      sent: {
        meta: { phase: "deleting", step, activity: "follow" },
        on: {
          reported: ({ event }: Reported<{ readonly status: "done" }>) => {
            if (event.status === "done") {
              return { target: `#${id}.gone` } as const;
            }

            return event.status === "failed"
              ? ({ target: "held", context: { error: event.error } } as const)
              : ({ target: "due" } as const);
          },
          lost: { target: "due" },
        },
      },
      held: {
        meta: { phase: phases.held, activity: "recheck" },
        on: {
          read: { target: "sent" },
          delete: { target: "due", context: { error: undefined } },
        },
      },
    },
  }) as const;

/**
 * The region a failed make or capture enters: `step` deletes what it left, again at each recheck
 * while that fails, and `done` tells where its row goes once it has. A delete goes on as `deleting`.
 */
export const undoingRegion = <
  const Id extends string,
  const Phase extends string,
  D extends { readonly status: "done" },
  const Done,
>(
  id: Id,
  step: Operation["kind"],
  phases: { readonly due: Phase; readonly sent: Phase; readonly held: Phase },
  done: (event: D) => Done
) =>
  ({
    initial: "due",
    on: { delete: { target: `#${id}.deleting.due` } },
    states: {
      due: {
        meta: { phase: phases.due, activity: "read" },
        on: { read: { target: "sent" } },
      },
      sent: {
        meta: { phase: phases.sent, step, activity: "follow" },
        on: {
          reported: ({ event }: Reported<D>) => {
            if (event.status === "done") {
              return done(event);
            }

            return event.status === "failed"
              ? ({ target: "held" } as const)
              : ({ target: "due" } as const);
          },
          lost: { target: "due" },
          delete: { target: `#${id}.deleting.sent` },
        },
      },
      held: {
        meta: { phase: phases.held, activity: "recheck" },
        on: { read: { target: "sent" } },
      },
    },
  }) as const;

const valueOf = (path: string): StateValue => {
  const dot = path.indexOf(".");

  return dot === -1
    ? path
    : { [path.slice(0, dot)]: valueOf(path.slice(dot + 1)) };
};

/** Every leaf of a chart's tree, in the order the tree declares them. */
export const leavesOf = (
  machine: Pick<AnyStateMachine, "root">
): readonly string[] => {
  const under = (node: AnyStateMachine["root"]): readonly string[] =>
    Object.keys(node.states).length === 0
      ? [node.path.join(".")]
      : Object.values(node.states).flatMap(under);

  return under(machine.root);
};

/** What a chart's leaves say of a row: every leaf a row can hold, and each one's `meta`. */
export const rowLeavesOf = <L extends string, Phase>(
  machine: Pick<AnyStateMachine, "id" | "root"> & {
    readonly getStateNodeById: (id: string) => {
      readonly meta?: LeafMeta<Phase> | undefined;
    };
  }
) => {
  const metaOf = (leaf: L): LeafMeta<Phase> => {
    const { meta } = machine.getStateNodeById(`${machine.id}.${leaf}`);

    if (meta === undefined) {
      throw new Error(`leaf ${leaf} has no meta`);
    }

    return meta;
  };

  return {
    leaves: leavesOf(machine).filter((path): path is L => path !== "gone"),
    metaOf,
    phaseOf: (leaf: L): Phase => metaOf(leaf).phase,
    activityOf: (leaf: L): Activity => metaOf(leaf).activity,
  };
};

const isRead = <E extends EventObject>(event: E): event is ReadOf<E> =>
  event.type === "read";

/**
 * One event on one row: the row rebuilds a snapshot, `transition` runs once, and the snapshot goes
 * with the call. A leaf with a `step` begins an operation when none is in flight, and one without
 * finishes the operation that is. An event the leaf doesn't take answers the same row.
 */
export const applied = <
  S extends Snapshot<L>,
  L extends string,
  E extends EventObject,
>(
  chart: Chart<S, L, E>,
  row: Stated<S["context"], L>,
  event: E,
  op: Operation | undefined
): Decision<Stated<S["context"], L>> => {
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

  if (step === undefined || step === "any") {
    return { next, finish: false };
  }

  if (!isRead(event)) {
    throw new Error(`a ${event.type} began a ${step} of ${row.name}`);
  }

  return {
    next,
    begin: {
      kind: step,
      resource: chart.resource,
      name: row.name,
      host: row.host,
      ...chart.begins(row, step, event),
    },
    finish: false,
  };
};
