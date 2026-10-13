/** The machine commands: list, get, create, start, stop, delete, fork and restore. */
import { Prebuild } from "@gjermundgaraba/clankerbox-sdk";
import { Console, DateTime, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  checkpointArgument,
  clientFlags,
  deleted,
  listCommand,
  machineArgument,
  mutationFlags,
  nameArgument,
  newId,
  printResource,
  table,
  withClient,
} from "../command.ts";
import { age } from "../units.ts";
import { flagsRequest, specArguments } from "./spec.ts";
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
      call: (client) => client.machine(flags.machine),
      encode: encodeMachine,
      text: (machine, now) => table(machineFields(machine, now)),
    }),
).pipe(
  Command.withDescription(
    "Read one machine: its state, its last action and the error it failed with, its SSH login and its host key.",
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

/**
 * A create with a setup restores its prebuild when its host has one, and says so on stderr:
 * what a prebuild's setup installed is as old as the prebuild.
 */
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
    "Create a machine from a profile, from a base with sizes and an optional setup, or from both: each flag overrides the profile's field. With a setup, the machine is restored from the setup's prebuild when its host has one (see prebuild). A create that fails can leave its machine behind, unmade: get shows why, and delete removes it. Prints the new ID.",
  ),
);

/** What start and stop print without `--json`: the machine's ID and state. */
const machineState = (machine: { readonly id: string; readonly state: string }) =>
  `${machine.id} ${machine.state}`;

export const start = Command.make(
  "start",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.start(flags.machine),
      encode: encodeMachine,
      text: machineState,
    }),
).pipe(Command.withDescription("Start a machine. On a running machine, run preparation again."));

export const stop = Command.make("stop", { ...mutationFlags, machine: machineArgument }, (flags) =>
  printResource(flags, {
    call: (client) => client.stop(flags.machine),
    encode: encodeMachine,
    text: machineState,
  }),
).pipe(
  Command.withDescription(
    "Stop a machine: a power-off that keeps its disk and ends its processes. A stopped machine stays stopped, and the stop is still its last action.",
  ),
);

export const deleteMachine = Command.make(
  "delete",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    withClient(flags, (client) => deleted(flags.json, flags.machine, client.delete(flags.machine))),
).pipe(
  Command.withDescription("Delete a machine. A machine that is already gone counts as deleted."),
);

export const fork = Command.make(
  "fork",
  { ...mutationFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.fork(flags.machine, flags.name),
      encode: encodeMachine,
      text: newId,
    }),
).pipe(Command.withDescription("Copy a machine to a new name on its host. Prints the new ID."));

export const restore = Command.make(
  "restore",
  { ...mutationFlags, checkpoint: checkpointArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.restore(flags.checkpoint, flags.name),
      encode: encodeMachine,
      text: newId,
    }),
).pipe(
  Command.withDescription(
    "Create a machine from a checkpoint, on the checkpoint's host. Prints the new ID.",
  ),
);
