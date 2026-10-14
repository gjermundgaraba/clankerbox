import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Capacity, type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Logger, Option } from "effect";
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

const inserting = (store: Interface) =>
  Effect.map(store.insert("createMachine", { kind: "machine", record: row }), (token) => ({
    token,
    held: row,
  }));

const diskFull = () => Effect.fail(new Internal({ message: "disk full" }));

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
        expect(logged).toEqual([["couldn't release the rows of a createMachine: disk full"]]);
      }),
  );

  it.effect(
    "a release that fails after a runtime's refusal is logged, and the refusal's error is the reply",
    () =>
      Effect.gen(function* () {
        const { result, logged } = yield* withFailing(
          "release",
          ({ claimAndCheck, refusable }, store) =>
            Effect.flatMap(
              claimAndCheck(inserting(store), () => Effect.void),
              ([token]) =>
                refusable(
                  token,
                  "create linux_dev",
                  Effect.fail(new Refusal({ error: new Capacity({ message: "no machine" }) })),
                ),
            ),
        );

        expect([result._tag, result.message]).toEqual(["Capacity", "no machine"]);
        expect(logged).toEqual([["couldn't release the rows of a createMachine: disk full"]]);
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
        expect(logged).toEqual([["couldn't record the failure of a createMachine: disk full"]]);
      }),
  );

  it.effect(
    "a check the host's stop cuts off records the stop on its held rows, and logs nothing",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");
        const logged: Array<unknown> = [];

        const action = yield* Effect.gen(function* () {
          const store = yield* open({ stateDir, id: "linux", runtime: "smolvm" });
          const { claimAndCheck } = claimsOn(store);
          const { token } = yield* inserting(store);

          yield* store.end(token, { action: { name: "createMachine", status: "done" } });
          yield* Effect.exit(
            claimAndCheck(
              store.hold("startMachine", { kind: "machine", name: "dev" }),
              () => Effect.interrupt,
            ),
          );

          return Option.map(yield* store.find("dev"), (record) => record.action);
        }).pipe(
          Effect.scoped,
          Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))])),
        );

        expect(action).toEqual(
          Option.some({
            name: "startMachine",
            status: "failed",
            error: { tag: "Internal", message: "the host stopped during startMachine" },
          }),
        );
        expect(logged).toEqual([]);
      }),
  );

  it.effect(
    "a defect is logged with its cause, and the reply is Internal, which leaves it to the log",
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
          new Internal({ message: "create linux_dev died; the host log has why" }),
        );
        expect(logged).toHaveLength(1);
        expect(String(logged[0])).toMatch(/^create linux_dev died:\nError: bad state\n\s+at /u);
      }),
  );
});
