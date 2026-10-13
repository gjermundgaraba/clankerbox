/** The checkpoint commands, and how the CLI shows a checkpoint. */
import { Checkpoint, formatMib } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Schema } from "effect";
import { Command } from "effect/cli";
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
} from "./command.ts";
import { actionLabel } from "./machines/view.ts";
import { age } from "./units.ts";

/** A checkpoint's columns: each one's label, and its cell. */
const checkpointColumns: ReadonlyArray<
  readonly [label: string, cell: (checkpoint: Checkpoint, now: DateTime.Utc) => string]
> = [
  ["ID", (checkpoint) => checkpoint.id],
  ["KIND", (checkpoint) => checkpoint.kind],
  ["MACHINE", (checkpoint) => checkpoint.machine],
  ["BASE", (checkpoint) => checkpoint.base],
  ["PROFILE", (checkpoint) => checkpoint.profile ?? "-"],
  ["AGE", (checkpoint, now) => age(checkpoint.createdAt, now)],
  ["ACTION", actionLabel],
];

export const checkpointRows = (checkpoints: ReadonlyArray<Checkpoint>, now: DateTime.Utc) => [
  checkpointColumns.map(([label]) => label),
  ...checkpoints.map((checkpoint) => checkpointColumns.map(([, cell]) => cell(checkpoint, now))),
];

/**
 * One checkpoint, a field a line: its columns, and what a row has no room for, the sizes a
 * restore gives its machine, and its action's error in full.
 */
export const checkpointFields = (checkpoint: Checkpoint, now: DateTime.Utc) => [
  ...checkpointColumns.map(([label, cell]) => [label, cell(checkpoint, now)]),
  ["CPU", String(checkpoint.cpu)],
  ["RAM", formatMib(checkpoint.ramMib)],
  ["DISK", `${checkpoint.diskGib}G`],
  ["ERROR", checkpoint.action.error?.message ?? "-"],
];

export const encodeCheckpoint = Schema.encodeSync(Checkpoint);

const capture = Command.make(
  "capture",
  { ...mutationFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.capture(flags.machine, flags.name),
      encode: encodeCheckpoint,
      text: newId,
    }),
).pipe(
  Command.withDescription(
    "Capture a checkpoint. Its kind follows the runtime: ram on smolvm, which captures only a running machine, and disk on Tart and boat. Prints its ID.",
  ),
);

const listCheckpoints = listCommand({
  name: "list",
  description: "List every host's checkpoints.",
  key: "checkpoints",
  read: (client) => client.checkpoints,
  encode: encodeCheckpoint,
  rows: checkpointRows,
});

const getCheckpoint = Command.make(
  "get",
  { ...clientFlags, checkpoint: checkpointArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.checkpoint(flags.checkpoint),
      encode: encodeCheckpoint,
      text: (checkpoint, now) => table(checkpointFields(checkpoint, now)),
    }),
).pipe(
  Command.withDescription(
    "Read one checkpoint: its machine, the sizes a restore gives, its last action and the error it failed with.",
  ),
);

const deleteCheckpoint = Command.make(
  "delete",
  { ...mutationFlags, checkpoint: checkpointArgument },
  (flags) =>
    withClient(flags, (client) =>
      deleted(flags.json, flags.checkpoint, client.deleteCheckpoint(flags.checkpoint)),
    ),
).pipe(
  Command.withDescription(
    "Delete a checkpoint. A checkpoint that is already gone counts as deleted.",
  ),
);

export const checkpoint = Command.make("checkpoint").pipe(
  Command.withDescription("Capture, list, read and delete checkpoints."),
  Command.withSubcommands([capture, listCheckpoints, getCheckpoint, deleteCheckpoint]),
);
