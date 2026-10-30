import { describe, expect, it } from "@effect/vitest";
import {
  Capacity,
  Internal,
  ScriptFailed,
} from "@gjermundgaraba/clankerbox-sdk";
import type { TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";
import { waitFor } from "@xstate/effect";
import { Deferred, Effect, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  answer,
  ask,
  checked,
  lifecycle,
  longestBackoff,
  phaseOf,
  spawn,
  tell,
} from "../src/lifecycle.ts";
import type {
  Born,
  Making,
  Snapshot,
  StepError,
  Steps,
} from "../src/lifecycle.ts";
import type { MachineState, RuntimeError } from "../src/runtime.ts";

type Row = Omit<Born, "making" | "seen">;

const intent = (fields?: Partial<Row>): Row => ({
  name: "dev",
  desired: "running",
  generation: 1,
  made: false,
  ...fields,
});

const made = intent({ made: true });

const fresh: Making = {
  source: { kind: "base", image: "ubuntu" },
  script: undefined,
};

type Name = Exclude<keyof Steps, "observe">;

interface Gate {
  readonly entered: Deferred.Deferred<undefined>;
  readonly release: Deferred.Deferred<undefined>;
  readonly interrupted: Deferred.Deferred<undefined>;
}

const gated = Effect.gen(function* () {
  const gate: Gate = {
    entered: yield* Deferred.make<undefined>(),
    release: yield* Deferred.make<undefined>(),
    interrupted: yield* Deferred.make<undefined>(),
  };

  return gate;
});

const world = (initial: MachineState) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initial);
    const calls = yield* Ref.make<readonly string[]>([]);
    const tailnet = yield* Ref.make<TailnetStatus | undefined>(undefined);
    const failures = new Map<Name, StepError>();
    const gates = new Map<Name, Gate>();

    const enter = (name: Name) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (all) => [...all, name]);

        const gate = gates.get(name);

        if (gate !== undefined) {
          gates.delete(name);
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release).pipe(
            Effect.onInterrupt(() =>
              Deferred.succeed(gate.interrupted, undefined)
            )
          );
        }

        const failure = failures.get(name);

        if (failure !== undefined) {
          failures.delete(name);

          return yield* failure;
        }
      });

    const step = (name: Name, after: MachineState) =>
      Effect.andThen(enter(name), Ref.set(state, after));

    const steps: Steps = {
      observe: () => Ref.get(state),
      make: (life) =>
        Effect.andThen(
          life.making?.script === undefined
            ? Effect.void
            : Ref.update(calls, (all) => [...all, "setup"]),
          step("make", "running")
        ),
      start: () => step("start", "running"),
      join: () => Effect.andThen(Effect.orDie(enter("join")), Ref.get(tailnet)),
      stop: () => step("stop", "stopped"),
      pause: () => step("pause", "paused"),
      remove: () =>
        Effect.mapError(
          step("remove", "missing"),
          (error): RuntimeError => new Internal({ message: error.message })
        ),
    };

    const hold = (name: Name) =>
      Effect.tap(gated, (gate) => Effect.sync(() => gates.set(name, gate)));

    return {
      steps,
      state,
      tailnet,
      calls: Effect.map(Ref.get(calls), (all) =>
        all.filter((call) => call !== "join")
      ),
      joins: Effect.map(
        Ref.get(calls),
        (all) => all.filter((call) => call === "join").length
      ),
      hold,
      failNext: (name: Name, error: StepError) =>
        Effect.sync(() => failures.set(name, error)),
    };
  });

const rig = (
  initial: MachineState,
  born: Row,
  options?: {
    readonly making?: Making;
    readonly hold?: Name;
    readonly fail?: [Name, StepError];
  }
) =>
  Effect.gen(function* () {
    const at = yield* world(initial);

    const gate =
      options?.hold === undefined ? yield* gated : yield* at.hold(options.hold);

    if (options?.fail !== undefined) {
      yield* at.failNext(...options.fail);
    }

    const actor = yield* spawn(lifecycle(at.steps), {
      ...born,
      making: options?.making ?? (born.made ? undefined : fresh),
      seen: initial,
    });

    let { generation } = born;

    const request = (desired: Row["desired"]) =>
      Effect.gen(function* () {
        generation += 1;

        const mine = generation;

        yield* ask(actor, { desired, generation: mine });

        return mine;
      });

    const until = (generation_: number) => answer(actor, generation_);

    return { ...at, actor, request, until, gate };
  });

const settledAfter = (calls: Effect.Effect<readonly string[]>, count: number) =>
  Effect.repeat(
    Effect.flatMap(Effect.yieldNow, () => calls),
    { until: (made_) => made_.length >= count, times: 100 }
  );

