import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { MachineState } from "@clankerbox/host-contract";
import type { Report } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Desired, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { DateTime, Effect, Option } from "effect";
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
  wants,
} from "../src/machine-chart.ts";
import type {
  Facts,
  Leaf,
  MachineEvent,
  Row,
  Wish,
} from "../src/machine-chart.ts";
import { open } from "../src/platform/sqlite.ts";
import { lost, next as nextOf, settled } from "../src/reconcile.ts";
import type { Next, Patch } from "../src/reconcile.ts";
import type {
  Interface,
  MachinePhase,
  MachineRow,
  Operation,
  Stage,
} from "../src/store.ts";
import { facts, failure as error, flight, when as at } from "./chart-rows.ts";

const wishes: readonly Wish[] = ["running", "stopped", "paused"];

const flags: readonly boolean[] = [false, true];

const seens = MachineState.literals;

const earlier = new Internal({ message: "an earlier failure" });

const cut = new Internal({ message: "the make of dev ended on its host" });

const sizes = { cpu: 2, ramMib: 2048, diskGib: 20 };

const rowAt = (state: Leaf, fields?: Partial<Facts>): Row => ({
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

const go = (row: Row, event: MachineEvent, kind?: Operation["kind"]) =>
  applied(machineChart, row, event, onHost(row.state, kind));

const leafOf = (row: Row, event: MachineEvent, kind?: Operation["kind"]) => {
  const { next: after } = go(row, event, kind);

  return after === "removed" ? "removed" : after.state;
};

const after = (
  row: Row,
  event: MachineEvent,
  kind?: Operation["kind"]
): Row => {
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

interface Input {
  readonly stage: Stage;
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

const answered = (from: Leaf, want: Next): Leaf => {
  switch (want) {
    case "deleting": {
      if (from === "undone") {
        return from;
      }

      return from.startsWith("undoing.") ? "undoing.sent" : "deleting.sent";
    }

    case "failed": {
      return "undone";
    }

    case "settled": {
      return "made.settled";
    }

    case "lost": {
      return "made.lost";
    }

    case "unread": {
      return from;
    }

    case "creating": {
      return "making.sent";
    }

    case "starting": {
      return "made.stepping.starting";
    }

    case "stopping": {
      return "made.stepping.stopping";
    }

    case "pausing": {
      return "made.stepping.pausing";
    }

    case "resizing": {
      return "made.stepping.resizing";
    }
  }
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

  it("decides as next does, from every leaf a read is sent to, joining only where it would settle", () => {
    const table = inputs.flatMap((input) =>
      inputLeaves(input).flatMap((from) =>
        flags.map((joins) => {
          const row = inputRow(input, from);

          const seen =
            input.stage === "made" && input.desired !== "deleted"
              ? input.seen
              : "unknown";

          const decided = answered(
            from,
            nextOf(
              { ...input, desired: desiredOf(row), stage: input.stage },
              seen
            )
          );

          return {
            from,
            input,
            joins,
            chart: leafOf(row, read(seen, joins)),
            today:
              joins && decided === "made.settled" && seen === "running"
                ? "made.stepping.joining.sent"
                : decided,
          };
        })
      )
    );

    expect(table).toHaveLength(1120);
    expect(table.filter(({ chart, today }) => chart !== today)).toStrictEqual(
      []
    );
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
  it("a make cut short though no delete asked is undone, saying why, not run again", () => {
    expect(after(rowAt("making.sent"), cancelled)).toMatchObject({
      state: "undoing.due",
      error: { _tag: "Internal" },
    });
  });

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

  it("a delete keeps all a step's report tells, and its failure", () => {
    expect([
      after(
        rowAt("deleting.draining"),
        report("done", { hostKey: "key" }),
        "start"
      ).hostKey,
      after(rowAt("deleting.draining"), report("failed", { sizes }), "resize"),
    ]).toMatchObject(["key", { state: "deleting.due", error, ...sizes }]);
  });

  it("the last remove of a failed create rests undone with when, or moves it past a host's capacity", () => {
    const row = rowAt("undoing.sent", {
      error: new Internal({ message: "full" }),
      port: 2222,
    });

    const move = {
      host: "other",
      kind: "mac",
      pin: "other pin",
      source: { kind: "base", scripted: true },
      prebuild: undefined,
    } as const;

    expect([
      after(row, done),
      after(row, { type: "reported", status: "done", outcome: {}, at, move }),
    ]).toMatchObject([
      { state: "undone", undoneAt: at, error: { message: "full" } },
      {
        state: "making.due",
        host: "other",
        kind: "mac",
        pin: "other pin",
        error: undefined,
        port: undefined,
        undoneAt: undefined,
      },
    ]);
  });

  it("a resize read back after it was lost keeps the sizes the read gave, also under a delete", () => {
    const sizing = { type: "sized", sizing: { cpu: 4 } } as const;

    expect([
      after(rowAt("made.observing"), sizing),
      after(rowAt("deleting.due"), sizing),
    ]).toMatchObject([
      { cpu: 4, ramMib: 1024 },
      { cpu: 4, ramMib: 1024 },
    ]);
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
      seen: "stopped",
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

  it("a request that goes stop, run, stop during a failing stop still gets its failure", () => {
    const row = after(
      after(
        rowAt("made.stepping.stopping", { desired: "stopped" }),
        ask("running")
      ),
      ask("stopped")
    );

    expect(after(row, failed)).toMatchObject({ state: "made.failed", error });
  });
});

const projection: Readonly<
  Record<Leaf, readonly [Stage | undefined, MachinePhase]>
> = {
  "making.due": ["making", "observing"],
  "making.sent": ["making", "creating"],
  "made.observing": ["made", "observing"],
  "made.settled": ["made", "settled"],
  "made.lost": ["made", "lost"],
  "made.failed": ["made", "failed"],
  "made.stepping.starting": ["made", "starting"],
  "made.stepping.stopping": ["made", "stopping"],
  "made.stepping.pausing": ["made", "pausing"],
  "made.stepping.resizing": ["made", "resizing"],
  "made.stepping.joining.sent": ["made", "settled"],
  "made.stepping.joining.asked": ["made", "observing"],
  "undoing.due": ["undoing", "observing"],
  "undoing.sent": ["undoing", "deleting"],
  "undoing.held": ["undoing", "failed"],
  undone: ["undone", "failed"],
  "deleting.draining": [undefined, "deleting"],
  "deleting.due": [undefined, "observing"],
  "deleting.sent": [undefined, "deleting"],
  "deleting.held": [undefined, "failed"],
};

const phaseOfKind: Partial<Record<Operation["kind"], MachinePhase>> = {
  make: "creating",
  start: "starting",
  stop: "stopping",
  pause: "pausing",
  resize: "resizing",
  remove: "deleting",
};

const kindOfNext: Partial<Record<Next, Operation["kind"]>> = {
  creating: "make",
  starting: "start",
  stopping: "stop",
  pausing: "pause",
  resizing: "resize",
  deleting: "remove",
};

interface Fixture {
  readonly state: Leaf;
  readonly stage: Stage;
  readonly op: Operation | undefined;
  readonly row: Row;
  readonly today: MachineRow;
}

interface Walked extends Fixture {
  readonly name: string;
  readonly event: MachineEvent;
  readonly was: MachineRow | "removed";
  readonly begins?: Pick<Operation, "kind" | "seen" | "to"> | undefined;
  readonly finishes: boolean;
}

const stagesOf = (state: Leaf, kind: Operation["kind"] | undefined) => {
  const [stage] = projection[state];

  if (stage !== undefined) {
    return [stage];
  }

  if (state === "deleting.draining") {
    return [kind === "make" ? ("making" as const) : ("made" as const)];
  }

  return ["making", "made", "undoing"] as const;
};

const kindsOf = (state: Leaf) => {
  const { step } = metaOf(state);

  return step === "any"
    ? (["make", "start", "stop", "pause", "resize", "join"] as const)
    : [step];
};

const fixtures: readonly Fixture[] = leaves.flatMap((state) =>
  (state.startsWith("deleting.") ? (["running"] as const) : wishes).flatMap(
    (desired) =>
      flags.flatMap((prepared) =>
        flags.flatMap((erred) =>
          flags.flatMap((owing) =>
            kindsOf(state).flatMap((kind) =>
              stagesOf(state, kind).map((stage) => {
                const row = rowAt(state, {
                  desired,
                  prepared,
                  error: erred ? earlier : undefined,
                  resize: owing ? { cpu: 3 } : undefined,
                  port: stage === "making" ? undefined : 2000,
                });

                return {
                  state,
                  stage,
                  op: kind === undefined ? undefined : flight(kind),
                  row,
                  today: {
                    ...row,
                    stage,
                    desired: desiredOf(row),
                    generation: 1,
                    phase:
                      state === "deleting.draining"
                        ? (phaseOfKind[kind ?? "join"] ?? "observing")
                        : projection[state][1],
                  },
                };
              })
            )
          )
        )
      )
  )
);

const outcomes: Partial<Record<Operation["kind"], Report["outcome"]>> = {
  make: { port: 2222 },
  start: { hostKey: "key" },
  resize: { sizes },
};

const ended = (
  { today: row, op }: Fixture,
  patch: Patch | "removed"
): MachineRow | "removed" => {
  if (patch === "removed") {
    return patch;
  }

  if (op?.kind === "join") {
    return row;
  }

  return patch.stage === "undone"
    ? { ...row, ...patch, undoneAt: at }
    : { ...row, ...patch };
};

const reportWalks = (fixture: Fixture): readonly Walked[] => {
  const { op, today: row } = fixture;

  if (op === undefined) {
    return [];
  }

  const outcome = outcomes[op.kind] ?? {};

  const reports = (["done", "failed", "cancelled"] as const).map((status) => {
    const sent: Report = {
      id: "op",
      boot: "boot",
      status,
      outcome,
      ...(status === "failed" ? { error } : {}),
    };

    return {
      ...fixture,
      name: `reported ${status}`,
      event: report(status, outcome, status === "failed" ? error : cut),
      was: ended(fixture, settled(row, op, sent)),
      finishes: true,
    };
  });

  return [
    ...reports,
    {
      ...fixture,
      name: "lost",
      event: gone,
      was: ended(fixture, lost(op, error)),
      finishes: true,
    },
    ...(op.kind === "make"
      ? [
          {
            ...fixture,
            name: "ran",
            event: { type: "ran", port: 2222 } as const,
            was: { ...row, port: 2222 },
            finishes: false,
          },
        ]
      : []),
  ];
};

const lookWalks = (fixture: Fixture): readonly Walked[] => {
  const { op, today: row } = fixture;

  if (op !== undefined) {
    return [];
  }

  return seens.flatMap((seen) =>
    flags.map((joins): Walked => {
      const looked =
        row.stage === "made" && row.desired !== "deleted" ? seen : "unknown";

      const resting =
        row.stage === "undone" ||
        (row.phase === "failed" &&
          row.stage === "made" &&
          row.desired !== "deleted");

      const target = resting
        ? "unread"
        : nextOf({ ...row, resizing: row.resize !== undefined }, looked);

      const kind = kindOfNext[target];

      const common = {
        ...fixture,
        name: `read ${seen} joining ${joins}`,
        event: read(looked, joins),
        finishes: false,
      };

      if (kind !== undefined) {
        return {
          ...common,
          begins: {
            kind,
            seen: looked,
            to: kind === "resize" ? row.resize : undefined,
          },
          was: {
            ...row,
            phase: phaseOfKind[kind] ?? row.phase,
            ...(kind === "resize" ? { resize: undefined } : {}),
            ...(kind === "start" && looked === "stopped"
              ? { pin: "new pin" }
              : {}),
          },
        };
      }

      return {
        ...common,
        ...(target === "settled" && joins && looked === "running"
          ? { begins: { kind: "join", seen: looked, to: undefined } }
          : {}),
        was:
          target === "settled" || target === "lost"
            ? { ...row, phase: target }
            : row,
      };
    })
  );
};

const quietWalks = (fixture: Fixture): readonly Walked[] => {
  const { state, today: row } = fixture;

  return [
    {
      ...fixture,
      name: "refused",
      event: { type: "refused", error },
      was:
        state === "making.due"
          ? { ...row, stage: "undoing", error, phase: "observing" }
          : row,
      finishes: false,
    },
    {
      ...fixture,
      name: "sized",
      event: { type: "sized", sizing: { cpu: 4 } },
      was: { ...row, cpu: 4 },
      finishes: false,
    },
    ...(state === "undoing.sent"
      ? [
          {
            ...fixture,
            name: "reported done past a host's capacity",
            event: {
              type: "reported",
              status: "done",
              outcome: {},
              at,
              move: {
                host: "other",
                kind: "mac",
                pin: "other pin",
                source: { kind: "base", scripted: false },
                prebuild: "built",
              },
            } as const,
            was: {
              ...row,
              stage: "making",
              phase: "observing",
              host: "other",
              kind: "mac",
              pin: "other pin",
              source: { kind: "base", scripted: false },
              prebuild: "built",
              error: undefined,
              port: undefined,
            } as const,
            finishes: true,
          },
        ]
      : []),
  ];
};

const notOnHost = (fixture: Fixture): readonly Walked[] => {
  const { op, today: row } = fixture;

  const ignored = (name: string, event: MachineEvent): Walked => ({
    ...fixture,
    name,
    event,
    was: row,
    finishes: false,
  });

  return [
    ...(op === undefined
      ? [
          ignored("reported done of nothing", done),
          ignored("reported failed of nothing", failed),
          ignored("reported cancelled of nothing", cancelled),
          ignored("lost of nothing", gone),
        ]
      : seens.map((seen) =>
          ignored(`read ${seen} with a step in flight`, read(seen))
        )),
    ...(metaOf(fixture.state).step === "any" || op?.kind === "make"
      ? []
      : [ignored("ran of no make", { type: "ran", port: 2222 })]),
  ];
};

const requestWalks = (store: Interface, fixture: Fixture, tag: number) =>
  Effect.gen(function* () {
    const { today: row } = fixture;

    const written = (
      name: string,
      write: (
        stored: string
      ) => Effect.Effect<Option.Option<MachineRow>, Internal>
    ) =>
      Effect.gen(function* () {
        const unique = `${name}-${tag}`;

        yield* store.insertMachine({ ...row, name: unique, host: unique });

        return {
          ...Option.getOrThrow(yield* write(unique)),
          host: row.host,
        };
      });

    const notFailedCreate = row.stage === "making" || row.stage === "made";

    const asks = yield* Effect.forEach(wishes, (desired) =>
      Effect.map(
        notFailedCreate
          ? written(`ask-${desired}`, (name) => store.desire(name, desired))
          : Effect.succeed(row),
        (was): Walked => ({
          ...fixture,
          name: `ask ${desired}`,
          event: ask(desired),
          was,
          finishes: false,
        })
      )
    );

    const deletion: Walked = {
      ...fixture,
      name: "delete",
      event: removal,
      was:
        row.stage === "undone"
          ? "removed"
          : yield* written("delete", (name) => store.desire(name, "deleted")),
      finishes: false,
    };

    const sizing: Walked = {
      ...fixture,
      name: "resize",
      event: resizing,
      was:
        row.stage === "made"
          ? yield* written("resize", (name) => store.resize(name, { cpu: 3 }))
          : row,
      finishes: false,
    };

    return [...asks, deletion, sizing];
  });

const visible = (row: MachineRow | "removed") =>
  row === "removed"
    ? row
    : {
        ...row,
        name: "dev",
        createdAt: DateTime.makeUnsafe(0),
        generation: 1,
        state: undefined,
        stage: row.desired === "deleted" ? undefined : row.stage,
      };

const shownByChart = ({ row, event, op, stage }: Walked) => {
  const { next, begin, finish } = applied(machineChart, row, event, op);

  return {
    row: visible(
      next === "removed"
        ? next
        : {
            ...next,
            desired: desiredOf(next),
            stage: projection[next.state][0] ?? stage,
            phase: projection[next.state][1],
            generation: 1,
          }
    ),
    begins:
      begin === undefined
        ? undefined
        : { kind: begin.kind, seen: begin.seen, to: begin.to },
    finish,
  };
};

const asksOrResizes = ({ type }: MachineEvent) =>
  type === "ask" || type === "resize";

const isRequest = (event: MachineEvent) =>
  asksOrResizes(event) || event.type === "delete";

interface Difference {
  readonly says: string;
  readonly of: (walked: Walked) => boolean;
  readonly shows: (walked: Walked, row: MachineRow) => MachineRow;
}

const differences: readonly Difference[] = [
  {
    says: "a request after a delete writes nothing: no error goes, no resize is owed, and a held delete waits for its recheck",
    of: ({ state, event }) =>
      state.startsWith("deleting.") && asksOrResizes(event),
    shows: ({ today }) => today,
  },
  {
    says: "a request during a step keeps reading the step, which read observing until the loop's next turn",
    of: ({ op, event }) => op !== undefined && isRequest(event),
    shows: ({ op }, row) => ({
      ...row,
      phase:
        row.phase === "observing"
          ? (phaseOfKind[op?.kind ?? "join"] ?? "observing")
          : row.phase,
    }),
  },
  {
    says: "a delete during a step reads deleting at once, not the step's phase",
    of: ({ state, op, event }) =>
      (state === "deleting.draining" || event.type === "delete") &&
      op !== undefined &&
      op.kind !== "remove" &&
      event.type !== "reported" &&
      event.type !== "lost",
    shows: (_, row) => ({ ...row, phase: "deleting" }),
  },
  {
    says: "a report's facts stay however its step ended: a failed make's port, a failed start's host key, a cancelled resize's sizes",
    of: ({ event }) => event.type === "reported" && event.status !== "done",
    shows: ({ event }, row) => {
      const {
        port,
        hostKey,
        sizes: sized,
      } = event.type === "reported" ? event.outcome : {};

      return {
        ...row,
        ...(port === undefined ? {} : { port }),
        ...(hostKey === undefined ? {} : { hostKey }),
        ...sized,
      };
    },
  },
  {
    says: "a step that fails under a delete goes on to the delete at once and keeps its error, also a resize, which rested failed until a recheck",
    of: ({ state, event }) =>
      state === "deleting.draining" &&
      event.type === "reported" &&
      event.status === "failed",
    shows: (_, row) => ({ ...row, phase: "observing", error }),
  },
  {
    says: "a make lost under a delete goes on to the delete with no error to show",
    of: ({ state, op, event }) =>
      state === "deleting.draining" &&
      event.type === "lost" &&
      op?.kind === "make",
    shows: ({ row: { error: kept } }, row) => ({ ...row, error: kept }),
  },
  {
    says: "a delete that fails says why, also of a failed create, whose make's error the delete cleared",
    of: ({ state, stage, event }) =>
      state === "deleting.sent" &&
      stage === "undoing" &&
      event.type === "reported" &&
      event.status === "failed",
    shows: (_, row) => ({ ...row, error }),
  },
  {
    says: "under a delete a report leaves prepared alone, which nothing reads again",
    of: ({ state, event }) =>
      state === "deleting.draining" && event.type === "reported",
    shows: ({ row: { prepared } }, row) => ({ ...row, prepared }),
  },
];

const expectedOf = (step: Walked, fired: Set<string>) => {
  let row = step.was;

  for (const { says, of, shows } of differences) {
    if (row !== "removed" && of(step)) {
      const shown = shows(step, row);

      if (!isDeepStrictEqual(shown, row)) {
        fired.add(says);
      }

      row = shown;
    }
  }

  return row;
};

it.effect(
  "every event from every leaf does what settled, lost, the store's SQL and the loop do, but for the differences named here",
  () =>
    Effect.gen(function* () {
      const stateDir = path.join(yield* scratch, "state");

      const walked = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* open({ stateDir });

          const requests = yield* Effect.forEach(fixtures, (fixture, tag) =>
            requestWalks(store, fixture, tag)
          );

          return [
            ...requests.flat(),
            ...fixtures.flatMap(reportWalks),
            ...fixtures.flatMap(lookWalks),
            ...fixtures.flatMap(quietWalks),
            ...fixtures.flatMap(notOnHost),
          ];
        })
      );

      const fired = new Set<string>();

      const mismatches = walked.flatMap((step) => {
        const chart = shownByChart(step);

        const today = {
          row: visible(expectedOf(step, fired)),
          begins: step.begins,
          finish: step.finishes,
        };

        return isDeepStrictEqual(chart, today)
          ? []
          : [
              {
                on: step.name,
                at: step.state,
                op: step.op?.kind,
                chart,
                today,
              },
            ];
      });

      expect(fixtures.length).toBeGreaterThan(leaves.length);
      expect(walked).toHaveLength(9752);
      expect(mismatches.slice(0, 3)).toStrictEqual([]);
      expect(differences.filter(({ says }) => !fired.has(says))).toStrictEqual(
        []
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 }
);

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

  it("every leaf shows the phase its projection names", () => {
    expect(
      leaves.filter((state) => phaseOf(state) !== projection[state][1])
    ).toStrictEqual([]);
  });

  it("has a leaf for each row the projection names, and no other", () => {
    expect([...leaves].toSorted()).toStrictEqual(
      Object.keys(projection).toSorted()
    );
    expect(
      leavesOf(machine).filter((leaf) => !leaves.some((row) => row === leaf))
    ).toStrictEqual(["gone"]);
  });

  it("a transition that throws reaches the caller, so its write rolls back", () => {
    const thrown = setup({
      schemas: {
        context: types<{ readonly name: string }>(),
        events: { boom: types<object>() },
      },
    }).createMachine({
      context: { name: "dev" },
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
      resolve: (value, context) => thrown.resolveState({ value, context }),
      transition: (snapshot, event) => transition(thrown, snapshot, event),
      leaves: ["here"],
      metaOf: () => ({ phase: "here", activity: "none" }),
      begin: () => {
        throw new Error("no step here");
      },
    };

    expect(() =>
      applied(
        chart,
        { name: "dev", state: "here" },
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
