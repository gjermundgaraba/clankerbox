import {
  actionsByName,
  formatGib,
  formatMib,
  Invalid,
  outputLimit,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Machine } from "@gjermundgaraba/clankerbox-sdk";
import {
  Config,
  ConfigProvider,
  Console,
  Context,
  Effect,
  Option,
  Stdio,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  checkpointArgument,
  clientFlags,
  deleted,
  Exited,
  expiresFlag,
  expiring,
  fail,
  filteredListCommand,
  labelFlag,
  labelled,
  machineArgument,
  mutationFlags,
  nameArgument,
  newId,
  parsed,
  parsePairs,
  printResource,
  readStdin,
  table,
  withClient,
} from "../command.ts";
import { parseSeconds } from "../units.ts";
import { flagSizes, flagsSpec, sizeArguments, specArguments } from "./spec.ts";
import { encodeMachine, machineFields, machineRows } from "./view.ts";

export const machines = filteredListCommand({
  name: "machines",
  description:
    "List every machine, with its age, or those carrying every --label given.",
  key: "machines",
  read: (client, filter) => client.listMachines(filter),
  encode: encodeMachine,
  rows: machineRows,
});

export const getMachine = Command.make(
  "get",
  { ...clientFlags, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.getMachine({ id: flags.machine }),
      encode: encodeMachine,
      text: (machine, now) => table(machineFields(machine, now)),
    })
).pipe(
  Command.withDescription(
    `${actionsByName.getMachine.description} Prints its state, what it was asked to be and what the host is doing about it, the error its last step failed with, its SSH login and its host key.`
  )
);

const createArguments = {
  name: Argument.String("name").pipe(
    Argument.withDescription(
      "The new machine's name, unique across every host."
    )
  ),
  ...specArguments,
  label: labelFlag,
};

export const create = Command.make(
  "create",
  { ...mutationFlags, ...createArguments },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.gen(function* () {
          const spec = yield* flagsSpec("create", flags);

          return yield* client.create(
            flags.name,
            spec,
            yield* labelled(flags.label)
          );
        }),
      encode: encodeMachine,
      text: newId,
    })
).pipe(
  Command.withDescription(
    "Create a machine from a template's build, or from a base with sizes. A create runs no setup: a template's build runs one, with clankerbox template build. A create waits until its machine runs, unless --no-wait. One whose make or copy fails deletes its machine, keeps its row to say why, and fails. Prints the new ID."
  )
);

const machineState = (machine: {
  readonly id: string;
  readonly state: string;
}) => `${machine.id} ${machine.state}`;

export const start = Command.make(
  "start",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.startMachine({ id: flags.machine }),
      encode: encodeMachine,
      text: machineState,
    })
).pipe(Command.withDescription(actionsByName.startMachine.description));

export const stop = Command.make(
  "stop",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.stopMachine({ id: flags.machine }),
      encode: encodeMachine,
      text: machineState,
    })
).pipe(Command.withDescription(actionsByName.stopMachine.description));

export const pause = Command.make(
  "pause",
  {
    ...mutationFlags,
    capture: Flag.String("capture").pipe(
      Flag.withMetavar("NAME"),
      Flag.withDescription(
        "Capture the machine as checkpoint NAME too. Its traits decide when: where they capture a running machine, the capture comes first and the pause begins once it has, so the checkpoint holds the machine as it ran; where they capture a stopped one and a pause stops it, the capture takes what the pause leaves; where a pause saves it, no pause captures, and the command is refused."
      ),
      Flag.optional
    ),
    label: labelFlag,
    expires: expiresFlag,
    machine: machineArgument,
  },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.gen(function* () {
          const capture = Option.getOrUndefined(flags.capture);

          if (
            capture === undefined &&
            (flags.label.length > 0 || Option.isSome(flags.expires))
          ) {
            return yield* new Invalid({
              message:
                "--label and --expires go on the checkpoint --capture makes: give --capture NAME",
            });
          }

          return yield* client.pauseMachine({
            id: flags.machine,
            ...(capture === undefined
              ? {}
              : {
                  capture: {
                    name: capture,
                    ...(yield* labelled(flags.label)),
                    ...(yield* expiring(flags.expires)),
                  },
                }),
          });
        }),
      encode: encodeMachine,
      text: machineState,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.pauseMachine.description} --label and --expires go on the checkpoint --capture makes, and a capture that fails fails the command with its error once the machine has paused.`
  )
);

const sized = (machine: Machine) =>
  `${machine.id} ${machine.cpu} vCPUs, ${formatMib(machine.ramMib)} RAM, ${formatGib(machine.diskGib)} disk`;

export const resize = Command.make(
  "resize",
  { ...mutationFlags, ...sizeArguments, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.flatMap(flagSizes(flags), (sizes) =>
          client.resizeMachine({ id: flags.machine, ...sizes })
        ),
      encode: encodeMachine,
      text: sized,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.resizeMachine.description} Prints the sizes it then has.`
  )
);

export const deleteMachine = Command.make(
  "delete",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    withClient(flags, (client) =>
      deleted(
        flags.json,
        flags.machine,
        client.deleteMachine({ id: flags.machine })
      )
    )
).pipe(
  Command.withDescription(
    `${actionsByName.deleteMachine.description} A machine that is already gone counts as deleted.`
  )
);

