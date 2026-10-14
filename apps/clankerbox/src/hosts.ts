import { Host, mibPerGib, Usage } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Schema } from "effect";
import { listCommand } from "./command.ts";

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

const resourceNames = {
  cpu: "cpu",
  ramMib: "ram",
  runningVms: "running-vms",
  activeSandboxes: "active-sandboxes",
  startsPerMinute: "starts/minute",
  startsPerHour: "starts/hour",
  startsPerDay: "starts/day",
} satisfies Record<Usage["resource"], string>;

/** A tenth of a GiB: a budget is seldom a round size, and `--json` has the exact MiB. */
const roughGib = (mib: number): string => `${Math.round((mib * 10) / mibPerGib) / 10}G`;

/** `?` is a sum the host couldn't count, and `-` a resource it doesn't limit. */
export const usageRows = (usage: ReadonlyArray<Usage>) => [
  ["HOST", "RESOURCE", "USED", "LIMIT"],
  ...usage.map((row) => {
    const amount = row.resource === "ramMib" ? roughGib : String;

    return [
      row.host,
      resourceNames[row.resource],
      "used" in row ? amount(row.used) : "?",
      row.limit === undefined ? "-" : amount(row.limit),
    ];
  }),
];

/** One line a host, naming each machine once however many of its rows it left unread. */
export const unreadNotes = (usage: ReadonlyArray<Usage>): ReadonlyArray<string> =>
  Arr.dedupe(usage.map(({ host }) => host)).flatMap((host) => {
    const unread = Arr.dedupe(
      usage.flatMap((row) => (row.host === host && "unread" in row ? row.unread : [])),
    );

    return unread.length === 0
      ? []
      : [
          `${host} couldn't read the state of ${unread.join(", ")}, so it shows ? for what they use`,
        ];
  });

export const encodeHost = Schema.encodeSync(Host);

export const encodeUsage = Schema.encodeSync(Usage);

export const hosts = listCommand({
  name: "hosts",
  description: "List every host, with its runtime, versions and bases.",
  key: "hosts",
  read: (client) => client.hosts,
  encode: encodeHost,
  rows: (answers) => hostRows(answers),
});

export const capacity = listCommand({
  name: "capacity",
  description:
    "List every host's resources, how much of each is in use, and its limit, if any. A host refuses an action that would pass a limit.",
  key: "capacity",
  read: (client) => client.capacity,
  encode: encodeUsage,
  rows: (answers) => usageRows(answers),
  notes: unreadNotes,
});
