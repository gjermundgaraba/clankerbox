import { setup, transition, types } from "xstate";
import type { InferEvents, SnapshotFrom } from "xstate";

import { deletingRegion, rowLeavesOf, undoingRegion } from "./chart.ts";
import type {
  Chart,
  LeafMeta,
  LeafOf,
  Read as Begins,
  Stated,
} from "./chart.ts";
import type { Facts, Lease, MachinePhase, Operation } from "./store.ts";

/** What a machine can be asked to be. */
export type Wish = Facts["desired"];

/** What a client reads as `desired`, and what `wants` decides by. */
export type Asked = Wish | "deleted";

type HostError = NonNullable<Facts["error"]>;

type Sizing = NonNullable<Facts["resize"]>;

/** What a step leaves that only its host can tell. */
export interface Outcome {
  readonly port?: number;
  readonly hostKey?: string;
  readonly sizes?: Pick<Facts, "cpu" | "ramMib" | "diskGib">;
}

/** Where a failed create goes next, past a host that hadn't the capacity. */
export type Move = Pick<Facts, "host" | "kind" | "pin" | "source" | "prebuild">;

export interface Read extends Begins {
  readonly seen: Operation["seen"];
  readonly pin: string | undefined;
  /** Whether a tailnet join is due, should the machine settle. */
  readonly joins: boolean;
}

export interface Done {
  readonly status: "done";
  readonly outcome: Outcome;
  /** When a failed create's VM went, should this end its undoing. */
  readonly at: NonNullable<Facts["undoneAt"]>;
  readonly move?: Move;
}

/** `error` also says what cut a cancelled make short, which its host doesn't. */
export interface NotDone {
  readonly status: "failed" | "cancelled";
  readonly outcome: Outcome;
  readonly error: HostError;
}

const events = {
  ask: types<{ readonly desired: Wish }>(),
  resize: types<{ readonly sizing: Sizing }>(),
  delete: types<object>(),
  read: types<Read>(),
  refused: types<{ readonly error: HostError }>(),
  ran: types<{ readonly port: number }>(),
  reported: types<Done | NotDone>(),
  lost: types<{ readonly error: HostError }>(),
  sized: types<{ readonly sizing: Sizing }>(),
};

export type MachineEvent = InferEvents<typeof events>;

interface On<T extends MachineEvent["type"]> {
  readonly context: Facts;
  readonly event: Extract<MachineEvent, { readonly type: T }>;
}

/** Whether what is asked still wants a step of `kind`. */
export const wants = (kind: Operation["kind"], desired: Asked): boolean => {
  switch (kind) {
    case "make": {
      return desired !== "deleted";
    }

    case "start":
    case "join": {
      return desired === "running";
    }

    case "stop": {
      return desired === "stopped";
    }

    case "pause": {
      return desired === "paused";
    }

    case "remove":
    case "resize":
    case "capture":
    case "deleteCheckpoint": {
      return true;
    }
  }
};

const asked = ({ context, event }: On<"ask">) => ({
  desired: event.desired,
  error: undefined,
  prepared: event.desired === "running" ? false : context.prepared,
});

const owed = ({ event }: On<"resize">) => ({
  resize: event.sizing,
  error: undefined,
});

const told = (context: Facts, { outcome }: On<"reported">["event"]) => ({
  port: outcome.port ?? context.port,
  hostKey: outcome.hostKey ?? context.hostKey,
  ...outcome.sizes,
});

const ended =
  (kind: Operation["kind"], done: Pick<Facts, "prepared">) =>
  ({ context, event }: On<"reported">) => {
    if (
      event.status === "failed" &&
      wants(kind, context.desired) &&
      context.resize === undefined
    ) {
      return {
        target: "#machine.made.failed",
        context: { ...told(context, event), error: event.error },
      } as const;
    }

    return {
      target: "#machine.made.observing",
      context: {
        ...told(context, event),
        ...(event.status === "done" ? done : {}),
      },
    } as const;
  };

