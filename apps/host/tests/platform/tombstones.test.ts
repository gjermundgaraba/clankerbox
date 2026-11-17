import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Internal, RuntimeName } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { tombstoned } from "../../src/platform/tombstones.ts";
import type { MarkedMachine } from "../../src/platform/tombstones.ts";
import { Handle } from "../../src/runtime.ts";
import type { Target } from "../../src/runtime.ts";

const instance = (n: number) => `${n}`.repeat(32);

const machine = (n: number): MarkedMachine => ({
  instance: instance(n),
  handle: Handle.make(`m-${n}`),
  checkpoints: [Handle.make(`c-${n}`)],
});

const sizes = { cpu: 1, ramMib: 1024, diskGib: 8 };

const identity = (n: number) => ({ name: `m${n}`, instance: instance(n) });

const account = (held: MarkedMachine[]) => {
  const state = { lists: 0, failing: 0, made: 0 };
  const deleted: Array<{ handle: Handle; kept: Handle[] }> = [];

  return {
    state,
    deleted,
    held,
    marked: Effect.sync(() => {
      state.lists += 1;

      return [...held];
    }),
    runtime: {
      traits: { runtime: RuntimeName.make("fake") },
      make: () =>
        Effect.sync(() => {
          state.made += 1;

          return { handle: Handle.make("made"), sizes };
        }),
      delete: (
        target: Target & { handle: Handle },
        keep: ReadonlySet<Handle>
      ) =>
        Effect.suspend(() => {
          if (state.failing > 0) {
            state.failing -= 1;

            return Effect.fail(new Internal({ message: "EBUSY" }));
          }

          deleted.push({ handle: target.handle, kept: [...keep] });

          const at = held.findIndex(({ handle }) => handle === target.handle);

          if (at !== -1) {
            held.splice(at, 1);
          }

          return Effect.void;
        }),
    },
  };
};

const origin = { _tag: "image", image: "debian" } as const;

layer(NodeServices.layer)((it) => {
  it.effect(
    "lists nothing while it keeps no tombstone, and then deletes only a buried instance, keeping every checkpoint it holds",
    () =>
      Effect.gen(function* () {
        const kept = machine(1);
        const late = machine(2);
        const provider = account([kept, late]);

        const { runtime, sweep } = yield* tombstoned(provider.runtime, {
          dir: yield* scratch,
          marked: provider.marked,
        });

        yield* sweep;

        const unburied = provider.state.lists;

        yield* runtime.delete({ ...identity(2), handle: undefined }, new Set());
        yield* sweep;

        expect(unburied).toBe(0);
        expect(provider.deleted).toStrictEqual([
          { handle: late.handle, kept: late.checkpoints },
        ]);
        expect(provider.held).toStrictEqual([kept]);
      })
  );

  it.effect(
    "buries only once the inner delete has answered, and a second burial changes nothing",
    () =>
      Effect.gen(function* () {
        const late = machine(2);
        const provider = account([]);

        const { runtime, sweep } = yield* tombstoned(provider.runtime, {
          dir: yield* scratch,
          marked: provider.marked,
        });

        provider.state.failing = 1;

        const failed = yield* Effect.exit(
          runtime.delete({ ...identity(2), handle: late.handle }, new Set())
        );

        const unburied = yield* Effect.exit(
          runtime.make({ ...identity(2), ...sizes }, origin, 22)
        );

        yield* runtime.delete({ ...identity(2), handle: undefined }, new Set());
        yield* TestClock.adjust("23 hours");
        yield* runtime.delete({ ...identity(2), handle: undefined }, new Set());
        yield* TestClock.adjust("1 hour");
        yield* sweep;

        expect(Exit.isFailure(failed)).toBe(true);
        expect(Exit.isSuccess(unburied)).toBe(true);
        expect(
          Exit.isSuccess(
            yield* Effect.exit(
              runtime.make({ ...identity(2), ...sizes }, origin, 22)
            )
          )
        ).toBe(true);
        expect(provider.state.made).toBe(2);
      })
  );

  it.effect(
    "keeps a tombstone past its day while the latest sweep still listed its machine, and forgets it at the first whose list finds nothing",
    () =>
      Effect.gen(function* () {
        const late = machine(2);
        const provider = account([]);

        const { runtime, sweep } = yield* tombstoned(provider.runtime, {
          dir: yield* scratch,
          marked: provider.marked,
        });

        const made = (n: number) =>
          Effect.exit(runtime.make({ ...identity(n), ...sizes }, origin, 22));

        yield* runtime.delete({ ...identity(2), handle: undefined }, new Set());
        yield* TestClock.adjust("25 hours");

        provider.held.push(late);
        provider.state.failing = 1;
        yield* sweep;

        const whileFailing = yield* made(2);

        yield* sweep;

        const onceDeleted = yield* made(2);

        yield* sweep;

        const listsOnceForgotten = provider.state.lists;

        yield* sweep;

        expect(Exit.isFailure(whileFailing)).toBe(true);
        expect(Exit.isFailure(onceDeleted)).toBe(true);
        expect(provider.held).toStrictEqual([]);
        expect(Exit.isSuccess(yield* made(2))).toBe(true);
        expect(provider.state.lists).toBe(listsOnceForgotten);
      })
  );

  it.effect(
    "keeps its tombstones across a restart, refusing a make of a buried instance and sweeping what lands of it",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const late = machine(2);
        const provider = account([]);

        const before = yield* tombstoned(provider.runtime, {
          dir,
          marked: provider.marked,
        });

        yield* before.runtime.delete(
          { ...identity(2), handle: undefined },
          new Set()
        );

        const after = yield* tombstoned(provider.runtime, {
          dir,
          marked: provider.marked,
        });

        const remade = yield* Effect.exit(
          after.runtime.make({ ...identity(2), ...sizes }, origin, 22)
        );

        provider.held.push(late);
        yield* after.sweep;

        expect(Exit.isFailure(remade)).toBe(true);
        expect(provider.state.made).toBe(0);
        expect(provider.held).toStrictEqual([]);
      })
  );
});
