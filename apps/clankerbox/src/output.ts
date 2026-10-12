/** What the CLI prints: tables for people, and with `--json` one JSON document on stdout. */
import {
  Checkpoint,
  type ClankerboxError,
  type Client,
  formatMib,
  Host,
  Limit,
  type LoadedProfile,
  Machine,
  Profile,
} from "@gjermundgaraba/clankerbox-sdk";
import { Console, Data, DateTime, Duration, Effect, Runtime, Schema } from "effect";
import { formatSeconds, spans } from "./units.ts";

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

/** How long ago `createdAt` was, in its largest whole unit: `45s`, `12m`, `5h`, `3d`. */
export const age = (createdAt: DateTime.Utc, now: DateTime.Utc): string => {
  const seconds = Math.max(0, Math.floor(Duration.toSeconds(DateTime.distance(createdAt, now))));
  const [unit, size] = spans.find(([, span]) => seconds >= span) ?? ["s", 1];

  return `${Math.floor(seconds / size)}${unit}`;
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

/** The runtime's state, marked on a machine its create, fork or restore hasn't made. */
export const stateLabel = ({ state, made }: Machine) => (made ? state : `${state} (unmade)`);

/** A machine's columns: each one's label, and its cell. */
const machineColumns: ReadonlyArray<
  readonly [label: string, cell: (machine: Machine, now: DateTime.Utc) => string]
> = [
  ["ID", (machine) => machine.id],
  ["STATE", stateLabel],
  ["BASE", (machine) => machine.base],
  ["PROFILE", (machine) => machine.profile ?? "-"],
  ["CPU", (machine) => String(machine.cpu)],
  ["RAM", (machine) => formatMib(machine.ramMib)],
  ["DISK", (machine) => `${machine.diskGib}G`],
  ["AGE", (machine, now) => age(machine.createdAt, now)],
  ["ACTION", actionLabel],
];

export const machineRows = (machines: ReadonlyArray<Machine>, now: DateTime.Utc) => [
  machineColumns.map(([label]) => label),
  ...machines.map((machine) => machineColumns.map(([, cell]) => cell(machine, now))),
];

/**
 * One machine, a field a line: its columns, and what a row has no room for, its SSH login, its
 * action's error in full and its host key.
 */
export const machineFields = (machine: Machine, now: DateTime.Utc) => {
  const { ssh } = machine;

  return [
    ...machineColumns.map(([label, cell]) => [label, cell(machine, now)]),
    ["SSH", ssh === undefined ? "-" : `${ssh.user}@${ssh.host}:${ssh.port}`],
    ["ERROR", machine.action.error?.message ?? "-"],
    ["HOST_KEY", machine.hostKey ?? "-"],
  ];
};

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

/** What the table calls each limit; `--json` keeps the API's names. */
const limitNames = {
  ramMib: "ram",
  runningVms: "running-vms",
  activeSandboxes: "active-sandboxes",
  startsPerMinute: "starts/minute",
  startsPerHour: "starts/hour",
  startsPerDay: "starts/day",
} satisfies Record<Limit["resource"], string>;

/**
 * RAM in a limit, rounded to a tenth of a GiB: a budget is seldom a round size, and the table
 * is an overview. `--json` has the MiB.
 */
const roughGib = (mib: number): string => `${Math.round((mib * 10) / 1024) / 10}G`;

export const limitRows = (limits: ReadonlyArray<Limit>) => [
  ["HOST", "RESOURCE", "USED", "LIMIT"],
  ...limits.map(({ host, resource, used, limit }) => {
    const amount = resource === "ramMib" ? roughGib : String;

    return [host, limitNames[resource], amount(used), amount(limit)];
  }),
];

/** Each profile's fields, with its setup path as `setupPath` shows it. */
export const profileRows = (
  profiles: ReadonlyArray<LoadedProfile>,
  setupPath: (path: string) => string,
) => [
  ["NAME", "BASE", "CPU", "RAM", "DISK", "SETUP", "TIMEOUT", "HOST"],
  ...profiles.map(({ label, base, cpu, ramMib, diskGib, setup, host }) => [
    label,
    base,
    String(cpu),
    formatMib(ramMib),
    `${diskGib}G`,
    setup === undefined ? "-" : setupPath(setup.path),
    setup?.timeoutSeconds === undefined ? "-" : formatSeconds(setup.timeoutSeconds),
    host ?? "-",
  ]),
];

export const encodeMachine = Schema.encodeSync(Machine);

export const encodeCheckpoint = Schema.encodeSync(Checkpoint);

export const encodeHost = Schema.encodeSync(Host);

export const encodeLimit = Schema.encodeSync(Limit);

const encodeProfileFields = Schema.encodeSync(Profile);

/** A loaded profile as JSON: its name, then its fields, with `setup.path` resolved. */
export const encodeProfile = (profile: LoadedProfile) => ({
  name: profile.label,
  ...encodeProfileFields(profile),
});

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
