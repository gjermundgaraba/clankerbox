import { Host, Limit, mibPerGib } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
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

const limitNames = {
  cpu: "cpu",
  ramMib: "ram",
  runningVms: "running-vms",
  activeSandboxes: "active-sandboxes",
  startsPerMinute: "starts/minute",
  startsPerHour: "starts/hour",
  startsPerDay: "starts/day",
} satisfies Record<Limit["resource"], string>;

/** A tenth of a GiB: a budget is seldom a round size, and `--json` has the exact MiB. */
const roughGib = (mib: number): string => `${Math.round((mib * 10) / mibPerGib) / 10}G`;

/** `?` is a sum the host couldn't count, and `-` a resource it doesn't limit. */
export const limitRows = (limits: ReadonlyArray<Limit>) => [
  ["HOST", "RESOURCE", "USED", "LIMIT"],
  ...limits.map(({ host, resource, used, limit }) => {
    const amount = resource === "ramMib" ? roughGib : String;

    return [
      host,
      limitNames[resource],
      used === undefined ? "?" : amount(used),
      limit === undefined ? "-" : amount(limit),
    ];
  }),
];

/** One line a host, naming each machine once however many of its rows it left unread. */
export const unreadNotes = (limits: ReadonlyArray<Limit>): ReadonlyArray<string> => {
  const unread = new Map<string, Set<string>>();

  for (const { host, unread: ids = [] } of limits) {
    for (const id of ids) {
      unread.set(host, (unread.get(host) ?? new Set()).add(id));
    }
  }

  return [...unread].map(
    ([host, ids]) =>
      `${host} couldn't read the state of ${[...ids].join(", ")}, so it shows ? for what they use`,
  );
};

export const encodeHost = Schema.encodeSync(Host);

export const encodeLimit = Schema.encodeSync(Limit);

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
  encode: encodeLimit,
  rows: (answers) => limitRows(answers),
  notes: unreadNotes,
});