const at = (snapshot: Snapshot) =>
  [phaseOf(snapshot), snapshot.context.desired] as const;

describe("a machine's lifecycle", () => {
  it.effect(
    "a new machine is made, then started and prepared, then rests settled",
    () =>
      Effect.gen(function* () {
        const { actor, calls } = yield* rig("missing", intent());

        expect(at(yield* answer(actor, 1))).toStrictEqual([
          "settled",
          "running",
        ]);
        expect(yield* calls).toStrictEqual(["make", "start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a machine is made in one step with its setup, and what its create held is dropped",
    () =>
      Effect.gen(function* () {
        const { actor, calls } = yield* rig("missing", intent(), {
          making: { ...fresh, script: { script: "echo hi" } },
        });

        const settled = yield* answer(actor, 1);

        expect([phaseOf(settled), settled.context.making]).toStrictEqual([
          "settled",
          undefined,
        ]);
        expect(yield* calls).toStrictEqual(["setup", "make", "start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a made machine that runs is started and prepared again when the host starts",
    () =>
      Effect.gen(function* () {
        const { actor, calls } = yield* rig("running", made);

        expect(at(yield* answer(actor, 1))).toStrictEqual([
          "settled",
          "running",
        ]);
        expect(yield* calls).toStrictEqual(["start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a stop sent while a start boots cuts the start short, and the stop is the answer",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("stopped", { ...made, desired: "stopped" });

        yield* answer(machine.actor, 1);

        const boot = yield* machine.hold("start");
        const started = yield* machine.request("running");

        yield* Deferred.await(boot.entered);

        const stopped = yield* machine.request("stopped");
        const rest = yield* machine.until(stopped);

        yield* Deferred.await(boot.interrupted);

        expect(at(rest)).toStrictEqual(["settled", "stopped"]);
        expect(rest.context.generation).toBeGreaterThan(started);
        expect([
          yield* machine.calls,
          yield* Ref.get(machine.state),
        ]).toStrictEqual([["start"], "stopped"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a stop sent while a running machine is prepared cuts its start short",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made, { hold: "start" });
        const preparing = machine.gate;

        yield* Deferred.await(preparing.entered);

        const rest = yield* machine.until(yield* machine.request("stopped"));

        yield* Deferred.await(preparing.interrupted);

        expect(at(rest)).toStrictEqual(["settled", "stopped"]);
        expect(yield* machine.calls).toStrictEqual(["start", "stop"]);
      }).pipe(Effect.scoped)
  );

  it.effect("a start sent while a machine stops cuts the stop short", () =>
    Effect.gen(function* () {
      const machine = yield* rig("running", made);

      yield* answer(machine.actor, 1);

      const stopping = yield* machine.hold("stop");

      yield* machine.request("stopped");
      yield* Deferred.await(stopping.entered);

      const rest = yield* machine.until(yield* machine.request("running"));

      yield* Deferred.await(stopping.interrupted);

      expect(at(rest)).toStrictEqual(["settled", "running"]);
      expect(yield* machine.calls).toStrictEqual(["start", "stop", "start"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "a pause of a running machine pauses it and rests paused, and a start resumes and prepares it",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        yield* answer(machine.actor, 1);

        const paused = yield* machine.until(yield* machine.request("paused"));
        const resumed = yield* machine.until(yield* machine.request("running"));

        expect([at(paused), at(resumed)]).toStrictEqual([
          ["settled", "paused"],
          ["settled", "running"],
        ]);
        expect(yield* machine.calls).toStrictEqual(["start", "pause", "start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a pause of a stopped machine leaves it stopped: it has nothing to save",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("stopped", { ...made, desired: "stopped" });

        yield* answer(machine.actor, 1);

        const rest = yield* machine.until(yield* machine.request("paused"));

        expect([at(rest), rest.context.seen]).toStrictEqual([
          ["settled", "paused"],
          "stopped",
        ]);
        expect(yield* machine.calls).toStrictEqual([]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a stop of a paused machine stops it, ending its saved execution",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("paused", { ...made, desired: "paused" });

        expect(at(yield* answer(machine.actor, 1))).toStrictEqual([
          "settled",
          "paused",
        ]);

        const rest = yield* machine.until(yield* machine.request("stopped"));

        expect([at(rest), rest.context.seen]).toStrictEqual([
          ["settled", "stopped"],
          "stopped",
        ]);
        expect(yield* machine.calls).toStrictEqual(["stop"]);
      }).pipe(Effect.scoped)
  );

  it.effect("a start sent while a machine pauses cuts the pause short", () =>
    Effect.gen(function* () {
      const machine = yield* rig("running", made);

      yield* answer(machine.actor, 1);

      const pausing = yield* machine.hold("pause");

      yield* machine.request("paused");
      yield* Deferred.await(pausing.entered);

      const rest = yield* machine.until(yield* machine.request("running"));

      yield* Deferred.await(pausing.interrupted);

      expect(at(rest)).toStrictEqual(["settled", "running"]);
      expect(yield* machine.calls).toStrictEqual(["start", "pause", "start"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "a second request for what a step already works toward lets the step finish",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("stopped", { ...made, desired: "stopped" });

        yield* answer(machine.actor, 1);

        const boot = yield* machine.hold("start");

        yield* machine.request("running");
        yield* Deferred.await(boot.entered);

        const again = yield* machine.request("running");

        yield* waitFor(
          machine.actor,
          (snapshot) => snapshot.context.generation === again
        );
        yield* Deferred.succeed(boot.release, undefined);

        expect(at(yield* machine.until(again))).toStrictEqual([
          "settled",
          "running",
        ]);
        expect(yield* machine.calls).toStrictEqual(["start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a delete sent while a machine is made cuts its making short and deletes it",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("missing", intent(), { hold: "make" });
        const making = machine.gate;

        yield* Deferred.await(making.entered);

        const gone = yield* machine.until(yield* machine.request("deleted"));

        yield* Deferred.await(making.interrupted);

        expect([
          gone.status,
          gone.context.making,
          gone.context.undone,
        ]).toStrictEqual(["done", undefined, undefined]);
        expect(yield* machine.calls).toStrictEqual(["make", "remove"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a stop sent while a machine is made waits for the making, then is acted on",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("missing", intent(), { hold: "make" });
        const making = machine.gate;

        yield* Deferred.await(making.entered);

        const stopped = yield* machine.request("stopped");

        const taken = yield* waitFor(
          machine.actor,
          (snapshot) => snapshot.context.desired === "stopped"
        );

        expect(phaseOf(taken)).toBe("creating");

        yield* Deferred.succeed(making.release, undefined);

        expect(at(yield* machine.until(stopped))).toStrictEqual([
          "settled",
          "stopped",
        ]);
        expect(yield* machine.calls).toStrictEqual(["make", "stop"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a create that fails deletes the machine, and its error is the answer",
    () =>
      Effect.gen(function* () {
        const full = new Capacity({ message: "no room" });

        const machine = yield* rig("missing", intent(), {
          fail: ["make", full],
        });

        const gone = yield* answer(machine.actor, 1);

        expect([
          gone.status,
          gone.context.desired,
          gone.context.undone,
        ]).toStrictEqual(["done", "deleted", full]);
        expect(yield* machine.calls).toStrictEqual(["make", "remove"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a setup that fails deletes the machine, though a stop was asked meanwhile",
    () =>
      Effect.gen(function* () {
        const exited = new ScriptFailed({
          message: "setup exited 1",
          script: "setup",
        });

        const machine = yield* rig("missing", intent(), {
          making: { ...fresh, script: { script: "exit 1" } },
          hold: "make",
          fail: ["make", exited],
        });

        yield* Deferred.await(machine.gate.entered);
        yield* machine.request("stopped");
        yield* Deferred.succeed(machine.gate.release, undefined);

        const gone = yield* answer(machine.actor, 2);

        expect([
          gone.status,
          gone.context.making,
          gone.context.undone,
        ]).toStrictEqual(["done", undefined, exited]);
        expect(yield* machine.calls).toStrictEqual(["setup", "make", "remove"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a step that fails on a made machine rests failed until a request tries again",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);
        const stuck = new Capacity({ message: "stop refused" });

        yield* answer(machine.actor, 1);
        yield* machine.failNext("stop", stuck);

        const failed = yield* machine.until(yield* machine.request("stopped"));

        expect([phaseOf(failed), failed.context.error]).toStrictEqual([
          "failed",
          stuck,
        ]);

        const retried = yield* machine.until(yield* machine.request("stopped"));

        expect([phaseOf(retried), retried.context.error]).toStrictEqual([
          "settled",
          undefined,
        ]);
        expect(yield* machine.calls).toStrictEqual(["start", "stop", "stop"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a request sent while a step runs that then fails is acted on, not the failure",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("stopped", { ...made, desired: "stopped" });

        yield* answer(machine.actor, 1);

        const boot = yield* machine.hold("start");

        yield* machine.failNext("start", new Capacity({ message: "no room" }));
        yield* machine.request("running");
        yield* Deferred.await(boot.entered);

        const again = yield* machine.request("running");

        yield* waitFor(
          machine.actor,
          (snapshot) => snapshot.context.generation === again
        );
        yield* Deferred.succeed(boot.release, undefined);

        const rest = yield* machine.until(again);

        expect([phaseOf(rest), rest.context.error]).toStrictEqual([
          "settled",
          undefined,
        ]);
        expect(yield* machine.calls).toStrictEqual(["start", "start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a start on a machine that runs already starts and prepares it again",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        yield* answer(machine.actor, 1);

        const rest = yield* machine.until(yield* machine.request("running"));

        expect(at(rest)).toStrictEqual(["settled", "running"]);
        expect(yield* machine.calls).toStrictEqual(["start", "start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a settled machine reads nothing by itself, however long it rests",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        yield* answer(machine.actor, 1);
        yield* Ref.set(machine.state, "stopped");
        yield* TestClock.adjust("1 hour");

        expect([
          phaseOf(machine.actor.getSnapshot()),
          yield* settledAfter(machine.calls, 1),
        ]).toStrictEqual(["settled", ["start"]]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a settled machine told it stopped under it decides again, and starts it",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        yield* answer(machine.actor, 1);
        yield* Ref.set(machine.state, "stopped");
        yield* tell(machine.actor, "stopped");

        expect(yield* settledAfter(machine.calls, 2)).toStrictEqual([
          "start",
          "start",
        ]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a state the runtime can't read rests waiting until the host reads it again",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("unknown", made);

        const waiting = yield* answer(machine.actor, 1);

        yield* Ref.set(machine.state, "running");
        yield* TestClock.adjust("1 hour");

        const still = phaseOf(machine.actor.getSnapshot());

        yield* tell(machine.actor, "running");

        expect([phaseOf(waiting), still]).toStrictEqual(["waiting", "waiting"]);
        expect(
          at(
            yield* waitFor(
              machine.actor,
              (snapshot) => phaseOf(snapshot) === "settled"
            )
          )
        ).toStrictEqual(["settled", "running"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a made machine the runtime no longer has is lost, which only a delete leaves",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("missing", made);

        expect(phaseOf(yield* answer(machine.actor, 1))).toBe("lost");

        const started = yield* machine.until(yield* machine.request("running"));

        expect(phaseOf(started)).toBe("lost");
        expect(yield* machine.calls).toStrictEqual([]);
      }).pipe(Effect.scoped)
  );

  it.effect("a request older than the machine's last changes nothing", () =>
    Effect.gen(function* () {
      const machine = yield* rig("running", { ...made, generation: 5 });

      yield* answer(machine.actor, 5);
      yield* ask(machine.actor, { desired: "stopped", generation: 3 });

      const rest = yield* answer(machine.actor, 5);

      expect([...at(rest), rest.context.generation]).toStrictEqual([
        "settled",
        "running",
        5,
      ]);
      expect(yield* machine.calls).toStrictEqual(["start"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "a delete sent again after one failed shows no error while it retries",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);
        const busy = new Internal({ message: "delete failed" });

        yield* answer(machine.actor, 1);
        yield* machine.failNext("remove", busy);

        const failed = yield* machine.until(yield* machine.request("deleted"));
        const retrying = yield* machine.hold("remove");

        yield* machine.request("deleted");
        yield* Deferred.await(retrying.entered);

        const during = machine.actor.getSnapshot().context.error;

        yield* Deferred.succeed(retrying.release, undefined);

        expect([phaseOf(failed), failed.context.error, during]).toStrictEqual([
          "failed",
          busy,
          undefined,
        ]);
        expect((yield* machine.until(3)).status).toBe("done");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a machine being deleted stays deleted: a later start only raises the generation",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        yield* answer(machine.actor, 1);

        const removing = yield* machine.hold("remove");

        yield* machine.request("deleted");
        yield* Deferred.await(removing.entered);
        yield* machine.request("running");

        expect(machine.actor.getSnapshot().context.desired).toBe("deleted");

        yield* Deferred.succeed(removing.release, undefined);

        expect((yield* machine.until(3)).status).toBe("done");
        expect(yield* machine.calls).toStrictEqual(["start", "remove"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a start checks the machine's tailnet once it settles, and keeps what it found",
    () =>
      Effect.gen(function* () {
        const joined: TailnetStatus = {
          state: "joined",
          name: "linux-dev.example.ts.net",
        };

        const machine = yield* rig("running", made);

        yield* Ref.set(machine.tailnet, joined);
        yield* answer(machine.actor, 1);

        const after = yield* waitFor(
          machine.actor,
          (snapshot) =>
            snapshot.value === "settled" &&
            snapshot.context.tailnet.status !== undefined
        );

        expect(after.context.tailnet.status).toStrictEqual(joined);
        expect([yield* machine.calls, yield* machine.joins]).toStrictEqual([
          ["start"],
          1,
        ]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a failed check is tried again after one recheck, then after two",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        const rested = (wait: number) =>
          waitFor(
            machine.actor,
            (snapshot) =>
              snapshot.value === "settled" &&
              snapshot.context.tailnet.status !== undefined &&
              snapshot.context.tailnet.wait === wait
          );

        yield* Ref.set(machine.tailnet, {
          state: "failed",
          error: "no answer",
        });
        yield* answer(machine.actor, 1);
        yield* rested(1);

        const joinsAfter = Effect.fnUntraced(function* (wait: number) {
          yield* tell(machine.actor, "running");
          yield* rested(wait);

          return yield* machine.joins;
        });

        expect(yield* joinsAfter(2)).toBe(2);
        expect(yield* joinsAfter(1)).toBe(2);
        expect(yield* joinsAfter(4)).toBe(3);
      }).pipe(Effect.scoped)
  );

  it("each failure in a row doubles the rechecks the next check waits, up to a cap", () => {
    const failed: TailnetStatus = { state: "failed", error: "no answer" };
    let check = checked({ status: undefined, wait: 0, backoff: 1 }, failed);
    const waits = [check.wait];

    for (let failures = 1; failures < 9; failures += 1) {
      check = checked(check, failed);
      waits.push(check.wait);
    }

    expect(waits).toStrictEqual([
      1,
      2,
      4,
      8,
      16,
      32,
      longestBackoff,
      longestBackoff,
      longestBackoff,
    ]);
    expect(checked(check, { state: "joined" })).toMatchObject({
      wait: 60,
      backoff: 1,
    });
    expect(checked(check, { state: "missing" }).wait).toBeUndefined();
    expect(checked(check, undefined)).toStrictEqual({
      status: undefined,
      wait: undefined,
      backoff: 1,
    });
  });

  it.effect(
    "a machine without tailscaled isn't checked again until it starts again",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        yield* Ref.set(machine.tailnet, { state: "missing" });
        yield* answer(machine.actor, 1);
        yield* waitFor(
          machine.actor,
          (snapshot) => snapshot.context.tailnet.status !== undefined
        );

        for (let rechecks = 0; rechecks < 3; rechecks += 1) {
          yield* tell(machine.actor, "running");
        }

        yield* waitFor(
          machine.actor,
          (snapshot) => snapshot.value === "settled"
        );

        expect(yield* machine.joins).toBe(1);
      }).pipe(Effect.scoped)
  );

  it.effect("a stop sent while a check runs cuts the check short", () =>
    Effect.gen(function* () {
      const machine = yield* rig("running", made, { hold: "join" });

      yield* Deferred.await(machine.gate.entered);

      const stopped = yield* machine.until(yield* machine.request("stopped"));

      yield* Deferred.await(machine.gate.interrupted);

      expect(at(stopped)).toStrictEqual(["settled", "stopped"]);
      expect(yield* machine.calls).toStrictEqual(["start", "stop"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "a check whose machine is seen stopped meanwhile is cut short, and it starts again",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made, { hold: "join" });

        yield* Deferred.await(machine.gate.entered);
        yield* Ref.set(machine.state, "stopped");
        yield* tell(machine.actor, "stopped");
        yield* Deferred.await(machine.gate.interrupted);
        yield* settledAfter(machine.calls, 2);

        expect(yield* machine.calls).toStrictEqual(["start", "start"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a machine asked to stop is stopped, not checked, when it runs again",
    () =>
      Effect.gen(function* () {
        const machine = yield* rig("running", made);

        yield* Ref.set(machine.tailnet, {
          state: "failed",
          error: "no answer",
        });
        yield* answer(machine.actor, 1);
        yield* waitFor(
          machine.actor,
          (snapshot) => snapshot.context.tailnet.status !== undefined
        );

        yield* machine.until(yield* machine.request("stopped"));
        yield* Ref.set(machine.state, "running");
        yield* tell(machine.actor, "running");
        yield* settledAfter(machine.calls, 3);

        expect([yield* machine.calls, yield* machine.joins]).toStrictEqual([
          ["start", "stop", "stop"],
          1,
        ]);
      }).pipe(Effect.scoped)
  );
});
