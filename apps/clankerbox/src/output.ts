/** What the CLI prints: tables for people, and with `--json` one JSON document on stdout. */
import {
  Checkpoint,
  type ClankerboxError,
  type Client,
  Host,
  Machine,
} from "@gjermundgaraba/clankerbox-sdk";
import { Console, Data, DateTime, Duration, Effect, Runtime, Schema } from "effect";

/** A failure the CLI has already printed. The process exits with `code`. */
export class Exited extends Data.TaggedError("Exited")<{ readonly code: number }> {
  readonly [Runtime.errorReported] = false;

  get [Runtime.errorExitCode](): number {
    return this.code;
  }
}

const errorDocument = (error: ClankerboxError) => ({
  message: error.message,
  tag: error._tag,
  retryable: error.retryable,
});

/** Prints `error` (as `{error: {message, tag, retryable}}` with `--json`) and exits 1. */
export const fail = (json: boolean) => (error: ClankerboxError) =>
  Effect.andThen(
    json
      ? Console.log(JSON.stringify({ error: errorDocument(error) }))
      : Console.error(`clankerbox: ${error._tag}: ${error.message}`),
    Effect.fail(new Exited({ code: 1 })),
  );

const units: ReadonlyArray<readonly [string, number]> = [
  ["d", 86_400],
  ["h", 3600],
  ["m", 60],
];

/** How long ago `createdAt` was, in its largest whole unit: `45s`, `12m`, `5h`, `3d`. */
const age = (createdAt: DateTime.Utc, now: DateTime.Utc): string => {
  const seconds = Math.max(0, Math.floor(Duration.toSeconds(DateTime.distance(createdAt, now))));

  for (const [unit, size] of units) {
    if (seconds >= size) {
      return `${Math.floor(seconds / size)}${unit}`;
    }
  }

  return `${seconds}s`;
};

/** Left-aligned columns, two spaces apart. */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths: Array<number> = [];

  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }

  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
};

const actionLabel = ({ action }: Machine | Checkpoint) =>
  action.error === undefined
    ? `${action.name} ${action.status}`
    : `${action.name} ${action.status}: ${action.error.tag}`;

export const machineRows = (machines: ReadonlyArray<Machine>, now: DateTime.Utc) => [
  ["ID", "STATE", "BASE", "PROFILE", "CPU", "RAM_MIB", "DISK_GIB", "AGE", "ACTION", "SSH"],
  ...machines.map((machine) => [
    machine.id,
    machine.state,
    machine.base,
    machine.profile ?? "-",
    String(machine.cpu),
    String(machine.ramMib),
    String(machine.diskGib),
    age(machine.createdAt, now),
    actionLabel(machine),
    machine.ssh === undefined ? "-" : `${machine.ssh.host}:${machine.ssh.port}`,
  ]),
];

export const checkpointRows = (checkpoints: ReadonlyArray<Checkpoint>, now: DateTime.Utc) => [
  ["ID", "KIND", "MACHINE", "BASE", "AGE", "ACTION"],
  ...checkpoints.map((checkpoint) => [
    checkpoint.id,
    checkpoint.kind,
    checkpoint.machine,
    checkpoint.base,
    age(checkpoint.createdAt, now),
    actionLabel(checkpoint),
  ]),
];

export const hostRows = (hosts: ReadonlyArray<Host>) => [
  ["ID", "RUNTIME", "VERSION", "RUNTIME_VERSION", "BASES"],
  ...hosts.map((host) => [
    host.id,
    host.runtime,
    host.version,
    host.runtimeVersion,
    host.bases.join(","),
  ]),
];

export const encodeMachine = Schema.encodeSync(Machine);

export const encodeCheckpoint = Schema.encodeSync(Checkpoint);

export const encodeHost = Schema.encodeSync(Host);

/** The hosts a fan-out couldn't read, as JSON fields. */
export const unreachableDocument = (unreachable: ReadonlyArray<Client.Unreachable>) =>
  unreachable.map(({ host, error }) => ({ host, error: errorDocument(error) }));

/** Names the hosts a fan-out couldn't read, on stderr, under the table. */
export const warnUnreachable = (unreachable: ReadonlyArray<Client.Unreachable>) =>
  Effect.forEach(
    unreachable,
    ({ error }) => Console.error(`clankerbox: ${error._tag}: ${error.message}`),
    { discard: true },
  );
