import { version } from "@gjermundgaraba/clankerbox-sdk";
import type { Command } from "effect/cli";
import { expect, test } from "vite-plus/test";
import { actionCommands, clankerbox } from "../src/clankerbox.ts";
import { cli } from "./support.ts";

/** Every command under `command`, at any depth. */
const commandsUnder = (command: Command.Command.Any): ReadonlyArray<Command.Command.Any> =>
  command.subcommands.flatMap(({ commands }) =>
    commands.flatMap((sub) => [sub, ...commandsUnder(sub)]),
  );

test("each of the contract's actions has a command the CLI runs", () => {
  const reachable = new Set(commandsUnder(clankerbox));

  for (const command of Object.values(actionCommands)) {
    expect(reachable.has(command), command.name).toBe(true);
  }
});

test("--version prints the version", async () => {
  const { code, stdout } = await cli(["--version"]);

  expect(code).toBe(0);
  expect(stdout).toBe(`clankerbox v${version}`);
});

test("--help shows the CLI's usage", async () => {
  const { code, stdout } = await cli(["--help"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox <subcommand> [flags]");
});

test("host --help shows the host role's usage", async () => {
  const { code, stdout } = await cli(["host", "--help"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox host [flags]");
  expect(stdout).toContain("--config");
});

test("host without --config is a usage error", async () => {
  const { code, stderr } = await cli(["host"]);

  expect(code).toBe(1);
  expect(stderr).toContain("--config");
});

test("host with a config it can't read says so and exits 1", async () => {
  const { code, stderr } = await cli(["host", "--config", "/nonexistent/clankerbox-host.json"]);

  expect(code).toBe(1);
  expect(stderr).toContain(
    "InvalidFile: couldn't read host config /nonexistent/clankerbox-host.json",
  );
});

test("an unknown flag exits 1", async () => {
  const { code } = await cli(["--bogus"]);

  expect(code).toBe(1);
});
