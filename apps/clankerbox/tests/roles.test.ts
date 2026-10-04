import * as NodeServices from "@effect/platform-node/NodeServices";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Exit, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { dispatch } from "../src/roles.ts";

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(dispatch(args));
    const output = yield* TestConsole.logLines;

    return { exit, output: output.join("\n") };
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestConsole.layer)), Effect.runPromise);

test("--version prints the version", async () => {
  const { exit, output } = await run(["--version"]);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(output).toBe(`clankerbox v${version}`);
});

test("--help shows the CLI's usage", async () => {
  const { exit, output } = await run(["--help"]);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(output).toContain("clankerbox [flags]");
});

test("host --help shows the host role's usage", async () => {
  const { exit, output } = await run(["host", "--help"]);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(output).toContain("clankerbox host [flags]");
});

test("host runs the host role", async () => {
  const { exit, output } = await run(["host"]);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(output).toBe(`clankerbox host ${version}`);
});

test("an unknown flag fails", async () => {
  const { exit } = await run(["--bogus"]);

  expect(Exit.isFailure(exit)).toBe(true);
});
