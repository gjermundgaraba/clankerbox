import { readFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { MachineState } from "@clankerbox/host-contract";
import type { Report } from "@clankerbox/host-contract";
import { describe, expect, it } from "@effect/vitest";
import { Desired, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { setup, transition, types } from "xstate";
import type { SnapshotFrom } from "xstate";
import { adjacencyMapToArray, getAdjacencyMap } from "xstate/graph";

import { chartModule } from "../../../.agents/skills/verify-machine-answers/scripts/export-chart.ts";
import { applied, leavesOf } from "../src/chart.ts";
import type { Chart } from "../src/chart.ts";
import {
  activityOf,
  desiredOf,
  leaves,
  machine,
  machineChart,
  metaOf,
  phaseOf,
  stageOf,
  wants,
} from "../src/machine-chart.ts";
import type {
  Leaf,
  MachineEvent,
  MachineRow,
  Wish,
} from "../src/machine-chart.ts";
import type { Facts, MachinePhase, Operation } from "../src/store.ts";
import { facts, failure as error, flight, when as at } from "./chart-rows.ts";

const wishes: readonly Wish[] = ["running", "stopped", "paused"];

const flags: readonly boolean[] = [false, true];

const seens = MachineState.literals;

const earlier = new Internal({ message: "an earlier failure" });

const cut = new Internal({ message: "the make of dev ended on its host" });

const sizes = { cpu: 2, ramMib: 2048, diskGib: 20 };

const rowAt = (state: Leaf, fields?: Partial<Facts>): MachineRow => ({
  ...facts(fields),
  state,
});

const onHost = (state: Leaf, kind?: Operation["kind"]) => {
  const { step } = metaOf(state);

  if (step === undefined) {
    return undefined;
  }

  return flight(step === "any" ? (kind ?? "stop") : step);
};

const go = (row: MachineRow, event: MachineEvent, kind?: Operation["kind"]) =>
  applied(machineChart, row, event, onHost(row.state, kind));

const leafOf = (
  row: MachineRow,
  event: MachineEvent,
  kind?: Operation["kind"]
) => {
  const { next: after } = go(row, event, kind);

  return after === "removed" ? "removed" : after.state;
};

const after = (
  row: MachineRow,
  event: MachineEvent,
  kind?: Operation["kind"]
): MachineRow => {
  const { next: moved } = go(row, event, kind);

  if (moved === "removed") {
    throw new Error("the row went");
  }

  return moved;
};

const read = (
  seen: MachineState,
  joins = false
): Extract<MachineEvent, { type: "read" }> => ({
  type: "read",
  seen,
  boot: "fresh",
  pin: "new pin",
  id: "new",
  joins,
});

const reported = (
  report: Report & { readonly status: "done" | "failed" | "cancelled" }
): MachineEvent =>
  report.status === "done"
    ? { type: "reported", status: "done", outcome: report.outcome, at }
    : {
        type: "reported",
        status: report.status,
        outcome: report.outcome,
        error: report.error ?? error,
      };

const report = (
  status: "done" | "failed" | "cancelled",
  outcome: Report["outcome"] = {},
  why: Internal = error
) =>
  reported({
    id: "op",
    boot: "boot",
    status,
    outcome,
    error: why,
  });

const done = report("done");

const failed = report("failed");

const cancelled = report("cancelled");

const gone: MachineEvent = { type: "lost", error };

const ask = (desired: Wish): MachineEvent => ({ type: "ask", desired });

const removal: MachineEvent = { type: "delete" };

const resizing: MachineEvent = { type: "resize", sizing: { cpu: 3 } };

type Top = "making" | "made" | "undoing" | "undone";

interface Input {
  readonly stage: Top;
  readonly desired: Desired;
  readonly prepared: boolean;
  readonly resizing: boolean;
  readonly seen: MachineState;
}

const inputs: readonly Input[] = (
  ["making", "made", "undoing", "undone"] as const
).flatMap((stage) =>
  Desired.literals.flatMap((desired) =>
    flags.flatMap((prepared) =>
      flags.flatMap((owing) =>
        seens.map((seen) => ({
          stage,
          desired,
          prepared,
          resizing: owing,
          seen,
        }))
      )
    )
  )
);

const inputLeaves = ({ stage, desired }: Input): readonly Leaf[] => {
  if (stage === "undone") {
    return ["undone"];
  }

  if (desired === "deleted") {
    return ["deleting.due", "deleting.held"];
  }

  switch (stage) {
    case "making": {
      return ["making.due"];
    }

    case "undoing": {
      return ["undoing.due", "undoing.held"];
    }

    case "made": {
      return ["made.observing", "made.settled", "made.lost"];
    }
  }
};

const inputRow = (input: Input, state: Leaf) =>
  rowAt(state, {
    desired: input.desired === "deleted" ? "running" : input.desired,
    prepared: input.prepared,
    resize: input.resizing ? { cpu: 2 } : undefined,
  });

const decide = (input: Input): Leaf | "removed" =>
  leafOf(inputRow(input, inputLeaves(input)[0] ?? "undone"), read(input.seen));

const madeInputs = inputs.filter(({ stage }) => stage === "made");

const askedOf = ({ desired }: Input) => desired !== "deleted";

const readable = ({ seen }: Input) => seen !== "unknown" && seen !== "missing";

type Readable = Exclude<MachineState, "unknown" | "missing">;

const stepped = {
  start: "made.stepping.starting",
  stop: "made.stepping.stopping",
  pause: "made.stepping.pausing",
} as const;

const settles = "made.settled";

const resting = [settles, settles] as const;

const decisions: Readonly<
  Record<Wish, Readonly<Record<Readable, readonly [Leaf, Leaf]>>>
> = {
  running: {
    running: [stepped.start, settles],
    stopped: [stepped.start, stepped.start],
    paused: [stepped.start, stepped.start],
  },
  stopped: {
    running: [stepped.stop, stepped.stop],
    stopped: resting,
    paused: [stepped.stop, stepped.stop],
  },
  paused: {
    running: [stepped.pause, stepped.pause],
    stopped: resting,
    paused: resting,
  },
};

const sentFrom: Partial<Record<Leaf, Leaf>> = {
  "making.due": "making.sent",
  "undoing.due": "undoing.sent",
  "undoing.held": "undoing.sent",
  "deleting.due": "deleting.sent",
  "deleting.held": "deleting.sent",
};

const decidedBy = (from: Leaf, input: Input, joins: boolean): Leaf => {
  const { seen, prepared, resizing: owing } = input;
  const sent = sentFrom[from];

  if (sent !== undefined) {
    return sent;
  }

  if (from === "undone" || seen === "unknown") {
    return from;
  }

  if (seen === "missing") {
    return "made.lost";
  }

  if (owing) {
    return "made.stepping.resizing";
  }

  const wish = input.desired === "deleted" ? "running" : input.desired;
  const leaf = decisions[wish][seen][prepared ? 1 : 0];

  return joins && leaf === settles && seen === "running"
    ? "made.stepping.joining.sent"
    : leaf;
};

const vmAfter: Partial<Record<Leaf, MachineState>> = {
  "making.sent": "running",
  "made.stepping.starting": "running",
  "made.stepping.stopping": "stopped",
  "made.stepping.pausing": "paused",
};

const restsWithin = (input: Input, steps: number) => {
  let row = inputRow(input, inputLeaves(input)[0] ?? "undone");
  let { seen } = input;

  for (let taken = 0; taken <= steps; taken += 1) {
    const moved = after(row, read(seen));

    if (metaOf(moved.state).step === undefined) {
      return true;
    }

    seen = vmAfter[moved.state] ?? seen;
    row = after(moved, done);
  }

  return false;
};

describe("a read", () => {
  it("covers every stage, wish, flag and reading there is", () => {
    expect(inputs).toHaveLength(4 * 4 * 2 * 2 * 5);
  });

  it("decides as its table says, from every leaf a read is sent to, joining only where it would settle", () => {
    const table = inputs.flatMap((input) =>
      inputLeaves(input).flatMap((from) =>
        flags.map((joins) => ({
          from,
          input,
          joins,
          chart: leafOf(inputRow(input, from), read(input.seen, joins)),
          decided: decidedBy(from, input, joins),
        }))
      )
    );

    expect(table).toHaveLength(1120);
    expect(
      table.filter(({ chart, decided }) => chart !== decided)
    ).toStrictEqual([]);
  });

  it("a machine asked to be deleted is deleted, whatever else holds", () => {
    expect(
      inputs.filter(
        (input) =>
          input.desired === "deleted" &&
          input.stage !== "undone" &&
          decide(input) !== "deleting.sent"
      )
    ).toStrictEqual([]);
  });

  it("a failed make being undone is deleted, whatever was asked since", () => {
    expect(
      inputs.filter(
        (input) =>
          input.stage === "undoing" &&
          askedOf(input) &&
          decide(input) !== "undoing.sent"
      )
    ).toStrictEqual([]);
  });

  it("a failed create once undone rests failed, whatever else holds, until a delete", () => {
    expect(
      inputs.filter(
        (input) => input.stage === "undone" && decide(input) !== "undone"
      )
    ).toStrictEqual([]);
  });

  it("a machine not made is made, whatever the runtime reads: only a delete stops its making", () => {
    expect(
      inputs.filter(
        (input) =>
          input.stage === "making" &&
          askedOf(input) &&
          decide(input) !== "making.sent"
      )
    ).toStrictEqual([]);
  });

  it("a made machine asked to stop is never made or started", () => {
    expect(
      madeInputs.filter(
        (input) =>
          input.desired === "stopped" &&
          ["making.sent", "made.stepping.starting"].includes(decide(input))
      )
    ).toStrictEqual([]);
  });

  it("a made machine asked to pause is paused only from running, and never made, started or stopped", () => {
    expect(
      madeInputs.filter(
        (input) =>
          input.desired === "paused" &&
          !input.resizing &&
          ([
            "making.sent",
            "made.stepping.starting",
            "made.stepping.stopping",
          ].includes(decide(input)) ||
            (decide(input) === "made.stepping.pausing") !==
              (input.seen === "running"))
      )
    ).toStrictEqual([]);
  });

  it("a paused machine asked to run or stop is started or stopped, never left at rest", () => {
    expect(
      madeInputs.filter(
        (input) =>
          input.seen === "paused" &&
          !input.resizing &&
          ((input.desired === "running" &&
            decide(input) !== "made.stepping.starting") ||
            (input.desired === "stopped" &&
              decide(input) !== "made.stepping.stopping"))
      )
    ).toStrictEqual([]);
  });

  it("a running machine settles only once it is made, runs and is prepared, with no resize left", () => {
    expect(
      inputs.filter(
        (input) =>
          input.desired === "running" &&
          decide(input) === "made.settled" &&
          !(
            input.stage === "made" &&
            input.seen === "running" &&
            input.prepared &&
            !input.resizing
          )
      )
    ).toStrictEqual([]);
  });

  it("a resize asked of a made machine the runtime reads comes before all but a delete", () => {
    expect(
      madeInputs.filter(
        (input) =>
          input.resizing &&
          askedOf(input) &&
          readable(input) &&
          decide(input) !== "made.stepping.resizing"
      )
    ).toStrictEqual([]);
  });

  it("a resize waits for a machine the runtime can't read, and for one it no longer has", () => {
    const unread = madeInputs.filter(
      (input) => input.resizing && askedOf(input) && !readable(input)
    );

    expect(unread.map((input) => [input.seen, decide(input)])).toStrictEqual(
      unread.map(({ seen }) => [
        seen,
        seen === "unknown" ? "made.observing" : "made.lost",
      ])
    );
  });

  it("no step but a make or a delete runs on a machine that isn't made", () => {
    expect(
      inputs.filter(
        (input) =>
          input.stage !== "made" && decide(input).startsWith("made.stepping.")
      )
    ).toStrictEqual([]);
  });

  it("against a runtime whose every step succeeds, a machine not deleted rests within a make, a resize and a start", () => {
    expect(
      inputs.filter(
        (input) =>
          input.stage !== "undoing" && askedOf(input) && !restsWithin(input, 3)
      )
    ).toStrictEqual([]);
  });

  it("a made machine the runtime no longer has is lost, and one it can't read is left as it is", () => {
    const row = rowAt("made.settled", { prepared: true });

    expect([
      leafOf(row, read("missing")),
      go(row, read("unknown")),
    ]).toStrictEqual(["made.lost", { next: row, finish: false }]);
  });

  it("a failed machine takes no read: it rests until the next request", () => {
    const row = rowAt("made.failed", { error });

    expect(go(row, read("stopped"))).toStrictEqual({
      next: row,
      finish: false,
    });
  });
});

const kindWishes: ReadonlyArray<
  readonly [Operation["kind"], readonly Desired[]]
> = [
  ["make", ["running", "stopped", "paused"]],
  ["start", ["running"]],
  ["join", ["running"]],
  ["stop", ["stopped"]],
  ["pause", ["paused"]],
  ["remove", Desired.literals],
  ["resize", Desired.literals],
  ["capture", Desired.literals],
  ["deleteCheckpoint", Desired.literals],
];

describe("wants", () => {
  it.each(kindWishes)("a %s is wanted by just these wishes", (kind, wanted) => {
    expect(
      Desired.literals.filter((desired) => wants(kind, desired))
    ).toStrictEqual([...wanted]);
  });

  it("the wire's desired is deleted exactly under deleting, whatever wish the row keeps", () => {
    expect(
      leaves.filter(
        (state) =>
          (desiredOf(rowAt(state)) === "deleted") !==
          state.startsWith("deleting.")
      )
    ).toStrictEqual([]);
  });
});

describe("a report", () => {
  it("a make cut short by a delete leaves the delete to run", () => {
    expect(after(rowAt("deleting.draining"), cancelled, "make")).toMatchObject({
      state: "deleting.due",
      error: undefined,
    });
  });

  it("a step that fails still wanted rests failed, however often it was asked since it began", () => {
    const asked = after(
      after(
        rowAt("made.stepping.stopping", { desired: "stopped" }),
        ask("running")
      ),
      ask("stopped")
    );

    expect(after(asked, failed)).toMatchObject({
      state: "made.failed",
      error,
    });
  });

  it("a step that fails no longer wanted is decided afresh, and its failure answers nobody", () => {
    expect(
      after(rowAt("made.stepping.stopping", { desired: "running" }), failed)
    ).toMatchObject({ state: "made.observing", error: undefined });
  });

  it("a step that fails with a resize owed is decided afresh, so the resize runs", () => {
    expect(
      after(
        rowAt("made.stepping.stopping", {
          desired: "stopped",
          resize: { cpu: 2 },
        }),
        failed
      )
    ).toMatchObject({ state: "made.observing", error: undefined });
  });

  it("a delete that fails rests failed though a resize is owed, as a delete comes first", () => {
    expect(
      after(rowAt("deleting.sent", { resize: { cpu: 2 } }), failed)
    ).toMatchObject({ state: "deleting.held", error });
  });

  it("no resize's report writes the resize owed, which a later request may have set", () => {
    const owed = rowAt("made.stepping.resizing", { resize: { cpu: 3 } });

    expect([
      after(owed, report("done", { sizes })),
      after(owed, report("failed", { sizes })),
      after(owed, gone),
    ]).toMatchObject([
      { state: "made.observing", resize: { cpu: 3 }, ...sizes },
      { state: "made.failed", resize: { cpu: 3 }, error, ...sizes },
      { state: "made.observing", resize: { cpu: 3 }, cpu: 1 },
    ]);
  });

  it("a make's port stays on every report, so another VM can't take it", () => {
    const told = { port: 2222 };

    expect(
      (["done", "failed", "cancelled"] as const).flatMap((status) =>
        (["making.sent", "deleting.draining"] as const).map(
          (state) => after(rowAt(state), report(status, told), "make").port
        )
      )
    ).toStrictEqual([2222, 2222, 2222, 2222, 2222, 2222]);
  });

  it("a port a running make told stays when a delete drains it", () => {
    const told = after(rowAt("making.sent"), { type: "ran", port: 2222 });
    const deleted = after(told, removal);

    expect([
      deleted.state,
      after(deleted, { type: "ran", port: 3333 }, "make").port,
      after(deleted, cancelled, "make").port,
      after(deleted, gone, "make").port,
    ]).toStrictEqual(["deleting.draining", 3333, 2222, 2222]);
  });
});

describe("what a write begins and finishes", () => {
  it("a read that enters a leaf with a step begins its operation", () => {
    const {
      next: row,
      begin,
      finish,
    } = go(rowAt("made.observing", { prepared: true }), read("running"));

    expect([finish, begin]).toStrictEqual([false, undefined]);
    expect(row).toMatchObject({ state: "made.settled" });

    expect(go(rowAt("made.observing"), read("stopped")).begin).toStrictEqual({
      id: "new",
      kind: "start",
      resource: "machine",
      name: "dev",
      host: "linux",
      boot: "fresh",
      leases: [{ resource: "machine", name: "dev", mode: "own" }],
      to: undefined,
    });
  });

  it("a resize moves what's owed to its operation, so a later one is owed anew", () => {
    const row = rowAt("made.observing", { resize: { cpu: 2 } });
    const { next: moved, begin } = go(row, read("running"));

    expect(begin?.to).toStrictEqual({ cpu: 2 });
    expect(moved).toMatchObject({ resize: undefined });
    expect(after(after(row, read("running")), resizing)).toMatchObject({
      state: "made.stepping.resizing",
      resize: { cpu: 3 },
    });
  });

  it("only a start from stopped takes the host's pin", () => {
    expect([
      after(rowAt("made.observing"), read("stopped")).pin,
      after(rowAt("made.observing"), read("paused")).pin,
      after(rowAt("made.observing", { desired: "stopped" }), read("running"))
        .pin,
    ]).toStrictEqual(["new pin", "pin", "pin"]);
  });

  it("a make takes the pin of the host it is sent to, which its VM boots under", () => {
    expect(after(rowAt("making.due"), read("unknown")).pin).toBe("new pin");
  });

  it("a make of a copy shares what it copies, and a join shares the machine", () => {
    expect(
      go(
        rowAt("making.due", { source: { kind: "checkpoint", name: "snap" } }),
        read("unknown")
      ).begin?.leases
    ).toStrictEqual([
      { resource: "machine", name: "dev", mode: "own" },
      { resource: "checkpoint", name: "snap", mode: "share" },
    ]);

    expect(
      go(rowAt("made.observing", { prepared: true }), read("running", true))
        .begin?.leases
    ).toStrictEqual([{ resource: "machine", name: "dev", mode: "share" }]);
  });

  it("a report finishes the operation, and a delete during a step keeps it in flight", () => {
    expect([
      go(rowAt("made.stepping.stopping"), done).finish,
      go(rowAt("made.stepping.stopping"), removal),
      go(rowAt("undoing.sent"), removal).finish,
      go(rowAt("deleting.draining"), done).finish,
      go(rowAt("deleting.sent"), done),
    ]).toMatchObject([
      true,
      { next: { state: "deleting.draining" }, finish: false },
      false,
      true,
      { next: "removed", finish: true },
    ]);

    expect(go(rowAt("made.stepping.stopping"), removal).begin).toBeUndefined();
    expect(go(rowAt("undoing.sent"), removal).begin).toBeUndefined();
  });

  it("a delete of a failed create takes its row with it, and its error goes in any other delete", () => {
    expect(go(rowAt("undone", { error }), removal)).toStrictEqual({
      next: "removed",
      finish: false,
    });

    expect(
      leaves
        .filter((state) => state !== "undone")
        .filter(
          (state) => after(rowAt(state, { error }), removal).error !== undefined
        )
    ).toStrictEqual([]);
  });

  it("a leaf is followed exactly when it has a step, and only a read leaves observing", () => {
    expect(
      leaves.filter(
        (state) =>
          (metaOf(state).step === undefined) ===
            (activityOf(state) === "follow") ||
          (phaseOf(state) === "observing" && activityOf(state) === "none")
      )
    ).toStrictEqual([]);
  });

  it("a leaf's path is a type, not any string", () => {
    // @ts-expect-error a row can't name a leaf the chart hasn't
    const nowhere: Leaf = "made.nowhere";

    expect(leaves).not.toContain(nowhere);
  });
});

const rests: ReadonlySet<MachinePhase> = new Set<MachinePhase>([
  "settled",
  "failed",
  "lost",
]);

describe("a request", () => {
  it("takes the row out of rest in the write that records it, or is refused and writes nothing", () => {
    const atRest = leaves.filter((state) => rests.has(phaseOf(state)));

    const stays = atRest.flatMap((state) =>
      [...wishes.map(ask), resizing, removal].flatMap((event) => {
        const row = rowAt(state);
        const { next: moved } = go(row, event);

        if (moved === "removed" || moved === row) {
          return moved === row ? [[state, event.type]] : [];
        }

        return rests.has(phaseOf(moved.state)) ? [["rests", state]] : [];
      })
    );

    expect(atRest).toStrictEqual([
      "made.settled",
      "made.lost",
      "made.failed",
      "made.stepping.joining.sent",
      "undoing.held",
      "undone",
      "deleting.held",
    ]);

    expect(new Set(stays.map(String))).toStrictEqual(
      new Set([
        "undoing.held,ask",
        "undoing.held,resize",
        "undone,ask",
        "undone,resize",
        "deleting.held,ask",
        "deleting.held,resize",
      ])
    );
  });

  it("a resize has no edge before a machine is made, which is what answers NotMade", () => {
    expect(
      (["making.due", "making.sent"] as const).map((state) => {
        const row = rowAt(state);

        return go(row, resizing).next === row;
      })
    ).toStrictEqual([true, true]);
  });
});

const phases: Readonly<Record<Leaf, MachinePhase>> = {
  "making.due": "observing",
  "making.sent": "creating",
  "made.observing": "observing",
  "made.settled": "settled",
  "made.lost": "lost",
  "made.failed": "failed",
  "made.stepping.starting": "starting",
  "made.stepping.stopping": "stopping",
  "made.stepping.pausing": "pausing",
  "made.stepping.resizing": "resizing",
  "made.stepping.joining.sent": "settled",
  "made.stepping.joining.asked": "observing",
  "undoing.due": "observing",
  "undoing.sent": "deleting",
  "undoing.held": "failed",
  undone: "failed",
  "deleting.draining": "deleting",
  "deleting.due": "observing",
  "deleting.sent": "deleting",
  "deleting.held": "failed",
};

const edgesEvents = [
  ["ask", ask("stopped")],
  ["resize", resizing],
  ["delete", removal],
  ["refused", { type: "refused", error }],
  ["ran", { type: "ran", port: 2222 }],
  ["done", done],
  ["failed", failed],
  ["cancelled", cancelled],
  ["lost", gone],
] as const satisfies ReadonlyArray<readonly [string, MachineEvent]>;

type Edge = (typeof edgesEvents)[number][0];

type Edges = Readonly<Partial<Record<Edge, Leaf | "removed">>>;

const madeAtRest = {
  ask: "made.observing",
  resize: "made.observing",
  delete: "deleting.due",
} as const;

const stepTo = (leaf: Leaf) =>
  ({
    ask: leaf,
    resize: leaf,
    delete: "deleting.draining",
    done: "made.observing",
    failed: "made.failed",
    cancelled: "made.observing",
    lost: "made.observing",
  }) as const;

const edges: Readonly<Record<Leaf, Edges>> = {
  "making.due": {
    ask: "making.due",
    delete: "deleting.due",
    refused: "undoing.due",
  },
  "making.sent": {
    ask: "making.sent",
    delete: "deleting.draining",
    ran: "making.sent",
    done: "made.observing",
    failed: "undoing.due",
    cancelled: "undoing.due",
    lost: "undoing.due",
  },
  "made.observing": madeAtRest,
  "made.settled": madeAtRest,
  "made.lost": madeAtRest,
  "made.failed": madeAtRest,
  "made.stepping.starting": stepTo("made.stepping.starting"),
  "made.stepping.stopping": stepTo("made.stepping.stopping"),
  "made.stepping.pausing": stepTo("made.stepping.pausing"),
  "made.stepping.resizing": stepTo("made.stepping.resizing"),
  "made.stepping.joining.sent": {
    ask: "made.stepping.joining.asked",
    resize: "made.stepping.joining.asked",
    delete: "deleting.draining",
    done: "made.settled",
    failed: "made.settled",
    cancelled: "made.settled",
    lost: "made.settled",
  },
  "made.stepping.joining.asked": {
    ask: "made.stepping.joining.asked",
    resize: "made.stepping.joining.asked",
    delete: "deleting.draining",
    done: "made.observing",
    failed: "made.observing",
    cancelled: "made.observing",
    lost: "made.observing",
  },
  "undoing.due": { delete: "deleting.due" },
  "undoing.sent": {
    delete: "deleting.sent",
    done: "undone",
    failed: "undoing.held",
    cancelled: "undoing.due",
    lost: "undoing.due",
  },
  "undoing.held": { delete: "deleting.due" },
  undone: { delete: "removed" },
  "deleting.draining": {
    delete: "deleting.draining",
    ran: "deleting.draining",
    done: "deleting.due",
    failed: "deleting.due",
    cancelled: "deleting.due",
    lost: "deleting.due",
  },
  "deleting.due": { delete: "deleting.due" },
  "deleting.sent": {
    delete: "deleting.sent",
    done: "removed",
    failed: "deleting.held",
    cancelled: "deleting.due",
    lost: "deleting.due",
  },
  "deleting.held": { delete: "deleting.due" },
};

const wished: Partial<Record<Leaf, Wish>> = {
  "made.stepping.stopping": "stopped",
  "made.stepping.pausing": "paused",
};

const kindsOf = (state: Leaf) => {
  const { step } = metaOf(state);

  return step === "any"
    ? (["make", "start", "stop", "pause", "resize", "join"] as const)
    : [step];
};

const fixtures = leaves.flatMap((state) =>
  wishes.flatMap((desired) =>
    flags.flatMap((prepared) =>
      flags.flatMap((erred) =>
        flags.flatMap((owing) =>
          kindsOf(state).map((kind) => ({
            row: rowAt(state, {
              desired,
              prepared,
              error: erred ? earlier : undefined,
              resize: owing ? { cpu: 3 } : undefined,
              port: 2000,
            }),
            op: kind === undefined ? undefined : flight(kind),
          }))
        )
      )
    )
  )
);

type Write = [
  says: string,
  row: MachineRow,
  event: MachineEvent,
  writes: Partial<MachineRow>,
  kind?: Operation["kind"],
];

const prepared = { prepared: true };

const factsWritten: readonly Write[] = [
  [
    "a make done tells its port, and its machine is still to prepare",
    rowAt("making.sent", prepared),
    report("done", { port: 2222 }),
    { state: "made.observing", prepared: false, port: 2222 },
  ],
  [
    "a start done prepares its machine and tells its host key",
    rowAt("made.stepping.starting"),
    report("done", { hostKey: "key" }),
    { state: "made.observing", prepared: true, hostKey: "key" },
  ],
  [
    "a stop done leaves the machine to prepare again",
    rowAt("made.stepping.stopping", { desired: "stopped", ...prepared }),
    done,
    { state: "made.observing", prepared: false },
  ],
  [
    "a pause done leaves the machine to prepare again",
    rowAt("made.stepping.pausing", { desired: "paused", ...prepared }),
    done,
    { state: "made.observing", prepared: false },
  ],
  [
    "a resize done tells its sizes, and leaves the machine prepared",
    rowAt("made.stepping.resizing", prepared),
    report("done", { sizes }),
    { state: "made.observing", ...sizes },
  ],
  [
    "a join's report writes nothing but the rest, whatever it said",
    rowAt("made.stepping.joining.sent", prepared),
    failed,
    { state: "made.settled" },
  ],
  [
    "a make that fails says why, and keeps the port it told",
    rowAt("making.sent"),
    report("failed", { port: 2222 }),
    { state: "undoing.due", error, port: 2222 },
  ],
  [
    "a make cut short says it was",
    rowAt("making.sent"),
    report("cancelled", {}, cut),
    { state: "undoing.due", error: cut },
  ],
  [
    "a make lost says why",
    rowAt("making.sent"),
    gone,
    { state: "undoing.due", error },
  ],
  [
    "a start that fails keeps the host key it told",
    rowAt("made.stepping.starting"),
    report("failed", { hostKey: "key" }),
    { state: "made.failed", error, hostKey: "key" },
  ],
  [
    "a resize cut short keeps the sizes it told",
    rowAt("made.stepping.resizing"),
    report("cancelled", { sizes }),
    { state: "made.observing", ...sizes },
  ],
  [
    "a step lost is decided afresh, and says nothing",
    rowAt("made.stepping.starting"),
    gone,
    { state: "made.observing" },
  ],
  [
    "a remove of a failed create that fails keeps the make's error",
    rowAt("undoing.sent", { error: earlier }),
    failed,
    { state: "undoing.held" },
  ],
  [
    "a delete that fails says why, also of a failed create, whose error the delete cleared",
    rowAt("deleting.sent"),
    failed,
    { state: "deleting.held", error },
  ],
  [
    "a step that fails under a delete goes on to the delete at once, keeping what it read but not its error, which isn't the delete's",
    rowAt("deleting.draining", prepared),
    report("failed", { sizes }),
    { state: "deleting.due", ...sizes },
    "resize",
  ],
  [
    "a step done under a delete goes on to the delete, keeping what it told",
    rowAt("deleting.draining"),
    report("done", { hostKey: "key" }),
    { state: "deleting.due", hostKey: "key" },
    "start",
  ],
  [
    "a make lost under a delete goes on to the delete with no error to show",
    rowAt("deleting.draining"),
    gone,
    { state: "deleting.due" },
    "make",
  ],
  [
    "under a delete a report leaves prepared alone, which nothing reads again",
    rowAt("deleting.draining", prepared),
    done,
    { state: "deleting.due" },
    "stop",
  ],
  [
    "a wish to run leaves the machine to prepare, and clears what failed",
    rowAt("made.failed", { error: earlier, ...prepared }),
    ask("running"),
    { state: "made.observing", prepared: false, error: undefined },
  ],
  [
    "any other wish keeps what is prepared",
    rowAt("made.failed", { error: earlier, ...prepared }),
    ask("stopped"),
    { state: "made.observing", desired: "stopped", error: undefined },
  ],
  [
    "a resize is owed, and clears what failed",
    rowAt("made.failed", { error: earlier, ...prepared }),
    resizing,
    { state: "made.observing", resize: { cpu: 3 }, error: undefined },
  ],
  [
    "a request during a step keeps reading the step",
    rowAt("made.stepping.starting", prepared),
    ask("stopped"),
    { desired: "stopped" },
  ],
  [
    "a delete during a step reads deleting at once",
    rowAt("made.stepping.stopping", { desired: "stopped", error: earlier }),
    removal,
    { state: "deleting.draining", error: undefined },
  ],
  [
    "a make the source's sizes refuse says why",
    rowAt("making.due"),
    { type: "refused", error },
    { state: "undoing.due", error },
  ],
  [
    "a read of a stopped machine that starts it takes the host's pin",
    rowAt("made.observing"),
    read("stopped"),
    { state: "made.stepping.starting", pin: "new pin" },
  ],
];

const representatives: readonly MachineEvent[] = [
  ...wishes.map(ask),
  removal,
  resizing,
  ...seens.flatMap((seen) => flags.map((joins) => read(seen, joins))),
  { type: "refused", error },
  { type: "ran", port: 2222 },
  done,
  failed,
  cancelled,
  gone,
];

const heap = () => {
  runInNewContext("gc()");

  return process.memoryUsage().heapUsed;
};

const writes = (count: number) => {
  const observing = rowAt("made.observing", { desired: "stopped" });
  const stopping = rowAt("made.stepping.stopping", { desired: "stopped" });
  const stop = flight("stop");

  for (let taken = 0; taken < count; taken += 1) {
    if (taken % 2 === 0) {
      applied(machineChart, observing, read("running"), undefined);
    } else {
      applied(machineChart, stopping, done, stop);
    }
  }
};

describe("the chart", () => {
  it("in every walk a transition's only effect is ending an actor no row has, as the row goes, and a leaf that doesn't take an event hands back the snapshot it was given, which is how applied tells", () => {
    const steps = fixtures.flatMap(({ row, op }) =>
      representatives.map((event) => {
        let effects: readonly unknown[] = [];
        let same = false;

        const { next } = applied(
          {
            ...machineChart,
            transition: (before, sent) => {
              const [moved, ...rest] = machineChart.transition(before, sent);

              effects = rest.flat();
              same = moved === before;

              return [moved, ...rest];
            },
          },
          row,
          event,
          op
        );

        return { event: event.type, effects, same, next, row };
      })
    );

    const ending: readonly unknown[] = [
      expect.objectContaining({ type: "@xstate.terminate" }),
    ];

    expect(steps.length).toBeGreaterThan(10_000);
    expect(steps.some(({ next }) => next === "removed")).toBe(true);
    expect(steps.map(({ effects }) => effects)).toStrictEqual(
      steps.map(({ next }) => (next === "removed" ? ending : []))
    );
    expect(steps.filter(({ same }) => same).length).toBeGreaterThan(1000);
    expect(
      steps.filter(({ same, next, row }) => same !== (next === row))
    ).toStrictEqual([]);
  });

  it("takes every event from every leaf where its table says, and writes nothing for one the table doesn't name", () => {
    const table = leaves.flatMap((state) => {
      const row = rowAt(state, { desired: wished[state] ?? "running" });

      return edgesEvents.map(([edge, event]) => {
        const { next } = go(row, event);

        return {
          state,
          edge,
          chart: next === row ? undefined : leafOf(row, event),
          named: edges[state][edge],
        };
      });
    });

    expect(table).toHaveLength(leaves.length * 9);
    expect(table.filter(({ chart, named }) => chart !== named)).toStrictEqual(
      []
    );
  });

  it("takes the sizes a read gives on every leaf, and writes nothing else", () => {
    expect(
      leaves.filter((state) => {
        const row = rowAt(state);

        const { next, begin, finish } = go(row, {
          type: "sized",
          sizing: { cpu: 4 },
        });

        return (
          next === "removed" ||
          next.state !== state ||
          next.cpu !== 4 ||
          next.ramMib !== row.ramMib ||
          next.diskGib !== row.diskGib ||
          begin !== undefined ||
          finish
        );
      })
    ).toStrictEqual([]);
  });

  it.each(factsWritten)("%s", (_, row, event, written, kind) => {
    expect(after(row, event, kind)).toStrictEqual({ ...row, ...written });
  });

  it("past a host's capacity, a create takes the next host, and a remove with none to go to rests undone", () => {
    const row = rowAt("undoing.sent", {
      error: earlier,
      port: 2000,
      prepared: true,
    });

    const move = {
      host: "other",
      kind: "mac",
      pin: "other pin",
      source: { kind: "base", scripted: false },
      prebuild: "built",
    } as const;

    expect(
      after(row, { type: "reported", status: "done", outcome: {}, at, move })
    ).toStrictEqual({
      ...row,
      ...move,
      state: "making.due",
      error: undefined,
      port: undefined,
    });
    expect(after(row, done)).toStrictEqual({
      ...row,
      state: "undone",
      undoneAt: at,
    });
  });

  it("reaches every leaf, with these events from a create", () => {
    const adjacency = getAdjacencyMap(machine, {
      input: facts(),
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

  it("every leaf shows the phase the table names, and its stage is the top of its path", () => {
    expect(
      leaves.filter(
        (state) =>
          phaseOf(state) !== phases[state] ||
          stageOf(state) !== state.split(".")[0]
      )
    ).toStrictEqual([]);
  });

  it("has a leaf for each row the table names, and no other", () => {
    expect([...leaves].toSorted()).toStrictEqual(
      Object.keys(phases).toSorted()
    );
    expect(
      leavesOf(machine).filter((leaf) => !leaves.some((row) => row === leaf))
    ).toStrictEqual(["gone"]);
  });

  it("a transition that throws reaches the caller, so its write rolls back", () => {
    const thrown = setup({
      schemas: {
        context: types<{ readonly name: string; readonly host: string }>(),
        events: { boom: types<object>() },
      },
    }).createMachine({
      context: { name: "dev", host: "linux" },
      id: "thrown",
      initial: "here",
      states: {
        here: {
          on: {
            boom: () => {
              throw error;
            },
          },
        },
      },
    });

    const chart: Chart<
      SnapshotFrom<typeof thrown>,
      "here",
      { readonly type: "boom" }
    > = {
      resource: "machine",
      resolve: (value, context) => thrown.resolveState({ value, context }),
      transition: (snapshot, event) => transition(thrown, snapshot, event),
      leaves: ["here"],
      metaOf: () => ({ phase: "here", activity: "none" }),
      begins: () => {
        throw new Error("no step here");
      },
    };

    expect(() =>
      applied(
        chart,
        { name: "dev", host: "linux", state: "here" },
        { type: "boom" },
        undefined
      )
    ).toThrow(error);
  });

  it("the model's table is the chart's", () => {
    expect(
      readFileSync(
        new URL(
          "../../../.agents/skills/verify-machine-answers/model/Chart.tla",
          import.meta.url
        ),
        "utf8"
      )
    ).toBe(chartModule());
  });

  it(
    "100,000 writes retain nothing: no snapshot outlives its call",
    { timeout: 60_000 },
    () => {
      setFlagsFromString("--expose-gc");
      writes(10_000);

      const before = heap();

      writes(100_000);

      expect((heap() - before) / 100_000).toBeLessThan(100);
    }
  );
});
