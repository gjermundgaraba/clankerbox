import { describe, expect, it } from "@effect/vitest";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Deferred, Duration, Effect, Logger, Option } from "effect";
import { TestClock } from "effect/testing";

import { driver } from "../src/driver.ts";
import type { Heard, Resource } from "../src/driver.ts";
import { Unreachable } from "../src/hosts.ts";
import type { Polled } from "../src/operations.ts";
import type { Advanced } from "../src/store.ts";
import { flight } from "./chart-rows.ts";

type State = "reading" | "following" | "rechecking" | "resting";

interface Row {
  readonly state: State;
}

const recheck = Duration.hours(1);

const activities = {
  reading: "read",
  following: "follow",
  rechecking: "recheck",
  resting: "none",
} as const;

const done: Polled = {
  at: "ended",
  report: { id: "op", boot: "boot", status: "done", outcome: {} },
};

const running: Polled = {
  at: "running",
  report: { id: "op", boot: "boot", status: "running", outcome: {} },
};

const written = (next: Row, moved: boolean): Advanced<Row> => ({
  at: "written",
  next,
  moved,
});

const settled = Effect.forEach(
  Array.from({ length: 100 }),
  () => Effect.yieldNow,
  {
    discard: true,
  }
);

interface Hooks {
  afterRead?: Effect.Effect<void>;
  looking?: Resource<Row>["looking"];
  polling?: Resource<Row>["polling"];
  following?: Resource<Row>["following"];
  noOperation?: boolean;
}

const harness = (start: Row | undefined) =>
  Effect.gen(function* () {
    const counts = {
      reads: 0,
      looks: 0,
      polls: 0,
      heard: [] as Array<Heard["at"]>,
    };

    const held = { row: start };
    const hooks: Hooks = {};

    const drive = yield* driver<Row>(recheck, {
      kind: "machine",
      find: () =>
        Effect.gen(function* () {
          const seen = held.row;

          counts.reads += 1;
          yield* hooks.afterRead ?? Effect.void;

          return Option.fromUndefinedOr(seen);
        }),
      operationOn: () =>
        Effect.succeed(
          hooks.noOperation === true
            ? Option.none()
            : Option.some(flight("stop"))
        ),
      activityOf: (state) => activities[state],
      looking: (row) =>
        Effect.suspend(() => {
          counts.looks += 1;

          return hooks.looking?.(row) ?? Effect.succeed(written(row, false));
        }),
      polling: (row, op) =>
        Effect.suspend(() => {
          counts.polls += 1;

          return hooks.polling?.(row, op) ?? Effect.succeed(running);
        }),
      following: (row, op, heard) =>
        Effect.suspend(() => {
          counts.heard.push(heard.at);

          return hooks.following?.(row, op, heard) ?? Effect.void;
        }),
    });

    return { counts, held, hooks, drive };
  });

const once = (effect: Effect.Effect<void>) => {
  let spent = false;

  return Effect.suspend(() => {
    if (spent) {
      return Effect.void;
    }

    spent = true;

    return effect;
  });
};

const silently = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Logger.layer([]));

describe("a wake", () => {
  it.effect(
    "landing as a turn comes to rest takes another turn at once, which is no recheck",
    () =>
      Effect.gen(function* () {
        const { counts, hooks, drive } = yield* harness({
          state: "rechecking",
        });

        hooks.afterRead = once(drive("dev"));

        yield* drive("dev");
        yield* settled;

        expect(counts).toMatchObject({ reads: 2, looks: 1 });
      })
  );

  it.effect("no wake leaves the loop at rest until the recheck", () =>
    Effect.gen(function* () {
      const { counts, drive } = yield* harness({ state: "rechecking" });

      yield* drive("dev");
      yield* settled;
      yield* TestClock.adjust(Duration.minutes(59));
      yield* settled;

      expect(counts).toMatchObject({ reads: 1, looks: 1 });

      yield* TestClock.adjust(Duration.minutes(1));
      yield* settled;

      expect(counts).toMatchObject({ reads: 2, looks: 2 });
    })
  );

  it.effect(
    "landing as a loop ends is kept: the request's write is read, though the turn read the row before it",
    () =>
      Effect.gen(function* () {
        const { counts, held, hooks, drive } = yield* harness({
          state: "resting",
        });

        hooks.afterRead = once(
          Effect.suspend(() => {
            held.row = { state: "reading" };

            return drive("dev");
          })
        );

        yield* drive("dev");
        yield* settled;

        expect(counts.looks).toBe(1);
      })
  );
});

