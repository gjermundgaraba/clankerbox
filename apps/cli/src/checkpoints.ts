import {
  actionsByName,
  Checkpoint,
  formatGib,
  formatMib,
} from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Schema } from "effect";
import { Command } from "effect/cli";

import {
  checkpointArgument,
  clientFlags,
  deleted,
  expiresFlag,
  expiring,
  filteredListCommand,
  labelFlag,
  labelled,
  machineArgument,
  mutationFlags,
  nameArgument,
  newId,
  pairsText,
  printResource,
  table,
  withClient,
} from "./command.ts";
import { age } from "./units.ts";

const checkpointColumns: ReadonlyArray<
  readonly [
    label: string,
    cell: (checkpoint: Checkpoint, now: DateTime.Utc) => string,
  ]
> = [
  ["ID", (checkpoint) => checkpoint.id],
  ["PHASE", (checkpoint) => checkpoint.phase],
  ["KIND", (checkpoint) => checkpoint.kind],
  ["MACHINE", (checkpoint) => checkpoint.machine],
  ["BASE", (checkpoint) => checkpoint.base],
  ["AGE", (checkpoint, now) => age(checkpoint.createdAt, now)],
];

export const checkpointRows = (
  checkpoints: readonly Checkpoint[],
  now: DateTime.Utc
) => [
  checkpointColumns.map(([label]) => label),
  ...checkpoints.map((checkpoint) =>
    checkpointColumns.map(([, cell]) => cell(checkpoint, now))
  ),
];

export const checkpointFields = (checkpoint: Checkpoint, now: DateTime.Utc) => [
  ...checkpointColumns.map(([label, cell]) => [label, cell(checkpoint, now)]),
  ["CPU", String(checkpoint.cpu)],
  ["RAM", formatMib(checkpoint.ramMib)],
  ["DISK", formatGib(checkpoint.diskGib)],
  ["LABELS", pairsText(checkpoint.labels)],
  [
    "EXPIRES",
    checkpoint.expiresAt === undefined
      ? "-"
      : DateTime.formatIso(checkpoint.expiresAt),
  ],
  [
    "ERROR",
    checkpoint.error === undefined
      ? "-"
      : `${checkpoint.error._tag}: ${checkpoint.error.message}`,
  ],
];

export const encodeCheckpoint = Schema.encodeSync(Checkpoint);

export const capture = Command.make(
  "capture",
  {
    ...mutationFlags,
    label: labelFlag,
    expires: expiresFlag,
    machine: machineArgument,
    name: nameArgument,
  },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.gen(function* () {
          return yield* client.captureCheckpoint({
            machine: flags.machine,
            name: flags.name,
            ...(yield* labelled(flags.label)),
            ...(yield* expiring(flags.expires)),
          });
        }),
      encode: encodeCheckpoint,
      text: newId,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.captureCheckpoint.description} Prints its ID.`
  )
);

export const listCheckpoints = filteredListCommand({
  name: "list",
  description: "List every checkpoint, or those carrying every --label given.",
  key: "checkpoints",
  read: (client, filter) => client.listCheckpoints(filter),
  encode: encodeCheckpoint,
  rows: checkpointRows,
});

export const getCheckpoint = Command.make(
  "get",
  { ...clientFlags, checkpoint: checkpointArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.getCheckpoint({ id: flags.checkpoint }),
      encode: encodeCheckpoint,
      text: (checkpoint, now) => table(checkpointFields(checkpoint, now)),
    })
).pipe(
  Command.withDescription(
    `${actionsByName.getCheckpoint.description} Prints its machine and the sizes a restore gives.`
  )
);

export const deleteCheckpoint = Command.make(
  "delete",
  { ...mutationFlags, checkpoint: checkpointArgument },
  (flags) =>
    withClient(flags, (client) =>
      deleted(
        flags.json,
        flags.checkpoint,
        client.deleteCheckpoint({ id: flags.checkpoint })
      )
    )
).pipe(
  Command.withDescription(
    `${actionsByName.deleteCheckpoint.description} A checkpoint that is already gone counts as deleted.`
  )
);

export const checkpoint = Command.make("checkpoint").pipe(
  Command.withDescription("Capture, list, read and delete checkpoints."),
  Command.withSubcommands([
    capture,
    listCheckpoints,
    getCheckpoint,
    deleteCheckpoint,
  ])
);
