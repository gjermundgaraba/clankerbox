import { setup, transition, types } from "xstate";
import type { InferEvents, SnapshotFrom } from "xstate";

import { leavesOf } from "./chart.ts";
import type { Activity, Chart, LeafMeta, PathOf } from "./chart.ts";
import type { CheckpointFacts, Lease, Operation, ShownPhase } from "./store.ts";

type HostError = NonNullable<CheckpointFacts["error"]>;

export interface Read {
  /**
   * From a fresh `hosts.read`, never `hosts.known`, whose boot may be from before a restart: a step
   * sent under it is lost as soon as it is polled.
   */
  readonly boot: string;
  /** The ID of the operation this read begins, if it begins one. */
  readonly id: string;
}

export interface Done {
  readonly status: "done";
  /** When what a failed capture left went, should this end its discarding. */
  readonly at: NonNullable<CheckpointFacts["failedAt"]>;
}

export interface NotDone {
  readonly status: "failed" | "cancelled";
  readonly error: HostError;
  /** When a capture failed, should its host have cleared what it began. */
  readonly at: Done["at"];
  /** A failed capture's host cleared what it began, so a delete would find nothing. */
  readonly cleared: boolean;
}

const events = {
  delete: types<object>(),
  read: types<Read>(),
  reported: types<Done | NotDone>(),
  lost: types<{ readonly error: HostError }>(),
};

export type CheckpointEvent = InferEvents<typeof events>;

export const checkpoint = setup({
  schemas: {
    context: types<CheckpointFacts>(),
    input: types<CheckpointFacts>(),
    meta: types<LeafMeta<ShownPhase>>(),
    events,
  },
}).createMachine({
  id: "checkpoint",
  context: ({ input }) => input,
  initial: "capturing",
  states: {
    capturing: {
      initial: "due",
      on: { delete: { target: "#checkpoint.deleting.due" } },
      states: {
        due: {
          meta: { phase: "capturing", activity: "read" },
          on: { read: { target: "sent" } },
        },
        sent: {
          meta: { phase: "capturing", step: "capture", activity: "follow" },
          on: {
            reported: ({ event }) => {
              if (event.status === "done") {
                return { target: "#checkpoint.ready" };
              }

              const { error, at, cleared } = event;

              return cleared
                ? {
                    target: "#checkpoint.failed",
                    context: { error, failedAt: at },
                  }
                : {
                    target: "#checkpoint.discarding.due",
                    context: { error },
                  };
            },
            lost: ({ event }) => ({
              target: "#checkpoint.discarding.due",
              context: { error: event.error },
            }),
            delete: { target: "#checkpoint.deleting.draining" },
          },
        },
      },
    },
    ready: {
      meta: { phase: "ready", activity: "none" },
      on: { delete: { target: "#checkpoint.deleting.due" } },
    },
    discarding: {
      initial: "due",
      on: { delete: { target: "#checkpoint.deleting.due" } },
      states: {
        due: {
          meta: { phase: "failed", activity: "read" },
          on: { read: { target: "sent" } },
        },
        sent: {
          meta: {
            phase: "failed",
            step: "deleteCheckpoint",
            activity: "follow",
          },
          on: {
            reported: ({ event }) => {
              if (event.status === "done") {
                return {
                  target: "#checkpoint.failed",
                  context: { failedAt: event.at },
                };
              }

              return event.status === "failed"
                ? { target: "held" }
                : { target: "due" };
            },
            lost: { target: "due" },
            delete: { target: "#checkpoint.deleting.sent" },
          },
        },
        held: {
          meta: { phase: "failed", activity: "recheck" },
          on: { read: { target: "sent" } },
        },
      },
    },
    deleting: {
      initial: "due",
      entry: () => ({ context: { error: undefined } }),
      on: { delete: { context: { error: undefined } } },
      states: {
        draining: {
          meta: { phase: "deleting", step: "any", activity: "follow" },
          on: {
            reported: { target: "due" },
            lost: { target: "due" },
          },
        },
        due: {
          meta: { phase: "deleting", activity: "read" },
          on: { read: { target: "sent" } },
        },
        sent: {
          meta: {
            phase: "deleting",
            step: "deleteCheckpoint",
            activity: "follow",
          },
          on: {
            reported: ({ event }) => {
              if (event.status === "done") {
                return { target: "#checkpoint.gone" };
              }

              return event.status === "failed"
                ? { target: "held", context: { error: event.error } }
                : { target: "due" };
            },
            lost: { target: "due" },
          },
        },
        held: {
          meta: { phase: "deleting", activity: "recheck" },
          on: {
            read: { target: "sent" },
            delete: { target: "due", context: { error: undefined } },
          },
        },
      },
    },
    failed: {
      meta: { phase: "failed", activity: "none" },
      on: { delete: { target: "gone" } },
    },
    gone: { type: "final" },
  },
});

/** A leaf a row can hold. `gone` isn't one: the row goes in the write that reaches it. */
export type Leaf = Exclude<
  PathOf<SnapshotFrom<typeof checkpoint>["value"]>,
  "gone"
>;

/** A checkpoint's row: the facts, and the one leaf that holds how far it is and what it does. */
export type CheckpointRow = CheckpointFacts & { readonly state: Leaf };

const isLeaf = (path: string): path is Leaf => path !== "gone";

export const leaves: readonly Leaf[] = leavesOf(checkpoint).filter(isLeaf);

export const metaOf = (state: Leaf): LeafMeta<ShownPhase> => {
  const { meta } = checkpoint.getStateNodeById(`checkpoint.${state}`);

  if (meta === undefined) {
    throw new Error(`leaf ${state} has no meta`);
  }

  return meta;
};

export const phaseOf = (state: Leaf): ShownPhase => metaOf(state).phase;

export const activityOf = (state: Leaf): Activity => metaOf(state).activity;

const leasesOf = (
  row: CheckpointRow,
  kind: Operation["kind"]
): readonly Lease[] => {
  const self: Lease = { resource: "checkpoint", name: row.name, mode: "own" };

  return kind === "capture"
    ? [{ resource: "machine", name: row.machine, mode: "share" }, self]
    : [self];
};

export const checkpointChart: Chart<
  SnapshotFrom<typeof checkpoint>,
  Leaf,
  CheckpointEvent
> = {
  resolve: (value, context) => checkpoint.resolveState({ value, context }),
  transition: (snapshot, event) => transition(checkpoint, snapshot, event),
  leaves,
  metaOf,
  begin: (row, kind, event) => {
    if (event.type !== "read") {
      throw new Error(`a ${event.type} began a ${kind} of ${row.name}`);
    }

    return {
      id: event.id,
      kind,
      resource: "checkpoint",
      name: row.name,
      host: row.host,
      boot: event.boot,
      seen: "unknown",
      leases: leasesOf(row, kind),
      to: undefined,
    };
  },
};
