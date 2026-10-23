import { describe, expect, it } from "@effect/vitest";
import type { Desired } from "@gjermundgaraba/clankerbox-sdk";
import { type Decided, type Next, next } from "../src/reconcile.ts";
import type { MachineState } from "../src/runtime.ts";

interface State extends Decided {
  readonly seen: MachineState;
}

const desires: ReadonlyArray<Desired> = ["running", "stopped", "paused", "deleted"];

const flags: ReadonlyArray<boolean> = [false, true];

const seens: ReadonlyArray<MachineState> = ["running", "stopped", "paused", "missing", "unknown"];

const states: ReadonlyArray<State> = desires.flatMap((desired) =>
  flags.flatMap((made) =>
    flags.flatMap((prepared) => seens.map((seen) => ({ desired, made, prepared, seen }))),
  ),
);

const decide = (state: State): Next => next(state, state.seen);

const rests: ReadonlySet<Next> = new Set<Next>(["settled", "lost", "waiting"]);

const succeeded = (state: State, step: Next): State => {
  switch (step) {
    case "creating":
      return { ...state, made: true, prepared: false, seen: "running" };
    case "starting":
      return { ...state, prepared: true, seen: "running" };
    case "stopping":
      return { ...state, prepared: false, seen: "stopped" };
    case "pausing":
      return { ...state, prepared: false, seen: "paused" };
    default:
      return state;
  }
};

const restsWithin = (state: State, steps: number): boolean => {
  let current = state;

  for (let taken = 0; taken <= steps; taken++) {
    const step = decide(current);

    if (rests.has(step)) {
      return true;
    }

    current = succeeded(current, step);
  }

  return false;
};

describe("next", () => {
  it("covers every state: four desires, made or not, prepared or not, five readings", () => {
    expect(states).toHaveLength(80);
  });

  it("a machine asked to be deleted is deleted, whatever else holds", () => {
    expect(
      states.filter((state) => state.desired === "deleted" && decide(state) !== "deleting"),
    ).toEqual([]);
  });

  it("a made machine asked to stop is never made or started", () => {
    expect(
      states.filter(
        (state) =>
          state.made &&
          state.desired === "stopped" &&
          ["creating", "starting"].includes(decide(state)),
      ),
    ).toEqual([]);
  });

  it("a made machine asked to pause is paused only from running, and never made, started or stopped", () => {
    expect(
      states.filter(
        (state) =>
          state.made &&
          state.desired === "paused" &&
          (["creating", "starting", "stopping"].includes(decide(state)) ||
            (decide(state) === "pausing") !== (state.seen === "running")),
      ),
    ).toEqual([]);
  });

  it("a paused machine asked to run or stop is started or stopped, never left at rest", () => {
    expect(
      states.filter(
        (state) =>
          state.made &&
          state.seen === "paused" &&
          ((state.desired === "running" && decide(state) !== "starting") ||
            (state.desired === "stopped" && decide(state) !== "stopping")),
      ),
    ).toEqual([]);
  });

  it("a machine not made is made, whatever the runtime reads: only a delete stops its making", () => {
    expect(
      states.filter(
        (state) => !state.made && state.desired !== "deleted" && decide(state) !== "creating",
      ),
    ).toEqual([]);
  });

  it("a running machine settles only once it is made, runs and is prepared", () => {
    expect(
      states.filter(
        (state) =>
          state.desired === "running" &&
          decide(state) === "settled" &&
          !(state.made && state.seen === "running" && state.prepared),
      ),
    ).toEqual([]);
  });

  it("against a runtime whose every step succeeds, a machine not deleted rests within two steps", () => {
    expect(states.filter((state) => state.desired !== "deleted" && !restsWithin(state, 2))).toEqual(
      [],
    );
  });

  it("a made machine the runtime no longer has is lost, and one it can't read waits", () => {
    const made: State = { desired: "running", made: true, prepared: false, seen: "missing" };

    expect([decide(made), decide({ ...made, seen: "unknown" })]).toEqual(["lost", "waiting"]);
  });
});
