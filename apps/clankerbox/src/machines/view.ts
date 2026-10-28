import {
  formatGib,
  formatMib,
  Machine,
  stateLabel,
} from "@gjermundgaraba/clankerbox-sdk";
import type { DateTime } from "effect";
import { Schema } from "effect";

import { age } from "../units.ts";

const machineColumns: ReadonlyArray<
  readonly [
    label: string,
    cell: (machine: Machine, now: DateTime.Utc) => string,
  ]
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

export const machineRows = (
  machines: readonly Machine[],
  now: DateTime.Utc
) => [
  listColumns.map(([label]) => label),
  ...machines.map((machine) =>
    listColumns.map(([, cell]) => cell(machine, now))
  ),
];

const tailnetLabel = ({ tailnet }: Machine): string => {
  if (tailnet === undefined) {
    return "-";
  }

  switch (tailnet.state) {
    case "joined": {
      return tailnet.name ?? "joined, with no MagicDNS name";
    }

    case "failed": {
      return `failed: ${tailnet.error}`;
    }

    case "missing": {
      return "missing: the guest has no tailscaled";
    }
  }
};

export const machineFields = (machine: Machine, now: DateTime.Utc) => {
  const { ssh } = machine;

  return [
    ...machineColumns.map(([label, cell]) => [label, cell(machine, now)]),
    ["DESIRED", machine.desired],
    ["PHASE", machine.phase],
    ["SSH", ssh === undefined ? "-" : `${ssh.user}@${ssh.host}:${ssh.port}`],
    [
      "ERROR",
      machine.error === undefined
        ? "-"
        : `${machine.error._tag}: ${machine.error.message}`,
    ],
    ["HOST_KEY", machine.hostKey ?? "-"],
    ["TAILNET", tailnetLabel(machine)],
  ];
};

export const encodeMachine = Schema.encodeSync(Machine);
