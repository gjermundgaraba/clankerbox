import type {
  AnyStateMachine,
  EventObject,
  SnapshotFrom,
  StateValue,
} from "xstate";

import type { FreshBoot } from "./hosts.ts";
import type { Decision, Facts, Lease, Operation } from "./store.ts";

export type Activity = "read" | "follow" | "recheck" | "none";

export type Step = Operation["kind"] | "any";

export interface LeafMeta<Phase> {
  readonly phase: Phase;
  readonly step?: Step;
  readonly activity: Activity;
}

export type PathOf<Value> = Value extends string
  ? Value
  : { [K in keyof Value & string]: `${K}.${PathOf<Value[K]>}` }[keyof Value &
      string];

export type LeafOf<M extends AnyStateMachine> = Exclude<
  PathOf<SnapshotFrom<M>["value"]>,
  "gone"
>;

export type Stated<C, L> = C & { readonly state: L };

export interface Read {
  readonly boot: FreshBoot;
  readonly id: string;
}

type ReadOf<E> = Extract<E, { readonly type: "read" }>;

interface Snapshot<L> {
  readonly status: string;
  readonly context: { readonly name: string; readonly host: string };
  readonly matches: (leaf: L) => boolean;
}

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

export const leavesOf = (
  machine: Pick<AnyStateMachine, "root">
): readonly string[] => {
  const under = (node: AnyStateMachine["root"]): readonly string[] =>
    Object.keys(node.states).length === 0
      ? [node.path.join(".")]
      : Object.values(node.states).flatMap(under);

  return under(machine.root);
};

export type TopOf<L> = L extends `${infer Top}.${string}` ? Top : L;

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

  const stages = Object.keys(machine.root.states).filter(
    (top): top is TopOf<L> => top !== "gone"
  );

  const stageOf = (leaf: L): TopOf<L> => {
    const stage = stages.find(
      (top) => leaf === top || leaf.startsWith(`${top}.`)
    );

    if (stage === undefined) {
      throw new Error(`leaf ${leaf} is in no region`);
    }

    return stage;
  };

  return {
    leaves: leavesOf(machine).filter((path): path is L => path !== "gone"),
    stageOf,
    metaOf,
    phaseOf: (leaf: L): Phase => metaOf(leaf).phase,
    activityOf: (leaf: L): Activity => metaOf(leaf).activity,
  };
};

const isRead = <E extends EventObject>(event: E): event is ReadOf<E> =>
  event.type === "read";

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
