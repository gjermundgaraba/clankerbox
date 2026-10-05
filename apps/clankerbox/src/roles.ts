import { runHost } from "@clankerbox/host";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Exit, Runtime } from "effect";
import { Command, Flag } from "effect/cli";
import { clientCommands } from "./cli.ts";
import { fail } from "./output.ts";
import { ssh } from "./ssh.ts";

/**
 * What the process runs, as far as its exit code goes. The host role's handler marks it, so the
 * teardown reads what ran rather than the arguments, whatever global flags come before `host`.
 */
export interface Role {
  host: boolean;
}

/** Runs `effect` as the host role: an interrupt then exits 0. */
export const asHost = <A, E, R>(role: Role, effect: Effect.Effect<A, E, R>) =>
  Effect.andThen(
    Effect.sync(() => {
      role.host = true;
    }),
    effect,
  );

const host = (role: Role) =>
  Command.make(
    "host",
    {
      config: Flag.String("config").pipe(
        Flag.withDescription(
          "The host config file: its ID, runtime, address, state dir and bases.",
        ),
      ),
    },
    ({ config }) => asHost(role, runHost(config).pipe(Effect.catch(fail(false)))),
  ).pipe(Command.withDescription("Run a clankerbox host, until it is stopped."));

const clankerbox = (role: Role) =>
  Command.make("clankerbox").pipe(
    Command.withDescription("Run machines on clankerbox hosts. `clankerbox host` runs a host."),
    Command.withSubcommands([...clientCommands, ssh, host(role)]),
  );

/** Runs the command `args` names, marking `role` if it is the host. */
export const dispatch = (role: Role) => Command.runWith(clankerbox(role), { version });

/** Runs the command the process's arguments name, marking `role` if it is the host. */
export const main = (role: Role) => Command.run(clankerbox(role), { version });

/**
 * How the process exits. The CLI exits 130 on an interrupt such as Ctrl-C, the shell's
 * convention. The host role exits 0 when a signal stops it, as its unit's stop sends SIGTERM: it
 * has shut down as asked, so a unit needs no `SuccessExitStatus`.
 */
export const teardown =
  (role: Role): Runtime.Teardown =>
  (exit, onExit) =>
    role.host && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? onExit(0)
      : Runtime.defaultTeardown(exit, onExit);
