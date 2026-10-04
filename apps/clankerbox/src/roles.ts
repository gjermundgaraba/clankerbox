import { runHost } from "@clankerbox/host";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Exit, Runtime, Stdio } from "effect";
import { Command } from "effect/cli";
import { clientCommands } from "./cli.ts";

const host = Command.make("host", {}, () => runHost).pipe(
  Command.withDescription("Run a clankerbox host."),
);

const clankerbox = Command.make("clankerbox").pipe(
  Command.withDescription("Run machines on clankerbox hosts. `clankerbox host` runs a host."),
  Command.withSubcommands([...clientCommands, host]),
);

export const dispatch = Command.runWith(clankerbox, { version });

export const main = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, dispatch));

/**
 * The CLI exits 0 or 1. An interrupted run, such as one stopped with Ctrl-C, exits 1 rather
 * than Effect's default of 130.
 */
export const exitCode = <A, E>(exit: Exit.Exit<A, E>): number =>
  Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause));

export const teardown: Runtime.Teardown = (exit, onExit) => onExit(exitCode(exit));
