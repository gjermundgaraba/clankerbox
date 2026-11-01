import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import type { actionsByName } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import type { Command } from "effect/cli";
import { expect } from "vite-plus/test";

import { actionCommands, clankerbox } from "../src/clankerbox.ts";
import { cli } from "./support.ts";

const commandsUnder = (
  command: Command.Command.Any
): readonly Command.Command.Any[] =>
  command.subcommands.flatMap(({ commands }) =>
    commands.flatMap((sub) => [sub, ...commandsUnder(sub)])
  );

type Covers<Commands> = [keyof typeof actionsByName] extends [keyof Commands]
  ? true
  : false;

layer(NodeServices.layer)((it) => {
  it("the command map names every action, and a map that leaves one out doesn't compile", () => {
    const whole: Covers<typeof actionCommands> = true;
    // @ts-expect-error getCapacity is an action, and this map has no command for it
    const short: Covers<Omit<typeof actionCommands, "getCapacity">> = true;

    expect([whole, short]).toStrictEqual([true, true]);
  });

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
    })
  );

  it.effect("--help shows the CLI's usage", () =>
    Effect.gen(function* () {
      const { code, stdout } = yield* cli(["--help"]);

      expect(code).toBe(0);
      expect(stdout).toContain("clankerbox <subcommand> [flags]");
    })
  );

  it.effect(
    "host is no command: a host runs as clankerbox-host, and a client never reaches one",
    () =>
      Effect.gen(function* () {
        const { code, stderr } = yield* cli(["host", "--config", "x.json"]);

        expect(code).toBe(1);
        expect(stderr).toContain("host");
      })
  );

  it.effect("an unknown flag exits 1", () =>
    Effect.gen(function* () {
      const { code } = yield* cli(["--bogus"]);

      expect(code).toBe(1);
    })
  );
});
