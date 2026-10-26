import {
  actionsByName,
  formatGib,
  formatMib,
  Invalid,
  type Machine,
  outputLimit,
  Prebuild,
} from "@gjermundgaraba/clankerbox-sdk";
import { Console, DateTime, Duration, Effect, Option, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  checkpointArgument,
  clientFlags,
  deleted,
  Exited,
  fail,
  listCommand,
  machineArgument,
  mutationFlags,
  nameArgument,
  newId,
  parsed,
  printResource,
  table,
  withClient,
} from "../command.ts";
import { age, parseSeconds } from "../units.ts";
import { flagSizes, flagsRequest, sizeArguments, specArguments } from "./spec.ts";
import { encodeMachine, machineFields, machineRows } from "./view.ts";

export const machines = listCommand({
  name: "machines",
  description: "List every host's machines, with each machine's age.",
  key: "machines",
  read: (client) => client.machines,
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
    }),
).pipe(
  Command.withDescription(
    `${actionsByName.getMachine.description} Prints its state, what it was asked to be and what the host is doing about it, the error its last step failed with, its SSH login and its host key.`,
  ),
);

const createArguments = {
  name: Argument.String("name").pipe(
    Argument.withDescription("The new machine's name. Its ID is <host>_<name>."),
  ),
  ...specArguments,
  fresh: Flag.Boolean("fresh").pipe(
    Flag.withDescription("Run the setup even when its host has a prebuild of it."),
    Flag.withDefault(false),
  ),
};

export const create = Command.make("create", { ...mutationFlags, ...createArguments }, (flags) =>
  printResource(flags, {
    call: (client, config) =>
      Effect.gen(function* () {
        const { spec, host } = yield* flagsRequest("create", flags, config);

        const { machine, prebuild } = yield* Prebuild.create(client, flags.name, spec, {
          host,
          fresh: flags.fresh,
        });

        if (prebuild !== undefined && !flags.json) {
          yield* Console.error(
            `clankerbox: restored from the prebuild ${prebuild.id}, made ${age(prebuild.createdAt, yield* DateTime.now)} ago`,
          );
        }

        return machine;
      }),
    encode: encodeMachine,
    text: newId,
  }),
).pipe(
  Command.withDescription(
    "Create a machine from a profile, from a base with sizes and an optional setup, or from both: each flag overrides the profile's field. With a setup, the machine is restored from the setup's prebuild when its host has one (see prebuild). A create whose copy or setup fails deletes its machine and fails with why. Prints the new ID.",
  ),
);

const machineState = (machine: { readonly id: string; readonly state: string }) =>
  `${machine.id} ${machine.state}`;

export const start = Command.make(
  "start",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.startMachine({ id: flags.machine }),
      encode: encodeMachine,
      text: machineState,
    }),
).pipe(Command.withDescription(actionsByName.startMachine.description));

export const stop = Command.make("stop", { ...mutationFlags, machine: machineArgument }, (flags) =>
  printResource(flags, {
    call: (client) => client.stopMachine({ id: flags.machine }),
    encode: encodeMachine,
    text: machineState,
  }),
).pipe(Command.withDescription(actionsByName.stopMachine.description));

export const pause = Command.make(
  "pause",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.pauseMachine({ id: flags.machine }),
      encode: encodeMachine,
      text: machineState,
    }),
).pipe(Command.withDescription(actionsByName.pauseMachine.description));

const sized = (machine: Machine) =>
  `${machine.id} ${machine.cpu} vCPUs, ${formatMib(machine.ramMib)} RAM, ${formatGib(machine.diskGib)} disk`;

export const resize = Command.make(
  "resize",
  { ...mutationFlags, ...sizeArguments, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.flatMap(flagSizes(flags), (sizes) =>
          client.resizeMachine({ id: flags.machine, ...sizes }),
        ),
      encode: encodeMachine,
      text: sized,
    }),
).pipe(
  Command.withDescription(
    `${actionsByName.resizeMachine.description} Prints the sizes it then has.`,
  ),
);

