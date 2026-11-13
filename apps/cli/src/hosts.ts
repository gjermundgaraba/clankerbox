import {
  CapacityReport,
  Host,
  mibPerGib,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Usage } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Console, Effect, Schema } from "effect";
import { Command } from "effect/cli";

import { clientFlags, listCommand, table, withClient } from "./command.ts";

export const hostRows = (hosts: readonly Host[]) => [
  ["ID", "STATE", "RUNTIME", "VERSION", "RUNTIME_VERSION", "BASES", "PROBLEM"],
  ...hosts.map((host) => [
    host.id,
    host.state,
    host.runtime ?? "-",
    host.version ?? "-",
    host.runtimeVersion ?? "-",
    host.bases.join(",") || "-",
    host.problem ?? "-",
  ]),
];

const resourceNames = new Map([
  ["ramMib", "ram"],
  ["runningVms", "running-vms"],
]);

const roughGib = (mib: number): string =>
  `${Math.round((mib * 10) / mibPerGib) / 10}G`;

export const usageRows = (usage: readonly Usage[]) => [
  ["HOST", "RESOURCE", "USED", "LIMIT"],
  ...usage.map((row) => {
    const amount = row.resource === "ramMib" ? roughGib : String;

    return [
      row.host,
      resourceNames.get(row.resource) ?? row.resource,
      "used" in row ? amount(row.used) : "?",
      row.limit === undefined ? "-" : amount(row.limit),
    ];
  }),
];

export const unreadNotes = (usage: readonly Usage[]): readonly string[] =>
  Arr.dedupe(usage.map(({ host }) => host)).flatMap((host) => {
    const unread = Arr.dedupe(
      usage.flatMap((row) =>
        row.host === host && "unread" in row ? row.unread : []
      )
    );

    return unread.length === 0
      ? []
      : [
          `${host} couldn't read the state of ${unread.join(", ")}, so it shows ? for what they use`,
        ];
  });

export const encodeHost = Schema.encodeSync(Host);

const encodeCapacity = Schema.encodeSync(CapacityReport);

export const hosts = listCommand({
  name: "hosts",
  description:
    "List every host, for an operator: whether it answers, with its runtime, versions and bases. With --json, each host that answers carries its runtime's traits.",
  key: "hosts",
  read: (client) => client.hosts,
  encode: encodeHost,
  rows: (answers) => hostRows(answers),
});

export const capacity = Command.make("capacity", clientFlags, (flags) =>
  withClient(flags, (client) =>
    Effect.gen(function* () {
      const report = yield* client.capacity;

      if (flags.json) {
        return yield* Console.log(JSON.stringify(encodeCapacity(report)));
      }

      yield* Console.log(table(usageRows(report.usage)));

      for (const note of unreadNotes(report.usage)) {
        yield* Console.error(`clankerbox: ${note}`);
      }

      for (const { host, state, problem } of report.unreported) {
        yield* Console.error(
          state === "incompatible"
            ? `clankerbox: host ${host} is incompatible: ${problem}`
            : `clankerbox: host ${host} didn't report its capacity: ${problem}`
        );
      }
    })
  )
).pipe(
  Command.withDescription(
    "List every host's resources, how much of each is in use, and its limit, if any, for an operator. A host refuses an action that would pass a limit."
  )
);