export const fork = Command.make(
  "fork",
  {
    ...mutationFlags,
    ...sizeArguments,
    label: labelFlag,
    machine: machineArgument,
    name: nameArgument,
  },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.gen(function* () {
          const sizes = yield* flagSizes(flags);

          return yield* client.forkMachine({
            machine: flags.machine,
            name: flags.name,
            ...sizes,
            ...(yield* labelled(flags.label)),
          });
        }),
      encode: encodeMachine,
      text: newId,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.forkMachine.description} Prints the new ID.`
  )
);

export const restore = Command.make(
  "restore",
  {
    ...mutationFlags,
    ...sizeArguments,
    label: labelFlag,
    checkpoint: checkpointArgument,
    name: nameArgument,
  },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.gen(function* () {
          const sizes = yield* flagSizes(flags);

          return yield* client.restoreMachine({
            checkpoint: flags.checkpoint,
            name: flags.name,
            ...sizes,
            ...(yield* labelled(flags.label)),
          });
        }),
      encode: encodeMachine,
      text: newId,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.restoreMachine.description} Prints the new ID.`
  )
);

/**
 * The environment `exec --env NAME` takes NAME's value from, where a variable set empty is set,
 * unlike the CLI's own settings, which read an empty one as unset.
 */
export class Environment extends Context.Service<
  Environment,
  ConfigProvider.ConfigProvider
>()("@gjermundgaraba/clankerbox/Environment") {}

/** The process's environment as `exec --env NAME` reads it. */
export const environmentOf = (env?: Record<string, string>) =>
  ConfigProvider.fromEnv({
    ...(env === undefined ? {} : { env }),
    preserveEmptyStrings: true,
  });

const environment = (texts: readonly string[]) =>
  Effect.gen(function* () {
    const provider = yield* Environment;
    const pairs: Array<readonly [string, string]> = [];

    for (const text of texts) {
      if (text.includes("=")) {
        pairs.push(
          ...Object.entries((yield* parsePairs("--env", [text])) ?? {})
        );
      } else {
        const value = yield* Config.option(Config.String(text))
          .parse(provider)
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));

        if (Option.isNone(value)) {
          return yield* new Invalid({
            message: `--env ${text} takes ${text}'s value from this environment, which doesn't set it`,
          });
        }

        pairs.push([text, value.value]);
      }
    }

    return pairs.length === 0 ? undefined : Object.fromEntries(pairs);
  });

export const exec = Command.make(
  "exec",
  {
    ...clientFlags,
    limit: Flag.String("timeout").pipe(
      Flag.withMetavar("DURATION"),
      Flag.withDescription(
        "End the command after this long, such as 90s or 30m, and exit 124; unbounded by default."
      ),
      Flag.optional
    ),
    user: Flag.String("user").pipe(
      Flag.withDescription("The user to run it as. Default: root."),
      Flag.optional
    ),
    env: Flag.String("env").pipe(
      Flag.withMetavar("NAME[=VALUE]"),
      Flag.withDescription(
        "An environment variable for the command, with NAME's value in this environment when no VALUE is given, as a secret should be, since a VALUE given shows in this process's arguments; repeat for more."
      ),
      Flag.atLeast(0)
    ),
    stdin: Flag.Boolean("stdin").pipe(
      Flag.withDescription(
        "Send this command's stdin, read to its end, as the command's."
      ),
      Flag.withDefault(false)
    ),
    machine: machineArgument,
    program: Argument.String("program").pipe(
      Argument.withDescription("The program to run, after `--`.")
    ),
    args: Argument.String("args").pipe(
      Argument.withDescription("Its arguments."),
      Argument.variadic()
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const limit = yield* parsed(flags.limit, "--timeout", parseSeconds).pipe(
        Effect.catch(fail(flags.json))
      );

      const env = yield* environment(flags.env).pipe(
        Effect.catch(fail(flags.json))
      );

      const stdin = flags.stdin
        ? yield* readStdin.pipe(Effect.catch(fail(flags.json)))
        : undefined;

      const executed = yield* withClient(flags, (client) =>
        client.execMachine({
          id: flags.machine,
          argv: [flags.program, ...flags.args],
          ...(Option.isNone(flags.user) ? {} : { user: flags.user.value }),
          ...(env === undefined ? {} : { env }),
          ...(stdin === undefined ? {} : { stdin }),
          ...(Option.isNone(limit) ? {} : { timeoutSeconds: limit.value }),
        })
      );

      if (flags.json) {
        yield* Console.log(JSON.stringify(executed));
      } else {
        const stdio = yield* Stdio.Stdio;

        yield* Stream.run(
          Stream.make(new TextEncoder().encode(executed.output)),
          stdio.stdout()
        );

        if (executed.truncated) {
          yield* Console.error(
            `clankerbox: the output above is only its last ${outputLimit} characters`
          );
        }
      }

      if (executed.exitCode !== 0) {
        return yield* new Exited({ code: executed.exitCode });
      }
    })
).pipe(
  Command.withDescription(
    `${actionsByName.execMachine.description} Prints its output and exits with its exit code.`
  )
);
