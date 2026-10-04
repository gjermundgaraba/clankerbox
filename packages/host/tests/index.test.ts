import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { runHost } from "../src/index.ts";

test("the host role says hello with its version", async () => {
  const lines = await runHost.pipe(
    Effect.andThen(TestConsole.logLines),
    Effect.provide(TestConsole.layer),
    Effect.runPromise,
  );

  expect(lines).toEqual([`clankerbox host ${version}`]);
});
