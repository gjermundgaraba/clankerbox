import {
  Checkpoint,
  formatGib,
  formatMib,
  Machine,
  stateLabel,
} from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Schema } from "effect";
import { age } from "../units.ts";

export const actionLabel = ({ action }: Machine | Checkpoint) =>
  action.status === "failed"
    ? `${action.name} ${action.status}: ${action.error._tag}`
    : `${action.name} ${action.status}`;

export const actionError = ({ action }: Machine | Checkpoint) =>
  action.status === "failed" ? action.error.message : "-";

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

export const machineFields = (machine: Machine, now: DateTime.Utc) => {
  const { ssh } = machine;

  return [
    ...machineColumns.map(([label, cell]) => [label, cell(machine, now)]),
    ["SSH", ssh === undefined ? "-" : `${ssh.user}@${ssh.host}:${ssh.port}`],
    ["ERROR", actionError(machine)],
    ["HOST_KEY", machine.hostKey ?? "-"],
  ];
};

export const encodeMachine = Schema.encodeSync(Machine);