const decided = ({ context, event }: On<"read">) => {
  const { desired, prepared, resize } = context;
  const { seen, joins, pin } = event;

  if (seen === "unknown") {
    return;
  }

  if (seen === "missing") {
    return { target: "#machine.made.lost" } as const;
  }

  if (resize !== undefined) {
    return { target: "#machine.made.stepping.resizing" } as const;
  }

  if (desired === "paused") {
    return seen === "running"
      ? ({ target: "#machine.made.stepping.pausing" } as const)
      : ({ target: "#machine.made.settled" } as const);
  }

  if (desired === "stopped") {
    return seen === "stopped"
      ? ({ target: "#machine.made.settled" } as const)
      : ({ target: "#machine.made.stepping.stopping" } as const);
  }

  if (seen !== "running" || !prepared) {
    return seen === "stopped"
      ? ({
          target: "#machine.made.stepping.starting",
          context: { pin },
        } as const)
      : ({ target: "#machine.made.stepping.starting" } as const);
  }

  return joins
    ? ({ target: "#machine.made.stepping.joining" } as const)
    : ({ target: "#machine.made.settled" } as const);
};

export const machine = setup({
  schemas: {
    context: types<Facts>(),
    input: types<Facts>(),
    meta: types<LeafMeta<MachinePhase>>(),
    events,
  },
}).createMachine({
  id: "machine",
  context: ({ input }) => input,
  initial: "making",
  on: {
    sized: ({ context, event }) => ({
      context: {
        cpu: event.sizing.cpu ?? context.cpu,
        ramMib: event.sizing.ramMib ?? context.ramMib,
        diskGib: event.sizing.diskGib ?? context.diskGib,
      },
    }),
  },
  states: {
    making: {
      initial: "due",
      on: {
        ask: (args) => ({ context: asked(args) }),
        delete: { target: "#machine.deleting.due" },
      },
      states: {
        due: {
          meta: { phase: "observing", activity: "read" },
          on: {
            read: { target: "sent" },
            refused: ({ event }) => ({
              target: "#machine.undoing.due",
              context: { error: event.error },
            }),
          },
        },
        sent: {
          meta: { phase: "creating", step: "make", activity: "follow" },
          on: {
            ran: ({ event }) => ({ context: { port: event.port } }),
            reported: ({ context, event }) =>
              event.status === "done"
                ? {
                    target: "#machine.made.observing",
                    context: { ...told(context, event), prepared: false },
                  }
                : {
                    target: "#machine.undoing.due",
                    context: { ...told(context, event), error: event.error },
                  },
            lost: ({ event }) => ({
              target: "#machine.undoing.due",
              context: { error: event.error },
            }),
            delete: { target: "#machine.deleting.draining" },
          },
        },
      },
    },
    made: {
      initial: "observing",
      on: {
        ask: (args) => ({
          target: "#machine.made.observing",
          context: asked(args),
        }),
        resize: (args) => ({
          target: "#machine.made.observing",
          context: owed(args),
        }),
        delete: { target: "#machine.deleting.due" },
      },
      states: {
        observing: {
          meta: { phase: "observing", activity: "read" },
          on: { read: decided },
        },
        settled: {
          meta: { phase: "settled", activity: "recheck" },
          on: { read: decided },
        },
        lost: {
          meta: { phase: "lost", activity: "recheck" },
          on: { read: decided },
        },
        failed: { meta: { phase: "failed", activity: "none" } },
        stepping: {
          initial: "starting",
          on: {
            ask: (args) => ({ context: asked(args) }),
            resize: (args) => ({ context: owed(args) }),
            delete: { target: "#machine.deleting.draining" },
            lost: { target: "#machine.made.observing" },
          },
          states: {
            starting: {
              meta: { phase: "starting", step: "start", activity: "follow" },
              on: { reported: ended("start", { prepared: true }) },
            },
            stopping: {
              meta: { phase: "stopping", step: "stop", activity: "follow" },
              on: { reported: ended("stop", { prepared: false }) },
            },
            pausing: {
              meta: { phase: "pausing", step: "pause", activity: "follow" },
              on: { reported: ended("pause", { prepared: false }) },
            },
            resizing: {
              meta: { phase: "resizing", step: "resize", activity: "follow" },
              entry: () => ({ context: { resize: undefined } }),
              on: {
                reported: ({ context, event }) =>
                  event.status === "failed"
                    ? {
                        target: "#machine.made.failed",
                        context: {
                          ...told(context, event),
                          error: event.error,
                        },
                      }
                    : {
                        target: "#machine.made.observing",
                        context: told(context, event),
                      },
              },
            },
            joining: {
              initial: "sent",
              states: {
                sent: {
                  meta: { phase: "settled", step: "join", activity: "follow" },
                  on: {
                    ask: (args) => ({
                      target: "asked",
                      context: asked(args),
                    }),
                    resize: (args) => ({
                      target: "asked",
                      context: owed(args),
                    }),
                    reported: { target: "#machine.made.settled" },
                    lost: { target: "#machine.made.settled" },
                  },
                },
                asked: {
                  meta: {
                    phase: "observing",
                    step: "join",
                    activity: "follow",
                  },
                  on: { reported: { target: "#machine.made.observing" } },
                },
              },
            },
          },
        },
      },
    },
    undoing: undoingRegion(
      "machine",
      "remove",
      { due: "observing", sent: "deleting", held: "failed" },
      ({ move, at }: Done) =>
        move === undefined
          ? ({ target: "#machine.undone", context: { undoneAt: at } } as const)
          : ({
              target: "#machine.making.due",
              context: { ...move, error: undefined, port: undefined },
            } as const)
    ),
    undone: {
      meta: { phase: "failed", activity: "none" },
      on: { delete: { target: "gone" } },
    },
    deleting: deletingRegion(
      "machine",
      "remove",
      { due: "observing", held: "failed" },
      {
        ran: ({ event }: On<"ran">) => ({ context: { port: event.port } }),
        reported: ({ context, event }: On<"reported">) =>
          ({
            target: "due",
            context: {
              ...told(context, event),
              ...(event.status === "failed" ? { error: event.error } : {}),
            },
          }) as const,
      }
    ),
    gone: { type: "final" },
  },
});

