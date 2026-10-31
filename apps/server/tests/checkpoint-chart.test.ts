import { describe, expect, it } from "@effect/vitest";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { adjacencyMapToArray, getAdjacencyMap } from "xstate/graph";

import { applied, leavesOf } from "../src/chart.ts";
import {
  activityOf,
  checkpoint,
  checkpointChart,
  leaves,
  metaOf,
  phaseOf,
} from "../src/checkpoint-chart.ts";
import type {
  CheckpointEvent,
  CheckpointRow,
  Leaf,
} from "../src/checkpoint-chart.ts";
import type { CheckpointFacts, Operation, ShownPhase } from "../src/store.ts";
import {
  checkpointFacts,
  failure as error,
  flight,
  when as at,
} from "./chart-rows.ts";

const earlier = new Internal({ message: "an earlier failure" });

const rowAt = (state: Leaf, fields?: Partial<CheckpointFacts>) =>
  ({ ...checkpointFacts(fields), state }) satisfies CheckpointRow;

const inFlight = (kind: Operation["kind"]) =>
  flight(kind, { resource: "checkpoint", name: "snap" });

const onHost = (state: Leaf, kind?: Operation["kind"]) => {
  const { step } = metaOf(state);

  if (step === undefined) {
    return undefined;
  }

  return inFlight(step === "any" ? (kind ?? "capture") : step);
};

const go = (
  row: CheckpointRow,
  event: CheckpointEvent,
  kind?: Operation["kind"]
) => applied(checkpointChart, row, event, onHost(row.state, kind));

const leafOf = (row: CheckpointRow, event: CheckpointEvent) => {
  const { next } = go(row, event);

  return next === "removed" ? "removed" : next.state;
};

const after = (row: CheckpointRow, event: CheckpointEvent): CheckpointRow => {
  const { next } = go(row, event);

  if (next === "removed") {
    throw new Error("the row went");
  }

  return next;
};

const removal: CheckpointEvent = { type: "delete" };

const read: CheckpointEvent = { type: "read", boot: "fresh", id: "new" };

const done: CheckpointEvent = { type: "reported", status: "done", at };

const failed: CheckpointEvent = {
  type: "reported",
  status: "failed",
  error,
  at,
  cleared: false,
};

const cancelled: CheckpointEvent = {
  type: "reported",
  status: "cancelled",
  error,
  at,
  cleared: false,
};

const gone: CheckpointEvent = { type: "lost", error };

const events = { removal, read, done, failed, cancelled, gone };

const names = [
  "removal",
  "read",
  "done",
  "failed",
  "cancelled",
  "gone",
] as const;

type Edge = (typeof names)[number];

const edges: Readonly<
  Record<Leaf, Readonly<Partial<Record<Edge, Leaf | "removed">>>>
> = {
  "capturing.due": { removal: "deleting.due", read: "capturing.sent" },
  "capturing.sent": {
    removal: "deleting.draining",
    done: "ready",
    failed: "discarding.due",
    cancelled: "discarding.due",
    gone: "discarding.due",
  },
  ready: { removal: "deleting.due" },
  "discarding.due": { removal: "deleting.due", read: "discarding.sent" },
  "discarding.sent": {
    removal: "deleting.sent",
    done: "failed",
    failed: "discarding.held",
    cancelled: "discarding.due",
    gone: "discarding.due",
  },
  "discarding.held": { removal: "deleting.due", read: "discarding.sent" },
  "deleting.draining": {
    removal: "deleting.draining",
    done: "deleting.due",
    failed: "deleting.due",
    cancelled: "deleting.due",
    gone: "deleting.due",
  },
  "deleting.due": { removal: "deleting.due", read: "deleting.sent" },
  "deleting.sent": {
    removal: "deleting.sent",
    done: "removed",
    failed: "deleting.held",
    cancelled: "deleting.due",
    gone: "deleting.due",
  },
  "deleting.held": { removal: "deleting.due", read: "deleting.sent" },
  failed: { removal: "removed" },
};

const phases: Readonly<Record<Leaf, ShownPhase>> = {
  "capturing.due": "capturing",
  "capturing.sent": "capturing",
  ready: "ready",
  "discarding.due": "failed",
  "discarding.sent": "failed",
  "discarding.held": "failed",
  "deleting.draining": "deleting",
  "deleting.due": "deleting",
  "deleting.sent": "deleting",
  "deleting.held": "deleting",
  failed: "failed",
};

const representatives = Object.values(events);

const clearing: readonly Leaf[] = [
  "discarding.due",
  "discarding.held",
  "deleting.due",
  "deleting.held",
];

