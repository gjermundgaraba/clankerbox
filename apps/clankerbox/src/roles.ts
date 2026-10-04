import { runHost } from "@clankerbox/host";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Stdio } from "effect";
import { Command } from "effect/cli";

const cli = Command.make("clankerbox").pipe(
  Command.withDescription("Run machines on clankerbox hosts. `clankerbox host` runs a host."),
);

const host = Command.make("clankerbox").pipe(
  Command.withSubcommands([
    Command.make("host", {}, () => runHost).pipe(Command.withDescription("Run a clankerbox host.")),
  ]),
);

/** Runs the host role for `clankerbox host …` and the CLI for anything else. */
export const dispatch = (args: ReadonlyArray<string>) =>
  args[0] === "host"
    ? Command.runWith(host, { version })(args)
    : Command.runWith(cli, { version })(args);

export const main = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, dispatch));