export type Leaf = LeafOf<typeof machine>;

export type MachineRow = Stated<Facts, Leaf>;

export const { leaves, metaOf, phaseOf, activityOf } = rowLeavesOf<
  Leaf,
  MachinePhase
>(machine);

type TopOf<L> = L extends `${infer Top}.${string}` ? Top : L;

/** A leaf's top region, which is how far a machine is. */
export type Stage = TopOf<Leaf>;

const stages = Object.keys(machine.root.states).filter(
  (top): top is Stage => top !== "gone"
);

export const stageOf = (state: Leaf): Stage => {
  const stage = stages.find(
    (top) => state === top || state.startsWith(`${top}.`)
  );

  if (stage === undefined) {
    throw new Error(`leaf ${state} is in no region`);
  }

  return stage;
};

export const desiredOf = ({
  state,
  desired,
}: Pick<MachineRow, "state" | "desired">): Asked =>
  stageOf(state) === "deleting" ? "deleted" : desired;

const leasesOf = (
  row: MachineRow,
  kind: Operation["kind"]
): readonly Lease[] => {
  const self: Lease = {
    resource: "machine",
    name: row.name,
    mode: kind === "join" ? "share" : "own",
  };

  return kind === "make" && row.source.kind !== "base"
    ? [
        self,
        { resource: row.source.kind, name: row.source.name, mode: "share" },
      ]
    : [self];
};

export const machineChart: Chart<
  SnapshotFrom<typeof machine>,
  Leaf,
  MachineEvent
> = {
  resource: "machine",
  resolve: (value, context) => machine.resolveState({ value, context }),
  transition: (snapshot, event) => transition(machine, snapshot, event),
  leaves,
  metaOf,
  begins: (row, kind, { id, boot, seen }) => ({
    id,
    boot,
    seen,
    leases: leasesOf(row, kind),
    to: kind === "resize" ? row.resize : undefined,
  }),
};
