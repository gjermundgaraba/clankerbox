import { runHost } from "@clankerbox/host";
import { Invalid, version } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Console, Effect, Exit, Option, Runtime, Stdio } from "effect";
import { CliError, Command } from "effect/cli";
import { clientCommands } from "./cli.ts";
import { fail } from "./output.ts";
import { ssh } from "./ssh.ts";

const host = Command.make("host", {}, () => runHost).pipe(
  Command.withDescription("Run a clankerbox host."),
);

const clankerbox = Command.make("clankerbox").pipe(
  Command.withDescription("Run machines on clankerbox hosts. `clankerbox host` runs a host."),
  Command.withSubcommands([...clientCommands, ssh, host]),
);

const run = Command.runWith(clankerbox, { version });

/** With `--json`, effect/cli's own error text stays off stderr: the JSON document says it. */
const runQuietly = Command.runWith(clankerbox, { version, renderErrors: false });

/** `--json` before any `--`, where it is the CLI's flag rather than one of ssh's arguments. */
const wantsJson = (args: ReadonlyArray<string>): boolean => {
  const end = args.indexOf("--");

  return (end === -1 ? args : args.slice(0, end)).includes("--json");
};

/** The parse errors of a run that stopped at a usage error, such as a missing argument. */
const usageErrors = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.findErrorOption(exit).pipe(
    Option.filter((error) => error instanceof CliError.ShowHelp),
    Option.map((help) => help.errors),
    Option.filter((errors) => errors.length > 0),
  );

/**
 * With `--json`, a usage error prints the JSON error document too. effect/cli writes the
 * help text to stdout before it fails, so stdout is held until the run ends, and a usage
 * error replaces it with the document.
 */
const runJson = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const console = yield* Console.Console;
    const held: Array<ReadonlyArray<unknown>> = [];

    // Every method but log stays the console's own: the prototype is the console itself.
    const holding: Console.Console = Object.assign(Object.create(console), {
      log: (...line: ReadonlyArray<unknown>) => {
        held.push(line);
      },
    });

    const exit = yield* Effect.exit(
      Effect.provideService(runQuietly(args), Console.Console, holding),
    );

    const usage = usageErrors(exit);

    if (Option.isSome(usage)) {
      return yield* fail(true)(
        new Invalid({ message: usage.value.map((error) => error.message).join("; ") }),
      );
    }

    yield* Effect.forEach(held, (line) => Console.log(...line), { discard: true });

    return yield* exit;
  });

export const dispatch = (args: ReadonlyArray<string>) =>
  wantsJson(args) ? runJson(args) : run(args);

export const main = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, dispatch));

/**
 * The CLI exits 0 or 1, except that `ssh` exits with ssh's code. An interrupted run, such as
 * one stopped with Ctrl-C, exits 1 rather than Effect's default of 130.
 */
export const exitCode = <A, E>(exit: Exit.Exit<A, E>): number =>
  Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause));

export const teardown: Runtime.Teardown = (exit, onExit) => onExit(exitCode(exit));
