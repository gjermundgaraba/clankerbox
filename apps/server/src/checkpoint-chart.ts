import { setup, transition, types } from "xstate";
import type { InferEvents, SnapshotFrom } from "xstate";

import { deletingRegion, rowLeavesOf, undoingRegion } from "./chart.ts";
import type { Chart, LeafMeta, LeafOf, Read, Stated } from "./chart.ts";
import type { CheckpointFacts, Lease, Operation, ShownPhase } from "./store.ts";

type HostError = NonNullable<CheckpointFacts["error"]>;

type Handle = NonNullable<CheckpointFacts["handle"]>;

export interface Done {
  readonly status: "done";
  readonly at: NonNullable<CheckpointFacts["failedAt"]>;
  readonly handle?: Handle;
}

export interface NotDone {
  readonly status: "failed" | "cancelled";
  readonly error: HostError;
  readonly at: Done["at"];
  readonly handle?: Handle;
  readonly cleared: boolean;
}

export interface CheckpointRead extends Read {
  readonly awaiting: boolean;
}

const events = {
  delete: types<object>(),
  read: types<CheckpointRead>(),
  reported: types<Done | NotDone>(),
  lost: types<{ readonly error: HostError }>(),
  publish: types<object>(),
  missing: types<{
    readonly host: string;
    readonly error: HostError;
    readonly at: Done["at"];
  }>(),
};

export type CheckpointEvent = InferEvents<typeof events>;

const makingRegion = <const Step extends "capture" | "fetch">(step: Step) =>
  ({
    initial: "due",
    states: {
      due: {
        meta: { phase: "capturing", activity: "read" },
        on: {
          read: ({ event }: { readonly event: CheckpointRead }) =>
            event.awaiting ? undefined : ({ target: "sent" } as const),
          delete: { target: "#checkpoint.deleting.due" },
        },
      },
      sent: {
        meta: { phase: "capturing", step, activity: "follow" },
        on: {
          reported: ({
            context,
            event,
          }: {
            readonly context: CheckpointFacts;
            readonly event: Done | NotDone;
          }) => {
            const handle = event.handle ?? context.handle;

            if (event.status === "done") {
              return {
                target: "#checkpoint.ready",
                context: { handle },
              } as const;
            }

            const { error, at, cleared } = event;

            return cleared
              ? ({
                  target: "#checkpoint.failed",
                  context: { error, failedAt: at },
                } as const)
              : ({
                  target: "#checkpoint.discarding.due",
                  context: { error, handle },
                } as const);
          },
          lost: ({
            event,
          }: {
            readonly event: { readonly error: HostError };
          }) =>
            ({
              target: "#checkpoint.discarding.due",
              context: { error: event.error },
            }) as const,
          delete: { target: "#checkpoint.deleting.draining" },
        },
      },
    },
  }) as const;

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
    capturing: makingRegion("capture"),
    fetching: makingRegion("fetch"),
    ready: {
      meta: { phase: "ready", activity: "none" },
      on: {
        delete: { target: "#checkpoint.deleting.due" },
        missing: ({ context, event }) =>
          event.host === context.host
            ? {
                target: "#checkpoint.failed",
                context: { error: event.error, failedAt: event.at },
              }
            : undefined,
        publish: ({ context }) => ({
          target: "#checkpoint.publishing.due",
          context: { published: context.name },
        }),
      },
    },
    publishing: {
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
          meta: { phase: "capturing", step: "publish", activity: "follow" },
          on: {
            reported: ({ event }) =>
              event.status === "done"
                ? { target: "#checkpoint.ready" }
                : {
                    target: "#checkpoint.discarding.due",
                    context: { error: event.error },
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
      {
        reported: ({
          context,
          event,
        }: {
          readonly context: CheckpointFacts;
          readonly event: Done | NotDone;
        }) =>
          ({
            target: "due",
            context: { handle: event.handle ?? context.handle },
          }) as const,
      }
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

export const { leaves, metaOf, phaseOf, activityOf, stageOf } = rowLeavesOf<
  Leaf,
  ShownPhase
>(checkpoint);

export const isPublished = ({
  name,
  published,
}: Pick<CheckpointRow, "name" | "published">): boolean => published === name;

export const fromBuild = ({ build }: Pick<CheckpointRow, "build">): boolean =>
  build !== undefined;

export const buildStoreLease = "builds/";

const storeLease = (mode: Lease["mode"]): Lease => ({
  resource: "checkpoint",
  name: buildStoreLease,
  mode,
});

const leasesOf = (
  row: CheckpointRow,
  kind: Operation["kind"]
): readonly Lease[] => {
  const self: Lease = { resource: "checkpoint", name: row.name, mode: "own" };

  if (kind === "capture") {
    return [{ resource: "machine", name: row.machine, mode: "share" }, self];
  }

  if (kind === "publish") {
    return [self, storeLease("share")];
  }

  return kind === "deleteCheckpoint" && isPublished(row)
    ? [self, storeLease("own")]
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