const fixtures = leaves.flatMap((state) => {
  const { step } = metaOf(state);

  const kinds: ReadonlyArray<Operation["kind"]> =
    step === "any" ? ["capture", "deleteCheckpoint"] : ["capture"];

  return [undefined, earlier].flatMap((held) =>
    kinds.map((kind) => ({
      row: rowAt(state, { error: held }),
      op: onHost(state, kind),
    }))
  );
});

describe("the chart", () => {
  it("takes every event from every leaf where its table says, and writes nothing for one the table doesn't name", () => {
    const table = leaves.flatMap((state) => {
      const row = rowAt(state);

      return names.map((edge) => {
        const event = events[edge];
        const { next } = go(row, event);

        return {
          state,
          edge,
          chart: next === row ? undefined : leafOf(row, event),
          named: edges[state][edge],
        };
      });
    });

    expect(table).toHaveLength(leaves.length * names.length);
    expect(table.filter(({ chart, named }) => chart !== named)).toStrictEqual(
      []
    );
  });

  it("in every walk a transition's only effect is ending an actor no row has, as the row goes, and a leaf that doesn't take an event hands back the snapshot it was given, which is how applied tells", () => {
    const steps = fixtures.flatMap(({ row, op }) =>
      representatives.map((event) => {
        let effects: readonly unknown[] = [];
        let same = false;

        const { next } = applied(
          {
            ...checkpointChart,
            transition: (before, sent) => {
              const [moved, ...rest] = checkpointChart.transition(before, sent);

              effects = rest.flat();
              same = moved === before;

              return [moved, ...rest];
            },
          },
          row,
          event,
          op
        );

        return { effects, same, next, row };
      })
    );

    const ending: readonly unknown[] = [
      expect.objectContaining({ type: "@xstate.terminate" }),
    ];

    expect(steps.some(({ next }) => next === "removed")).toBe(true);
    expect(steps.some(({ same }) => same)).toBe(true);
    expect(steps.map(({ effects }) => effects)).toStrictEqual(
      steps.map(({ next }) => (next === "removed" ? ending : []))
    );
    expect(
      steps.filter(({ same, next, row }) => same !== (next === row))
    ).toStrictEqual([]);
  });

  it("reaches every leaf, with these events from a capture", () => {
    const adjacency = getAdjacencyMap(checkpoint, {
      input: checkpointFacts(),
      events: [...representatives],
    });

    const reached = adjacencyMapToArray(adjacency).map(
      ({ nextState }) => nextState
    );

    expect(
      leaves.filter((leaf) => !reached.some((state) => state.matches(leaf)))
    ).toStrictEqual([]);
    expect(reached.some(({ status }) => status === "done")).toBe(true);
  });

  it("has a leaf for each row the table names, and no other", () => {
    expect([...leaves].toSorted()).toStrictEqual(
      Object.keys(phases).toSorted()
    );
    expect(
      leavesOf(checkpoint).filter((leaf) => !leaves.some((row) => row === leaf))
    ).toStrictEqual(["gone"]);
  });

  it("every leaf shows the wire's phase its table names, so what a failure still clears reads failed", () => {
    expect(
      leaves.filter((state) => phaseOf(state) !== phases[state])
    ).toStrictEqual([]);
  });

  it("a leaf is followed exactly when it has a step, and a rest moves only by a request", () => {
    expect(
      leaves.filter(
        (state) =>
          (activityOf(state) === "follow") !==
          (metaOf(state).step !== undefined)
      )
    ).toStrictEqual([]);
    expect(
      leaves.filter((state) => activityOf(state) === "none")
    ).toStrictEqual(["ready", "failed"]);
    expect(
      Object.entries(edges).filter(
        ([state, taken]) =>
          (state === "ready" || state === "failed") &&
          Object.keys(taken).some((edge) => edge !== "removal")
      )
    ).toStrictEqual([]);
  });

  it("begins an operation entering a leaf with a step, and finishes it leaving one", () => {
    const wrong = fixtures.flatMap(({ row, op }) =>
      representatives.flatMap((event) => {
        const { next, begin, finish } = applied(
          checkpointChart,
          row,
          event,
          op
        );

        const moved = next !== row;
        const step = next === "removed" ? undefined : metaOf(next.state).step;

        const right =
          op === undefined
            ? !finish &&
              (moved && step !== undefined
                ? begin?.kind === step && event.type === "read"
                : begin === undefined)
            : begin === undefined && finish === (moved && step === undefined);

        return right ? [] : [[row.state, event.type, op?.kind]];
      })
    );

    expect(wrong).toStrictEqual([]);
  });

  it("a capture shares its machine and owns the checkpoint, and a delete owns it alone", () => {
    const self = { resource: "checkpoint", name: "snap", mode: "own" };

    expect(
      applied(checkpointChart, rowAt("capturing.due"), read, undefined).begin
    ).toStrictEqual({
      id: "new",
      kind: "capture",
      resource: "checkpoint",
      name: "snap",
      host: "linux",
      boot: "fresh",
      seen: "unknown",
      leases: [{ resource: "machine", name: "dev", mode: "share" }, self],
      to: undefined,
    });
    expect(
      clearing.map((state) => {
        const begun = applied(checkpointChart, rowAt(state), read, undefined);

        return [begun.begin?.kind, begun.begin?.leases];
      })
    ).toStrictEqual(clearing.map(() => ["deleteCheckpoint", [self]]));
  });
});

