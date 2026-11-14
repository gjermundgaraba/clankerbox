import { Handle } from "@clankerbox/host-contract";
import { describe, expect, it } from "@effect/vitest";
import { Internal, Missing, Name } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { adjacencyMapToArray, getAdjacencyMap } from "xstate/graph";

import { applied, leavesOf } from "../src/chart.ts";
import {
  activityOf,
  buildStoreLease,
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
  freshBoot,
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

const read: CheckpointEvent = {
  type: "read",
  boot: freshBoot("fresh"),
  id: "new",
  awaiting: false,
};

const awaited: CheckpointEvent = { ...read, awaiting: true };

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

const publish: CheckpointEvent = { type: "publish" };

const found: CheckpointEvent = {
  type: "found",
  instance: "1",
  handle: Handle.make("ckpt-found"),
};

const vanished: CheckpointEvent = {
  type: "missing",
  host: "linux",
  error: new Missing({
    message: "checkpoint snap is missing from the smolvm runtime of this host",
    checkpoint: "snap",
  }),
  at,
};

const events = {
  removal,
  read,
  awaited,
  done,
  failed,
  cancelled,
  gone,
  publish,
  found,
  vanished,
};

const names = [
  "removal",
  "read",
  "awaited",
  "done",
  "failed",
  "cancelled",
  "gone",
  "publish",
  "found",
  "vanished",
] as const;

type Edge = (typeof names)[number];

const edges: Readonly<
  Record<Leaf, Readonly<Partial<Record<Edge, Leaf | "removed">>>>
> = {
  "capturing.due": {
    removal: "deleting.due",
    read: "capturing.sent",
    found: "capturing.due",
  },
  "capturing.sent": {
    removal: "deleting.draining",
    done: "ready",
    failed: "discarding.due",
    cancelled: "discarding.due",
    gone: "discarding.due",
    found: "capturing.sent",
  },
  "fetching.due": {
    removal: "deleting.due",
    read: "fetching.sent",
    found: "fetching.due",
  },
  "fetching.sent": {
    removal: "deleting.draining",
    done: "ready",
    failed: "discarding.due",
    cancelled: "discarding.due",
    gone: "discarding.due",
    found: "fetching.sent",
  },
  ready: {
    removal: "deleting.due",
    publish: "publishing.due",
    found: "ready",
    vanished: "failed",
  },
  "publishing.due": {
    removal: "deleting.due",
    read: "publishing.sent",
    awaited: "publishing.sent",
    found: "publishing.due",
  },
  "publishing.sent": {
    removal: "deleting.draining",
    done: "ready",
    failed: "discarding.due",
    cancelled: "discarding.due",
    gone: "discarding.due",
    found: "publishing.sent",
  },
  "discarding.due": {
    removal: "deleting.due",
    read: "discarding.sent",
    awaited: "discarding.sent",
    found: "discarding.due",
  },
  "discarding.sent": {
    removal: "deleting.sent",
    done: "failed",
    failed: "discarding.held",
    cancelled: "discarding.due",
    gone: "discarding.due",
    found: "discarding.sent",
  },
  "discarding.held": {
    removal: "deleting.due",
    read: "discarding.sent",
    awaited: "discarding.sent",
    found: "discarding.held",
  },
  "deleting.draining": {
    removal: "deleting.draining",
    done: "deleting.due",
    failed: "deleting.due",
    cancelled: "deleting.due",
    gone: "deleting.due",
    found: "deleting.draining",
  },
  "deleting.due": {
    removal: "deleting.due",
    read: "deleting.sent",
    awaited: "deleting.sent",
    found: "deleting.due",
  },
  "deleting.sent": {
    removal: "deleting.sent",
    done: "removed",
    failed: "deleting.held",
    cancelled: "deleting.due",
    gone: "deleting.due",
    found: "deleting.sent",
  },
  "deleting.held": {
    removal: "deleting.due",
    read: "deleting.sent",
    awaited: "deleting.sent",
    found: "deleting.held",
  },
  failed: { removal: "removed", found: "failed" },
};

const phases: Readonly<Record<Leaf, ShownPhase>> = {
  "capturing.due": "capturing",
  "capturing.sent": "capturing",
  "fetching.due": "capturing",
  "fetching.sent": "capturing",
  ready: "ready",
  "publishing.due": "capturing",
  "publishing.sent": "capturing",
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

const storeLease = (mode: string) => ({
  resource: "checkpoint",
  name: buildStoreLease,
  mode,
});

const leasesAt = (state: Leaf, fields?: Partial<CheckpointFacts>) =>
  applied(checkpointChart, rowAt(state, fields), read, undefined).begin?.leases;

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

const rowsFromACapture = (): readonly CheckpointRow[] => {
  const rows = new Map<string, CheckpointRow>();
  const walking = [rowAt("capturing.due")];

  for (const row of walking) {
    const key = `${row.state} ${row.error === undefined}`;

    if (!rows.has(key)) {
      rows.set(key, row);
      walking.push(
        ...representatives.flatMap((event) => {
          const { next } = go(row, event);

          return next === "removed" ? [] : [next];
        })
      );
    }
  }

  return [...rows.values()];
};

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

  it("reaches every leaf, with these events from a capture or a fetch", () => {
    const reached = [
      undefined,
      checkpoint.resolveState({
        value: { fetching: "due" },
        context: checkpointFacts(),
      }),
    ].flatMap((fromState) =>
      adjacencyMapToArray(
        getAdjacencyMap(checkpoint, {
          input: checkpointFacts(),
          events: [...representatives],
          fromState,
        })
      ).map(({ nextState }) => nextState)
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

  it("a leaf is followed exactly when it has a step, and a rest moves to another leaf only by a request, or a ready one to failed by its host saying it holds it no more", () => {
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
          Object.entries(taken).some(
            ([edge, to]) =>
              edge !== "removal" &&
              edge !== "publish" &&
              edge !== "vanished" &&
              to !== state
          )
      )
    ).toStrictEqual([]);
  });

  it("a ready checkpoint its host no longer holds fails with what the host said, and one on another host is kept", () => {
    const ready = rowAt("ready", { handle: Handle.make("ckpt-1") });

    expect(after(ready, vanished)).toMatchObject({
      state: "failed",
      error: { _tag: "Missing", checkpoint: "snap" },
      failedAt: at,
    });
    expect(go(ready, { ...vanished, host: "other" }).next).toBe(ready);
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

  it("the build store's lease is a name no checkpoint can take", () => {
    expect(Schema.is(Name)(buildStoreLease)).toBe(false);
  });

  it("a publish shares the build store, and only a delete of what was published owns it", () => {
    const self = { resource: "checkpoint", name: "snap", mode: "own" };

    expect(leasesAt("publishing.due", { published: "snap" })).toStrictEqual([
      self,
      storeLease("share"),
    ]);
    expect(leasesAt("deleting.due", { published: "snap" })).toStrictEqual([
      self,
      storeLease("own"),
    ]);
    expect(
      leasesAt("deleting.due", { published: "built-other" })
    ).toStrictEqual([self]);
    expect(
      leasesAt("fetching.due", { published: "built-other" })
    ).toStrictEqual([self]);
  });
});

describe("a delete", () => {
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

  it("during a capture keeps the handle the capture reported, so the delete removes what it made", () => {
    const handle = Handle.make("ckpt-made");

    expect(
      applied(
        checkpointChart,
        rowAt("deleting.draining"),
        { ...done, handle },
        inFlight("capture")
      )
    ).toStrictEqual({
      next: rowAt("deleting.due", { handle }),
      finish: true,
    });
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

  it("asked again while a held delete tries once more drops that delete's error, or a wait on it would end there", () => {
    const stale = rowsFromACapture().filter(
      ({ state, error: left }) =>
        state.startsWith("deleting.") &&
        state !== "deleting.held" &&
        left !== undefined
    );

    expect(stale.map(({ state }) => state).toSorted()).toStrictEqual([
      "deleting.due",
      "deleting.sent",
    ]);
    expect(stale.map((row) => after(row, removal))).toStrictEqual(
      stale.map(({ state }) => rowAt(state))
    );
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

describe("a found handle", () => {
  it("fills a row of its instance that has none, in any leaf, and nothing else", () => {
    expect(after(rowAt("ready"), found)).toStrictEqual(
      rowAt("ready", { handle: Handle.make("ckpt-found") })
    );
  });

  it("leaves a row of another instance, or one that has a handle, as it is", () => {
    const held = rowAt("ready", { handle: Handle.make("ckpt-kept") });
    const other = rowAt("ready", { instance: "2" });

    expect([go(held, found).next, go(other, found).next]).toStrictEqual([
      held,
      other,
    ]);
  });
});

describe("a capture", () => {
  it("that ends is ready", () => {
    expect(after(rowAt("capturing.sent"), done)).toStrictEqual(rowAt("ready"));
  });

  it("stores its handle in the write that finishes its operation, so its machine's lease holds until a row has the handle", () => {
    const handle = Handle.make("ckpt-made");

    expect(
      applied(
        checkpointChart,
        rowAt("capturing.sent"),
        { ...done, handle },
        inFlight("capture")
      )
    ).toStrictEqual({ next: rowAt("ready", { handle }), finish: true });
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
