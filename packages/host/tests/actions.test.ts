import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Capacity, type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Logger } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { claimsOn } from "../src/actions.ts";
import { Refusal } from "../src/runtime.ts";
import { type Interface, type NewMachine, open } from "../src/store.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

afterEach(() => removeScratch(owned));

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

/** Runs `use` with the claims over a store whose release fails, and what it logged. */
const withFailingRelease = async <A>(
  use: (claims: ReturnType<typeof claimsOn>, store: Interface) => Effect.Effect<A, HostError>,
) => {
  const stateDir = join(await scratch(owned), "state");
  const logged: Array<unknown> = [];

  const result = await Effect.gen(function* () {
    const store = yield* open(stateDir, "linux");

    const claims = claimsOn({
      ...store,
      release: () => Effect.fail(new Internal({ message: "disk full" })),
    });

    return yield* Effect.flip(use(claims, store));
  }).pipe(
    Effect.scoped,
    Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))])),
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  return { result, logged };
};

test("a release that fails after a failed check is logged, and the check's error is the reply", async () => {
  const { result, logged } = await withFailingRelease(({ claimAndCheck }, store) =>
    claimAndCheck(store.claim("create", { insert: { table: "machines", record: row } }), () =>
      Effect.fail(new Precondition({ message: "no room" })),
    ),
  );

  expect(result).toEqual(new Precondition({ message: "no room" }));
  expect(logged).toEqual([["couldn't release the rows of a create: disk full"]]);
});

test("a release that fails after a runtime's refusal is logged, and the refusal's error is the reply", async () => {
  const { result, logged } = await withFailingRelease(({ claimAndCheck, native }, store) =>
    Effect.flatMap(
      claimAndCheck(
        store.claim("create", { insert: { table: "machines", record: row } }),
        () => Effect.void,
      ),
      ([token]) =>
        native(
          token,
          "create linux_dev",
          Effect.fail(new Refusal({ error: new Capacity({ message: "no machine" }) })),
        ),
    ),
  );

  expect(result).toEqual(new Capacity({ message: "no machine" }));
  expect(logged).toEqual([["couldn't release the rows of a create: disk full"]]);
});
