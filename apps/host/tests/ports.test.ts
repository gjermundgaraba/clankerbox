import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  claimOffset,
  claimSlot,
  slotSize,
  slotsFrom,
  slotsTo,
  suitePorts,
} from "./port-slot.ts";

const ranges = () =>
  Object.entries(suitePorts).toSorted(([, a], [, b]) => a.first - b.first);

describe("the suites' ports", () => {
  it("give no two suites a port in common", () => {
    const sorted = ranges();

    const overlapping = sorted.flatMap(([name, range], index) => {
      const next = sorted[index + 1];

      return next !== undefined && next[1].first <= range.last
        ? [`${name} and ${next[0]}`]
        : [];
    });

    expect(overlapping).toStrictEqual([]);
  });

  it("lie within the run's slot, short of its claim port, but for the shared range below every slot", () => {
    const first = Number(process.env["CLANKERBOX_TEST_PORTS"]);
    const claim = first + claimOffset;

    const inPlace = (name: string, range: { first: number; last: number }) =>
      name === "shared"
        ? range.last < slotsFrom
        : range.first >= first &&
          range.last < first + slotSize &&
          (claim < range.first || claim > range.last);

    const outside = ranges().flatMap(([name, range]) =>
      inPlace(name, range) ? [] : [name]
    );

    expect([outside, first >= slotsFrom && first < slotsTo]).toStrictEqual([
      [],
      true,
    ]);
  });
});

describe("a slot of test ports", () => {
  it.live("is never one a live run holds, and frees once its run ends", () =>
    Effect.gen(function* () {
      const held = yield* Effect.promise(claimSlot);
      const next = yield* Effect.promise(claimSlot);

      expect(next.first).not.toBe(held.first);

      yield* Effect.promise(next.release);

      const again = yield* Effect.promise(claimSlot);

      yield* Effect.promise(again.release);
      yield* Effect.promise(held.release);

      expect(again.first).toBe(next.first);
    })
  );

  it.live("is never one where another process listens on a suite's port", () =>
    Effect.gen(function* () {
      const free = yield* Effect.promise(claimSlot);

      yield* Effect.promise(free.release);

      const foreign = createServer();

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          foreign.close();
        })
      );
      foreign.listen({ host: "127.0.0.1", port: free.first + 40 });
      yield* Effect.promise(async () => {
        await once(foreign, "listening");
      });

      const next = yield* Effect.promise(claimSlot);

      yield* Effect.promise(next.release);

      expect(next.first).not.toBe(free.first);
    }).pipe(Effect.scoped)
  );

  it.live("is freed when the run holding it is killed", () =>
    Effect.gen(function* () {
      const slot = new URL("port-slot.ts", import.meta.url).href;

      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const { claimSlot } = await import(${JSON.stringify(slot)}); const { first } = await claimSlot(); process.stdout.write(String(first)); setInterval(() => {}, 60_000);`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          child.kill("SIGKILL");
        })
      );

      const printing: Promise<unknown> = once(child.stdout, "data");
      const printed = yield* Effect.promise(async () => await printing);

      const claimed = Number(
        String(Array.isArray(printed) ? printed[0] : undefined)
      );

      const exited: Promise<unknown> = once(child, "exit");

      const whileHeld = yield* Effect.promise(claimSlot);

      yield* Effect.promise(whileHeld.release);

      child.kill("SIGKILL");
      yield* Effect.promise(async () => await exited);

      const afterKill = yield* Effect.promise(claimSlot);

      yield* Effect.promise(afterKill.release);

      expect([
        whileHeld.first === claimed,
        afterKill.first <= claimed,
      ]).toStrictEqual([false, true]);
    }).pipe(Effect.scoped)
  );
});
