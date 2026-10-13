/** How the CLI shows a machine: its table row, its fields one a line, and its JSON. */
import { Checkpoint, formatGib, formatMib, Machine } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Schema } from "effect";
import { age } from "../units.ts";

export const actionLabel = ({ action }: Machine | Checkpoint) =>
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
  ["DISK", (machine) => formatGib(machine.diskGib)],
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

export const encodeMachine = Schema.encodeSync(Machine);