describe("a delete", () => {
  it("from a rest never ends at a rest", () => {
    expect(
      leaves
        .filter((state) => activityOf(state) === "none")
        .map((state) => leafOf(rowAt(state), removal))
    ).toStrictEqual(["deleting.due", "removed"]);
  });

  it("during a capture lets the step drain, keeping its operation, then runs the delete whatever it reported", () => {
    const capture = inFlight("capture");

    const draining = applied(
      checkpointChart,
      rowAt("capturing.sent"),
      removal,
      capture
    );

    expect(draining).toStrictEqual({
      next: rowAt("deleting.draining"),
      finish: false,
    });

    expect(
      [done, failed, cancelled, gone].map((ending) =>
        applied(checkpointChart, rowAt("deleting.draining"), ending, capture)
      )
    ).toStrictEqual(
      [done, failed, cancelled, gone].map(() => ({
        next: rowAt("deleting.due"),
        finish: true,
      }))
    );
  });

  it("while a discard's delete runs takes that delete as its own, and drops the capture's error", () => {
    const row = rowAt("discarding.sent", { error: earlier });
    const running = inFlight("deleteCheckpoint");

    expect(applied(checkpointChart, row, removal, running)).toStrictEqual({
      next: rowAt("deleting.sent"),
      finish: false,
    });
  });

  it("clears the error any step left, and one asked again tries at once", () => {
    expect(after(rowAt("discarding.held", { error }), removal)).toStrictEqual(
      rowAt("deleting.due")
    );
    expect(after(rowAt("deleting.held", { error }), removal)).toStrictEqual(
      rowAt("deleting.due")
    );
  });

  it("that fails says why and holds for the recheck, and a read tries again", () => {
    const held = after(rowAt("deleting.sent"), failed);

    expect(held).toStrictEqual(rowAt("deleting.held", { error }));
    expect(after(held, read)).toStrictEqual(rowAt("deleting.sent", { error }));
    expect(activityOf(held.state)).toBe("recheck");
  });

  it("of a failed row takes the row at once, with nothing to run", () => {
    expect(
      applied(
        checkpointChart,
        rowAt("failed", { error, failedAt: at }),
        removal,
        undefined
      )
    ).toStrictEqual({ next: "removed", finish: false });
  });
});

describe("a capture", () => {
  it("that ends is ready", () => {
    expect(after(rowAt("capturing.sent"), done)).toStrictEqual(rowAt("ready"));
  });

  it.each([
    ["failed", failed],
    ["cut short", cancelled],
    ["lost", gone],
  ])("%s keeps its error and clears what it left", (_, ending) => {
    expect(after(rowAt("capturing.sent"), ending)).toStrictEqual(
      rowAt("discarding.due", { error })
    );
  });

  it.each([
    ["failed", "failed"],
    ["cut short", "cancelled"],
  ] as const)(
    "%s when its host cleared what it began rests failed at once, as a delete would find nothing",
    (_, status) => {
      expect(
        applied(
          checkpointChart,
          rowAt("capturing.sent"),
          { type: "reported", status, error, at, cleared: true },
          inFlight("capture")
        )
      ).toStrictEqual({
        next: rowAt("failed", { error, failedAt: at }),
        finish: true,
      });
    }
  );

  it("rests failed once what it left has gone, with its own error and when", () => {
    expect(
      after(rowAt("discarding.sent", { error: earlier }), done)
    ).toStrictEqual(rowAt("failed", { error: earlier, failedAt: at }));
  });

  it("keeps its own error when clearing fails, and holds for the recheck", () => {
    expect(
      after(rowAt("discarding.sent", { error: earlier }), failed)
    ).toStrictEqual(rowAt("discarding.held", { error: earlier }));
  });

  it("clears again when that clearing was lost or cut short", () => {
    expect(
      [gone, cancelled].map((ending) =>
        after(rowAt("discarding.sent", { error: earlier }), ending)
      )
    ).toStrictEqual(
      [gone, cancelled].map(() => rowAt("discarding.due", { error: earlier }))
    );
  });
});
