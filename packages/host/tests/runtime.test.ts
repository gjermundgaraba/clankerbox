import { it } from "@effect/vitest";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { machineReadWait, type MachineRef, type Observed, observeEach } from "../src/runtime.ts";

const ref = (name: string): MachineRef => ({
  id: `linux_${name}`,
  name,
  instance: name.padStart(32, "0"),
  native: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: undefined,
});

const machines = ["a", "b", "c", "d"].map(ref);

it.effect("each machine's state comes back in the machines' order", () =>
  Effect.gen(function* () {
    const states: ReadonlyArray<Observed["state"]> = ["running", "stopped", "missing", "running"];

    const observed = yield* observeEach(
      machines,
      (machine) =>
        Effect.succeed({ state: states[machines.indexOf(machine)] ?? "unknown" } as const),
      { warn: () => Effect.void },
    );

    expect(observed.map(({ state }) => state)).toEqual(states);
  }),
);

it.effect("a read that fails reads unknown, warns why, and leaves the others", () =>
  Effect.gen(function* () {
    const warned: Array<string> = [];

    const observed = yield* observeEach(
      machines,
      (machine) =>
        machine.name === "b"
          ? Effect.fail(new Internal({ message: "tart list exited 1" }))
          : Effect.succeed({ state: "running" } as const),
      { warn: (message) => Effect.sync(() => warned.push(message)) },
    );

    expect(observed.map(({ state }) => state)).toEqual([
      "running",
      "unknown",
      "running",
      "running",
    ]);
    expect(warned).toEqual(["couldn't read linux_b's state: tart list exited 1"]);
  }),
);

it.effect(
  "a read that takes over machineReadWait reads unknown, and the others don't wait on it",
  () =>
    Effect.gen(function* () {
      const warned: Array<string> = [];

      const fiber = yield* Effect.forkChild(
        observeEach(
          machines,
          (machine) =>
            machine.name === "c" ? Effect.never : Effect.succeed({ state: "stopped" } as const),
          { warn: (message) => Effect.sync(() => warned.push(message)) },
        ),
      );

      yield* TestClock.adjust(machineReadWait);

      const observed = yield* Fiber.join(fiber);

      expect(observed.map(({ state }) => state)).toEqual([
        "stopped",
        "stopped",
        "unknown",
        "stopped",
      ]);
      expect(warned).toEqual([
        `couldn't read linux_c's state: no answer within ${Duration.format(machineReadWait)}`,
      ]);
    }),
);

it.effect("no more than `concurrency` reads run at once", () =>
  Effect.gen(function* () {
    let running = 0;
    let most = 0;

    yield* observeEach(
      machines,
      () =>
        Effect.gen(function* () {
          running += 1;
          most = Math.max(most, running);

          yield* Effect.yieldNow;

          running -= 1;

          return { state: "running" } as const;
        }),
      { concurrency: 2, warn: () => Effect.void },
    );

    expect(most).toBe(2);
  }),
);
