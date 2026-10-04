import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Logger } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { claimsOn } from "../src/actions.ts";
import { type NewMachine, open } from "../src/store.ts";
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

test("a release that fails after a failed check is logged, and the check's error is the reply", async () => {
  const stateDir = join(await scratch(owned), "state");
  const logged: Array<unknown> = [];

  const error = await Effect.gen(function* () {
    const store = yield* open(stateDir, "linux");

    const { claimAndCheck } = claimsOn({
      ...store,
      release: () => Effect.fail(new Internal({ message: "disk full" })),
    });

    return yield* Effect.flip(
      claimAndCheck("create", { insert: { table: "machines", record: row } }, () =>
        Effect.fail(new Precondition({ message: "no room" })),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))])),
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error).toEqual(new Precondition({ message: "no room" }));
  expect(logged).toEqual([["couldn't release the rows of a create: disk full"]]);
});
