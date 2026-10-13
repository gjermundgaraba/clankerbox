import * as NodeServices from "@effect/platform-node/NodeServices";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import type { Command } from "effect/cli";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { actionCommands, clankerbox } from "../src/clankerbox.ts";
import { cli } from "./support.ts";

const commandsUnder = (command: Command.Command.Any): ReadonlyArray<Command.Command.Any> =>
  command.subcommands.flatMap(({ commands }) =>
    commands.flatMap((sub) => [sub, ...commandsUnder(sub)]),
  );

layer(NodeServices.layer)((it) => {
  it("each of the contract's actions has a command the CLI runs", () => {
    const reachable = new Set(commandsUnder(clankerbox));

    for (const command of Object.values(actionCommands)) {
      expect(reachable.has(command), command.name).toBe(true);
    }
  });

  it.effect("--version prints the version", () =>
    Effect.gen(function* () {
      const { code, stdout } = yield* cli(["--version"]);

      expect(code).toBe(0);
      expect(stdout).toBe(`clankerbox v${version}`);
    }),
  );

  it.effect("--help shows the CLI's usage", () =>
    Effect.gen(function* () {
      const { code, stdout } = yield* cli(["--help"]);

      expect(code).toBe(0);
      expect(stdout).toContain("clankerbox <subcommand> [flags]");
    }),
  );

  it.effect("host --help shows the host role's usage", () =>
    Effect.gen(function* () {
      const { code, stdout } = yield* cli(["host", "--help"]);

      expect(code).toBe(0);
      expect(stdout).toContain("clankerbox host [flags]");
      expect(stdout).toContain("--config");
    }),
  );

  it.effect("host without --config is a usage error", () =>
    Effect.gen(function* () {
      const { code, stderr } = yield* cli(["host"]);

      expect(code).toBe(1);
      expect(stderr).toContain("--config");
    }),
  );

  it.effect("host with a config it can't read says so and exits 1", () =>
    Effect.gen(function* () {
      const { code, stderr } = yield* cli([
        "host",
        "--config",
        "/nonexistent/clankerbox-host.json",
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain(
        "InvalidFile: couldn't read host config /nonexistent/clankerbox-host.json",
      );
    }),
  );

  it.effect("an unknown flag exits 1", () =>
    Effect.gen(function* () {
      const { code } = yield* cli(["--bogus"]);

      expect(code).toBe(1);
    }),
  );
});