export const deleteMachine = Command.make(
  "delete",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    withClient(flags, (client) =>
      deleted(flags.json, flags.machine, client.deleteMachine({ id: flags.machine })),
    ),
).pipe(
  Command.withDescription(
    `${actionsByName.deleteMachine.description} A machine that is already gone counts as deleted.`,
  ),
);

export const fork = Command.make(
  "fork",
  { ...mutationFlags, ...sizeArguments, machine: machineArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.flatMap(flagSizes(flags), (sizes) =>
          client.forkMachine({ machine: flags.machine, name: flags.name, ...sizes }),
        ),
      encode: encodeMachine,
      text: newId,
    }),
).pipe(Command.withDescription(`${actionsByName.forkMachine.description} Prints the new ID.`));

export const restore = Command.make(
  "restore",
  { ...mutationFlags, ...sizeArguments, checkpoint: checkpointArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.flatMap(flagSizes(flags), (sizes) =>
          client.restoreMachine({ checkpoint: flags.checkpoint, name: flags.name, ...sizes }),
        ),
      encode: encodeMachine,
      text: newId,
    }),
).pipe(Command.withDescription(`${actionsByName.restoreMachine.description} Prints the new ID.`));

const readStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;

  return yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
    Effect.mapError((error) => new Invalid({ message: `couldn't read stdin: ${error.message}` })),
  );
});

export const exec = Command.make(
  "exec",
  {
    ...clientFlags,
    limit: Flag.String("timeout").pipe(
      Flag.withMetavar("DURATION"),
      Flag.withDescription(
        "End the command after this long, such as 90s or 30m, and exit 124; unbounded by default.",
      ),
      Flag.optional,
    ),
    user: Flag.String("user").pipe(
      Flag.withDescription("The user to run it as. Default: root."),
      Flag.optional,
    ),
    stdin: Flag.Boolean("stdin").pipe(
      Flag.withDescription("Send this command's stdin, read to its end, as the command's."),
      Flag.withDefault(false),
    ),
    machine: machineArgument,
    program: Argument.String("program").pipe(
      Argument.withDescription("The program to run, after `--`."),
    ),
    args: Argument.String("args").pipe(
      Argument.withDescription("Its arguments."),
      Argument.variadic(),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const limit = yield* parsed(flags.limit, "--timeout", parseSeconds).pipe(
        Effect.catch(fail(flags.json)),
      );

      const stdin = flags.stdin ? yield* readStdin.pipe(Effect.catch(fail(flags.json))) : undefined;

      const answered = yield* withClient(flags, (client) =>
        client.execMachine({
          id: flags.machine,
          argv: [flags.program, ...flags.args],
          user: Option.getOrUndefined(flags.user),
          stdin,
        }),
      ).pipe(
        Effect.timeoutOption(
          Option.match(limit, { onNone: () => Duration.infinity, onSome: Duration.seconds }),
        ),
      );

      if (Option.isNone(answered)) {
        yield* Console.error(
          `clankerbox: the command ran past --timeout ${Option.getOrElse(flags.limit, () => "")} and was ended`,
        );

        return yield* new Exited({ code: 124 });
      }

      const executed = answered.value;

      if (flags.json) {
        yield* Console.log(JSON.stringify(executed));
      } else {
        const stdio = yield* Stdio.Stdio;

        yield* Stream.run(Stream.make(new TextEncoder().encode(executed.output)), stdio.stdout());

        if (executed.truncated) {
          yield* Console.error(
            `clankerbox: the output above is only its last ${outputLimit} characters`,
          );
        }
      }

      if (executed.exitCode !== 0) {
        return yield* new Exited({ code: executed.exitCode });
      }
    }),
).pipe(
  Command.withDescription(
    `${actionsByName.execMachine.description} Prints its output and exits with its exit code.`,
  ),
);
