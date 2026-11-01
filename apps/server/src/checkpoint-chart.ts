import { setup, transition, types } from "xstate";
import type { InferEvents, SnapshotFrom } from "xstate";

import { deletingRegion, rowLeavesOf, undoingRegion } from "./chart.ts";
import type { Chart, LeafMeta, LeafOf, Read, Stated } from "./chart.ts";
import type { CheckpointFacts, Lease, Operation, ShownPhase } from "./store.ts";

type HostError = NonNullable<CheckpointFacts["error"]>;

export interface Done {
  readonly status: "done";
  /** When what a failed capture left went, should this end its discarding. */
  readonly at: NonNullable<CheckpointFacts["failedAt"]>;
}

export interface NotDone {
  readonly status: "failed" | "cancelled";
  readonly error: HostError;
  /** When a capture failed, should it have left nothing. */
  readonly at: Done["at"];
  /** A failed capture left nothing on its host, so a delete would find nothing. */
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
      states: {
        due: {
          meta: { phase: "capturing", activity: "read" },
          on: {
            read: { target: "sent" },
            delete: { target: "#checkpoint.deleting.due" },
          },
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
    discarding: undoingRegion(
      "checkpoint",
      "deleteCheckpoint",
      { due: "failed", sent: "failed", held: "failed" },
      ({ at }: Done) =>
        ({ target: "#checkpoint.failed", context: { failedAt: at } }) as const
    ),
    deleting: deletingRegion(
      "checkpoint",
      "deleteCheckpoint",
      { due: "deleting", held: "deleting" },
      { reported: { target: "due" } }
    ),
    failed: {
      meta: { phase: "failed", activity: "none" },
      on: { delete: { target: "gone" } },
    },
    gone: { type: "final" },
  },
});

export type Leaf = LeafOf<typeof checkpoint>;

export type CheckpointRow = Stated<CheckpointFacts, Leaf>;

export const { leaves, metaOf, phaseOf, activityOf } = rowLeavesOf<
  Leaf,
  ShownPhase
>(checkpoint);

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
  resource: "checkpoint",
  resolve: (value, context) => checkpoint.resolveState({ value, context }),
  transition: (snapshot, event) => transition(checkpoint, snapshot, event),
  leaves,
  metaOf,
  begins: (row, kind, { id, boot }) => ({
    id,
    boot,
    leases: leasesOf(row, kind),
    to: undefined,
  }),
};
