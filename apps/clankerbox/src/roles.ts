import { runHost } from "@clankerbox/host";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Exit, Runtime, Stdio } from "effect";
import { Command, Flag } from "effect/cli";
import { clientCommands } from "./cli.ts";
import { fail } from "./output.ts";
import { ssh } from "./ssh.ts";

const host = Command.make(
  "host",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription("The host config file: its ID, runtime, address, state dir and bases."),
    ),
  },
  ({ config }) => runHost(config).pipe(Effect.catch(fail(false))),
).pipe(Command.withDescription("Run a clankerbox host, until it is stopped."));

const clankerbox = Command.make("clankerbox").pipe(
  Command.withDescription("Run machines on clankerbox hosts. `clankerbox host` runs a host."),
  Command.withSubcommands([...clientCommands, ssh, host]),
);

export const dispatch = Command.runWith(clankerbox, { version });

export const main = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, dispatch));

/**
 * How the process exits, by its arguments. The CLI exits 130 on an interrupt such as Ctrl-C,
 * the shell's convention. The host role exits 0 when a signal stops it, as its unit's stop
 * sends SIGTERM: it has shut down as asked, so a unit needs no `SuccessExitStatus`.
 */
export const teardown = (args: ReadonlyArray<string>): Runtime.Teardown =>
  args[0] === "host"
    ? (exit, onExit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? onExit(0)
          : Runtime.defaultTeardown(exit, onExit)
    : Runtime.defaultTeardown;