describe("a loop", () => {
  it.effect(
    "ends at a leaf only a request moves, and a request starts another",
    () =>
      Effect.gen(function* () {
        const { counts, held, drive } = yield* harness({ state: "resting" });

        yield* drive("dev");
        yield* settled;
        yield* TestClock.adjust(Duration.hours(5));
        yield* settled;

        expect(counts).toMatchObject({ reads: 1, looks: 0 });

        held.row = { state: "reading" };
        yield* drive("dev");
        yield* settled;

        expect(counts.looks).toBe(1);
      })
  );

  it.effect("ends when its row is gone", () =>
    Effect.gen(function* () {
      const { counts, drive } = yield* harness(undefined);

      yield* drive("dev");
      yield* settled;
      yield* TestClock.adjust(Duration.hours(5));
      yield* settled;

      expect(counts.reads).toBe(1);
    })
  );

  it.effect(
    "is one per name, however requests land around one that ended, as a second would run a step twice",
    () =>
      Effect.gen(function* () {
        const { counts, held, hooks, drive } = yield* harness({
          state: "resting",
        });

        const hold = yield* Deferred.make<undefined>();

        hooks.looking = (row) =>
          Effect.as(Deferred.await(hold), written(row, false));

        yield* drive("dev");
        yield* settled;

        held.row = { state: "reading" };
        yield* drive("dev");
        yield* settled;
        yield* drive("dev");
        yield* drive("dev");
        yield* settled;

        expect(counts.looks).toBe(1);
      })
  );

  it.effect("runs beside the loops of other names", () =>
    Effect.gen(function* () {
      const { counts, hooks, drive } = yield* harness({ state: "reading" });
      const hold = yield* Deferred.make<undefined>();

      hooks.looking = (row) =>
        Effect.as(Deferred.await(hold), written(row, false));

      yield* drive("one");
      yield* drive("two");
      yield* settled;

      expect(counts.looks).toBe(2);
    })
  );

  it.effect("goes on from a read that moved its row, with no wake", () =>
    Effect.gen(function* () {
      const { counts, held, hooks, drive } = yield* harness({
        state: "reading",
      });

      hooks.looking = (row) =>
        Effect.sync(() => {
          held.row = { state: "resting" };

          return written(row, true);
        });

      yield* drive("dev");
      yield* settled;

      expect(counts).toMatchObject({ looks: 1, reads: 2 });
    })
  );

  it.effect("survives a failed turn, and takes the next at the recheck", () =>
    Effect.gen(function* () {
      const { counts, hooks, drive } = yield* harness({ state: "reading" });

      hooks.looking = () => Effect.fail(new Internal({ message: "disk full" }));

      yield* silently(drive("dev"));
      yield* settled;

      expect(counts.looks).toBe(1);

      yield* TestClock.adjust(recheck);
      yield* settled;

      expect(counts.looks).toBe(2);
    })
  );

  it.effect("survives a turn that dies, as a chart that throws", () =>
    Effect.gen(function* () {
      const { counts, hooks, drive } = yield* harness({ state: "reading" });

      hooks.looking = () => Effect.die(new Error("no such leaf"));

      yield* silently(drive("dev"));
      yield* settled;
      yield* TestClock.adjust(recheck);
      yield* settled;

      expect(counts.looks).toBe(2);
    })
  );

  it.effect("tries again soon when a lease refuses, whatever the recheck", () =>
    Effect.gen(function* () {
      const { counts, hooks, drive } = yield* harness({ state: "reading" });

      hooks.looking = () => Effect.succeed({ at: "busy" });

      yield* drive("dev");
      yield* settled;

      expect(counts.looks).toBe(1);

      yield* TestClock.adjust(Duration.millis(100));
      yield* settled;

      expect(counts.looks).toBe(2);
    })
  );

  it.effect(
    "waits for the recheck when a read finds its host unreachable",
    () =>
      Effect.gen(function* () {
        const { counts, hooks, drive } = yield* harness({ state: "reading" });

        hooks.looking = () =>
          Effect.fail(new Unreachable({ host: "linux", message: "down" }));

        yield* drive("dev");
        yield* settled;
        yield* TestClock.adjust(Duration.minutes(59));
        yield* settled;

        expect(counts.looks).toBe(1);

        yield* TestClock.adjust(Duration.minutes(1));
        yield* settled;

        expect(counts.looks).toBe(2);
      })
  );
});

describe("following a step", () => {
  it.effect("a wake cuts the look at its host short, and looks again", () =>
    Effect.gen(function* () {
      const { counts, hooks, drive } = yield* harness({ state: "following" });
      let cut = 0;

      hooks.polling = () =>
        Effect.onInterrupt(Effect.never, () =>
          Effect.sync(() => {
            cut += 1;
          })
        );

      yield* drive("dev");
      yield* settled;

      expect([counts.polls, cut]).toStrictEqual([1, 0]);

      yield* drive("dev");
      yield* settled;

      expect([counts.polls, cut]).toStrictEqual([2, 1]);
    })
  );

  it.effect(
    "a wake never cuts short what stores a report, so it is always collected",
    () =>
      Effect.gen(function* () {
        const { counts, held, hooks, drive } = yield* harness({
          state: "following",
        });

        const stored = yield* Deferred.make<undefined>();
        let finished = false;

        hooks.polling = () => Effect.succeed(done);
        hooks.following = () =>
          Effect.gen(function* () {
            yield* Deferred.await(stored);
            finished = true;
          });

        yield* drive("dev");
        yield* settled;
        yield* drive("dev");
        yield* settled;

        expect(finished).toBe(false);

        held.row = { state: "resting" };
        yield* Deferred.succeed(stored, undefined);
        yield* settled;

        expect(finished).toBe(true);
        expect(counts.heard).toStrictEqual(["ended"]);
      })
  );

  it.effect(
    "an unreachable host is tried again within a second, or at a wake, and nothing is stored",
    () =>
      Effect.gen(function* () {
        const { counts, hooks, drive } = yield* harness({ state: "following" });

        hooks.polling = () => Effect.succeed<Polled>({ at: "unreachable" });

        yield* drive("dev");
        yield* settled;

        expect(counts.polls).toBe(1);

        yield* TestClock.adjust(Duration.seconds(1));
        yield* settled;

        expect(counts.polls).toBe(2);

        yield* drive("dev");
        yield* settled;

        expect(counts.polls).toBe(3);
        expect(counts.heard).toStrictEqual([]);
      })
  );

  it.effect(
    "a row at a step with no operation fails its turn, and waits for the recheck",
    () =>
      Effect.gen(function* () {
        const { counts, hooks, drive } = yield* harness({ state: "following" });

        hooks.noOperation = true;

        yield* silently(drive("dev"));
        yield* settled;

        expect([counts.reads, counts.polls]).toStrictEqual([1, 0]);

        yield* TestClock.adjust(recheck);
        yield* settled;

        expect([counts.reads, counts.polls]).toStrictEqual([2, 0]);
      })
  );
});
