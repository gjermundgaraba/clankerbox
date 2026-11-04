import {
  actionsByName,
  formatGib,
  formatMib,
  Invalid,
  outputLimit,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Checkpoint,
  Client,
  Machine,
  MachineSpec,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Array,
  Console,
  DateTime,
  Effect,
  Option,
  Order,
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
import {
  flagSizes,
  flagsRequest,
  sizeArguments,
  specArguments,
} from "./spec.ts";
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
  fresh: Flag.Boolean("fresh").pipe(
    Flag.withDescription(
      "Run the setup even when a host has a prebuild of it."
    ),
    Flag.withDefault(false)
  ),
  label: labelFlag,
};

const grownFrom = (spec: MachineSpec, prebuild: Checkpoint) => [
  ...(prebuild.kind === "ram" && spec.cpu < prebuild.cpu
    ? [`${prebuild.cpu} vCPUs`]
    : []),
  ...(prebuild.kind === "ram" && spec.ramMib < prebuild.ramMib
    ? [`${formatMib(prebuild.ramMib)} of RAM`]
    : []),
  ...(spec.diskGib < prebuild.diskGib
    ? [`a ${formatGib(prebuild.diskGib)} disk`]
    : []),
];

const missedPrebuild = (client: Client.Interface, spec: MachineSpec) =>
  Effect.gen(function* () {
    const { profile } = spec;

    const listed =
      profile === undefined
        ? []
        : yield* Effect.orElseSucceed(client.checkpoints, () => []);

    const newest = Array.last(
      Array.sort(
        listed.filter(
          ({ id, base, ...checkpoint }) =>
            id.startsWith("prebuilt-") &&
            base === spec.base &&
            checkpoint.profile === profile
        ),
        Order.mapInput(DateTime.Order, ({ createdAt }: Checkpoint) => createdAt)
      )
    );

    const larger = Option.match(newest, {
      onNone: () => [],
      onSome: (prebuild) => grownFrom(spec, prebuild),
    });

    const why = Option.match(newest, {
      onNone: () => "",
      onSome: ({ id }) =>
        larger.length > 0
          ? `: ${id} of ${profile} has ${larger.join(" and ")}, more than this create`
          : `: ${id} of ${profile} is of another setup or host release`,
    });

    yield* Console.error(
      `clankerbox: no prebuild matches this create, so its setup runs${why}; clankerbox prebuild with the same flags makes one`
    );
  });

export const create = Command.make(
  "create",
  { ...mutationFlags, ...createArguments },
  (flags) =>
    printResource(flags, {
      call: (client, config) =>
        Effect.gen(function* () {
          const { spec } = yield* flagsRequest("create", flags, config);

          const machine = yield* client.create(flags.name, spec, {
            fresh: flags.fresh,
            ...(yield* labelled(flags.label)),
            recorded: ({ prebuild }) =>
              spec.setup === undefined ||
              flags.fresh ||
              flags.json ||
              prebuild !== undefined
                ? Effect.void
                : missedPrebuild(client, spec),
          });

          if (machine.prebuild !== undefined && !flags.json) {
            yield* Console.error(
              `clankerbox: restored from the prebuild ${machine.prebuild}`
            );
          }

          return machine;
        }),
      encode: encodeMachine,
      text: newId,
    })
).pipe(
  Command.withDescription(
    "Create a machine from a profile, from a base with sizes and an optional setup, or from both: each flag overrides the profile's field. With a setup, the machine is restored from the setup's prebuild when a host has one (see prebuild), and a create none serves says why on stderr as it begins. A create waits until its machine runs, unless --no-wait. One whose copy or setup fails deletes its machine, keeps its row to say why, and fails. Prints the new ID."
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
        "Capture the running machine as checkpoint NAME first, so it holds the machine as it ran; the pause begins once the capture has."
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
      Flag.withMetavar("NAME=VALUE"),
      Flag.withDescription(
        "An environment variable for the command; repeat for more."
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

      const env = yield* parsePairs("--env", flags.env).pipe(
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
