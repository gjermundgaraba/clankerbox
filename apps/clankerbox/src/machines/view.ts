import { formatGib, formatMib, Machine, stateLabel } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Schema } from "effect";
import { age } from "../units.ts";

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
];

const listColumns: typeof machineColumns = [
  ...machineColumns,
  ["ERROR", (machine) => machine.error?._tag ?? "-"],
];

export const machineRows = (machines: ReadonlyArray<Machine>, now: DateTime.Utc) => [
  listColumns.map(([label]) => label),
  ...machines.map((machine) => listColumns.map(([, cell]) => cell(machine, now))),
];

export const machineFields = (machine: Machine, now: DateTime.Utc) => {
  const { ssh } = machine;

  return [
    ...machineColumns.map(([label, cell]) => [label, cell(machine, now)]),
    ["DESIRED", machine.desired],
    ["PHASE", machine.phase],
    ["SSH", ssh === undefined ? "-" : `${ssh.user}@${ssh.host}:${ssh.port}`],
    [
      "ERROR",
      machine.error === undefined ? "-" : `${machine.error._tag}: ${machine.error.message}`,
    ],
    ["HOST_KEY", machine.hostKey ?? "-"],
  ];
};

export const encodeMachine = Schema.encodeSync(Machine);
