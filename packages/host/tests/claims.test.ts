import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Capacity, type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Logger } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { claimsOn } from "../src/claims.ts";
import { Refusal } from "../src/runtime.ts";
import { open } from "../src/platform/sqlite.ts";
import type { Interface, NewMachine } from "../src/store.ts";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing";

const row: NewMachine = {
  name: "dev",
  instance: "0123456789abcdef0123456789abcdef",
  native: undefined,
  createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: undefined,
  hostKey: undefined,
};

/** A create's claim of `row`, as `claimAndCheck` takes it. */
const inserting = (store: Interface) =>
  Effect.map(store.insert("create", { kind: "machine", record: row }), (token) => ({
    token,
    held: row,
  }));

const diskFull = () => Effect.fail(new Internal({ message: "disk full" }));

/** Runs `use` with the claims over a store whose `failing` write fails, and what it logged. */
const withFailing = <A>(
  failing: "release" | "end",
  use: (claims: ReturnType<typeof claimsOn>, store: Interface) => Effect.Effect<A, HostError>,
) =>
  Effect.gen(function* () {
    const stateDir = join(yield* scratch, "state");
    const logged: Array<unknown> = [];

    const result = yield* Effect.gen(function* () {
      const store = yield* open({ stateDir, id: "linux", runtime: "smolvm" });

      const claims = claimsOn({ ...store, [failing]: diskFull });

      return yield* Effect.flip(use(claims, store));
    }).pipe(
      Effect.scoped,
      Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))])),
    );

    return { result, logged };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "a release that fails after a failed check is logged, and the check's error is the reply",
    () =>
      Effect.gen(function* () {
        const { result, logged } = yield* withFailing("release", ({ claimAndCheck }, store) =>
          claimAndCheck(inserting(store), () =>
            Effect.fail(new Precondition({ message: "no room" })),
          ),
        );

        expect(result).toEqual(new Precondition({ message: "no room" }));
        expect(logged).toEqual([["couldn't release the rows of a create: disk full"]]);
      }),
  );

  it.effect(
    "a release that fails after a runtime's refusal is logged, and the refusal's error is the reply",
    () =>
      Effect.gen(function* () {
        const { result, logged } = yield* withFailing(
          "release",
          ({ claimAndCheck, native }, store) =>
            Effect.flatMap(
              claimAndCheck(inserting(store), () => Effect.void),
              ([token]) =>
                native(
                  token,
                  "create linux_dev",
                  Effect.fail(new Refusal({ error: new Capacity({ message: "no machine" }) })),
                ),
            ),
        );

        expect([result._tag, result.message]).toEqual(["Capacity", "no machine"]);
        expect(logged).toEqual([["couldn't release the rows of a create: disk full"]]);
      }),
  );

  it.effect(
    "an end that fails after a runtime's failure is logged, and the runtime's error is the reply",
    () =>
      Effect.gen(function* () {
        const { result, logged } = yield* withFailing("end", ({ claimAndCheck, native }, store) =>
          Effect.flatMap(
            claimAndCheck(inserting(store), () => Effect.void),
            ([token]) =>
              native(
                token,
                "create linux_dev",
                Effect.fail(new Capacity({ message: "no machine" })),
              ),
          ),
        );

        expect([result._tag, result.message]).toEqual(["Capacity", "no machine"]);
        expect(logged).toEqual([["couldn't record the failure of a create: disk full"]]);
      }),
  );

  it.effect(
    "a defect is logged with its cause, and the reply is Internal with its message alone",
    () =>
      Effect.gen(function* () {
        const { result, logged } = yield* withFailing(
          "release",
          ({ claimAndCheck, native }, store) =>
            Effect.flatMap(
              claimAndCheck(inserting(store), () => Effect.void),
              ([token]) => native(token, "create linux_dev", Effect.die(new Error("bad state"))),
            ),
        );

        expect(result).toEqual(
          new Internal({ message: "create linux_dev died: Error: bad state" }),
        );
        expect(logged).toHaveLength(1);
        expect(String(logged[0])).toMatch(/^create linux_dev died:\nError: bad state\n\s+at /u);
      }),
  );
});
