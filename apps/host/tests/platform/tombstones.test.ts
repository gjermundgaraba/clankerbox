import { setTimeout as delay } from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import * as Tombstones from "../../src/platform/tombstones.ts";
import type { Marked } from "../../src/platform/tombstones.ts";
import { Handle } from "../../src/runtime.ts";

const instance = (n: number) => `${n}`.repeat(32);

const machine = (n: number): Marked => ({
  instance: instance(n),
  handle: Handle.make(`m-${n}`),
  checkpoints: [Handle.make(`c-${n}`)],
});

const account = (held: Marked[]) => {
  const state = { lists: 0, failing: 0 };
  const removed: Marked[] = [];

  return {
    state,
    removed,
    held,
    marked: Effect.sync(() => {
      state.lists += 1;

      return [...held];
    }),
    remove: (target: Marked) =>
      Effect.suspend(() => {
        if (state.failing > 0) {
          state.failing -= 1;

          return Effect.fail(new Internal({ message: "EBUSY" }));
        }

        removed.push(target);
        held.splice(held.indexOf(target), 1);

        return Effect.void;
      }),
  };
};

const realPause = Effect.promise(async () => {
  await delay(10);
});

const sweptOnce = (lists: () => number) =>
  Effect.gen(function* () {
    const before = lists();

    for (let tries = 0; lists() === before; tries += 1) {
      if (tries === 100) {
        return yield* Effect.die("no sweep listed the account");
      }

      yield* TestClock.adjust("30 seconds");
      yield* realPause;
    }

    yield* realPause;
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "lists nothing while it keeps no tombstone, and then deletes only a buried instance, keeping every checkpoint it holds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratch;
          const kept = machine(1);
          const late = machine(2);
          const provider = account([kept, late]);

          const tombstones = yield* Tombstones.make({
            dir,
            provider: "the fake",
            marked: provider.marked,
            remove: provider.remove,
          });

          yield* TestClock.adjust("2 minutes");

          const unburied = provider.state.lists;

          yield* tombstones.bury(late.instance);
          yield* sweptOnce(() => provider.state.lists);

          expect(unburied).toBe(0);
          expect(provider.removed).toStrictEqual([late]);
          expect(provider.held).toStrictEqual([kept]);
        })
      )
  );

  it.effect(
    "keeps a tombstone while its delete fails, and forgets it a day after the first sweep that left nothing of it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratch;
          const late = machine(2);
          const provider = account([late]);

          provider.state.failing = 3;

          const tombstones = yield* Tombstones.make({
            dir,
            provider: "the fake",
            marked: provider.marked,
            remove: provider.remove,
          });

          yield* tombstones.bury(late.instance);

          while (provider.state.failing > 0) {
            yield* sweptOnce(() => provider.state.lists);
          }

          const whileFailing = [...provider.held];

          yield* sweptOnce(() => provider.state.lists);

          const gone = [...provider.held];

          yield* TestClock.adjust("23 hours");
          yield* sweptOnce(() => provider.state.lists);

          const withinTheDay = yield* Effect.exit(
            tombstones.refuse({ name: "late", instance: late.instance })
          );

          yield* TestClock.adjust("1 hour");
          yield* sweptOnce(() => provider.state.lists);

          const listsOnceForgotten = provider.state.lists;

          yield* TestClock.adjust("10 minutes");

          expect(whileFailing).toStrictEqual([late]);
          expect(gone).toStrictEqual([]);
          expect(Exit.isFailure(withinTheDay)).toBe(true);
          expect(provider.state.lists).toBe(listsOnceForgotten);
          expect(
            Exit.isSuccess(
              yield* Effect.exit(
                tombstones.refuse({ name: "late", instance: late.instance })
              )
            )
          ).toBe(true);
        })
      )
  );

  it.effect(
    "keeps its tombstones across a restart, refusing a make of a buried instance and sweeping what lands of it",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const late = machine(2);
        const provider = account([]);

        const options = {
          dir,
          provider: "the fake",
          marked: provider.marked,
          remove: provider.remove,
        };

        const first = yield* Scope.make();

        const before = yield* Tombstones.make(options).pipe(
          Scope.provide(first)
        );

        const fresh = yield* Effect.exit(
          before.refuse({ name: "late", instance: late.instance })
        );

        yield* before.bury(late.instance);
        yield* Scope.close(first, Exit.void);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const after = yield* Tombstones.make(options);

            const remade = yield* Effect.exit(
              after.refuse({ name: "late", instance: late.instance })
            );

            provider.held.push(late);
            yield* sweptOnce(() => provider.state.lists);

            expect(Exit.isSuccess(fresh)).toBe(true);
            expect(Exit.isFailure(remade)).toBe(true);
            expect(provider.removed).toStrictEqual([late]);
          })
        );
      })
  );
});
