import { MachineState } from "@clankerbox/host-contract";
import type { Report } from "@clankerbox/host-contract";
import { describe, expect, it } from "@effect/vitest";
import { Desired } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime } from "effect";

import { next, settled } from "../src/reconcile.ts";
import type { Decided, Next } from "../src/reconcile.ts";
import type { MachineRow, Operation, Stage } from "../src/store.ts";

interface State extends Decided {
  readonly seen: MachineState;
}

const stages: readonly Stage[] = ["making", "made", "undoing", "undone"];

const desires = Desired.literals;

const flags: readonly boolean[] = [false, true];

const seens = MachineState.literals;

const states: readonly State[] = stages.flatMap((stage) =>
  desires.flatMap((desired) =>
    flags.flatMap((prepared) =>
      flags.flatMap((resizing) =>
        seens.map((seen) => ({ stage, desired, prepared, resizing, seen }))
      )
    )
  )
);

const decide = (state: State): Next => next(state, state.seen);

const made = states.filter(({ stage }) => stage === "made");

const asked = (state: State) => state.desired !== "deleted";

const read = ({ seen }: State) => seen !== "unknown" && seen !== "missing";

const rests: ReadonlySet<Next> = new Set<Next>([
  "settled",
  "failed",
  "lost",
  "unread",
]);

const succeeded = (state: State, step: Next): State => {
  switch (step) {
    case "creating": {
      return { ...state, stage: "made", prepared: false, seen: "running" };
    }

    case "starting": {
      return { ...state, prepared: true, seen: "running" };
    }

    case "stopping": {
      return { ...state, prepared: false, seen: "stopped" };
    }

    case "pausing": {
      return { ...state, prepared: false, seen: "paused" };
    }

    case "resizing": {
      return { ...state, resizing: false };
    }

    case "deleting": {
      return { ...state, stage: "undone" };
    }

    case "settled":
    case "failed":
    case "lost":
    case "unread": {
      return state;
    }
  }
};

const restsWithin = (state: State, steps: number): boolean => {
  let current = state;

  for (let taken = 0; taken <= steps; taken += 1) {
    const step = decide(current);

    if (rests.has(step)) {
      return true;
    }

    current = succeeded(current, step);
  }

  return false;
};

describe("next", () => {
  it("covers every stage, wish, flag and reading there is", () => {
    expect(states).toHaveLength(4 * 4 * 2 * 2 * 5);
  });

  it("a machine asked to be deleted is deleted, whatever else holds", () => {
    expect(
      states.filter(
        (state) => state.desired === "deleted" && decide(state) !== "deleting"
      )
    ).toStrictEqual([]);
  });

  it("a failed make being undone is deleted, whatever was asked since", () => {
    expect(
      states.filter(
        (state) => state.stage === "undoing" && decide(state) !== "deleting"
      )
    ).toStrictEqual([]);
  });

  it("a failed create once undone rests failed, whatever else holds, until a delete", () => {
    expect(
      states.filter(
        (state) =>
          state.stage === "undone" && asked(state) && decide(state) !== "failed"
      )
    ).toStrictEqual([]);
  });

  it("a machine not made is made, whatever the runtime reads: only a delete stops its making", () => {
    expect(
      states.filter(
        (state) =>
          state.stage === "making" &&
          asked(state) &&
          decide(state) !== "creating"
      )
    ).toStrictEqual([]);
  });

  it("a made machine asked to stop is never made or started", () => {
    expect(
      made.filter(
        (state) =>
          state.desired === "stopped" &&
          ["creating", "starting"].includes(decide(state))
      )
    ).toStrictEqual([]);
  });

  it("a made machine asked to pause is paused only from running, and never made, started or stopped", () => {
    expect(
      made.filter(
        (state) =>
          state.desired === "paused" &&
          !state.resizing &&
          (["creating", "starting", "stopping"].includes(decide(state)) ||
            (decide(state) === "pausing") !== (state.seen === "running"))
      )
    ).toStrictEqual([]);
  });

  it("a paused machine asked to run or stop is started or stopped, never left at rest", () => {
    expect(
      made.filter(
        (state) =>
          state.seen === "paused" &&
          !state.resizing &&
          ((state.desired === "running" && decide(state) !== "starting") ||
            (state.desired === "stopped" && decide(state) !== "stopping"))
      )
    ).toStrictEqual([]);
  });

  it("a running machine settles only once it is made, runs and is prepared, with no resize left", () => {
    expect(
      states.filter(
        (state) =>
          state.desired === "running" &&
          decide(state) === "settled" &&
          !(
            state.stage === "made" &&
            state.seen === "running" &&
            state.prepared &&
            !state.resizing
          )
      )
    ).toStrictEqual([]);
  });

  it("a resize asked of a made machine the runtime reads comes before all but a delete", () => {
    expect(
      made.filter(
        (state) =>
          state.resizing &&
          asked(state) &&
          read(state) &&
          decide(state) !== "resizing"
      )
    ).toStrictEqual([]);
  });

  it("a resize waits for a machine the runtime can't read, and for one it no longer has", () => {
    const unread = made.filter(
      (state) => state.resizing && asked(state) && !read(state)
    );

    expect(unread.map((state) => [state.seen, decide(state)])).toStrictEqual(
      unread.map(({ seen }) => [seen, seen === "unknown" ? "unread" : "lost"])
    );
  });

  it("no step but a make or a delete runs on a machine that isn't made", () => {
    expect(
      states.filter(
        (state) =>
          state.stage !== "made" &&
          ["starting", "stopping", "pausing", "resizing"].includes(
            decide(state)
          )
      )
    ).toStrictEqual([]);
  });

  it("against a runtime whose every step succeeds, a machine not deleted rests within a make, a resize and a start", () => {
    expect(
      states.filter((state) => asked(state) && !restsWithin(state, 3))
    ).toStrictEqual([]);
  });

  it("a made machine the runtime no longer has is lost, and one it can't read is left as it is", () => {
    const missing: State = {
      stage: "made",
      desired: "running",
      prepared: false,
      resizing: false,
      seen: "missing",
    };

    expect([
      decide(missing),
      decide({ ...missing, seen: "unknown" }),
    ]).toStrictEqual(["lost", "unread"]);
  });
});

const row = (desired: Desired): MachineRow => ({
  name: "dev",
  instance: "1",
  createdAt: DateTime.makeUnsafe(0),
  kind: "linux",
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  host: "linux",
  port: undefined,
  desired,
  generation: 1,
  phase: "creating",
  stage: "making",
  prepared: false,
  error: undefined,
  resize: undefined,
  ephemeral: false,
  source: { kind: "base", scripted: true },
  prebuild: undefined,
  hostKey: undefined,
  pin: undefined,
  undoneAt: undefined,
});

const make: Operation = {
  id: "op",
  kind: "make",
  resource: "machine",
  name: "dev",
  host: "linux",
  boot: "boot",
  sequence: 1,
  generation: 1,
  seen: "missing",
  leases: [],
};

const cancelled: Report = {
  id: "op",
  boot: "boot",
  status: "cancelled",
  outcome: {},
};

describe("settled", () => {
  it("a make cut short though no delete asked is undone, saying why, not run again", () => {
    expect(settled(row("running"), make, cancelled)).toMatchObject({
      stage: "undoing",
      phase: "observing",
      error: { _tag: "Internal" },
    });
  });

  it("a make cut short by a delete leaves the delete to run", () => {
    expect(settled(row("deleted"), make, cancelled)).toStrictEqual({
      phase: "observing",
    });
  });
});
