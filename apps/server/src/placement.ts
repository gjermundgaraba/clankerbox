import type { HostInfo } from "@clankerbox/host-contract";
import { offered, offers } from "@gjermundgaraba/clankerbox-sdk";

import type { Reached } from "./hosts.ts";
import type { Source } from "./store.ts";

export interface Placed {
  /** The hosts to try, in order. A later one is tried only after a definite `Capacity`. */
  readonly hosts: readonly HostInfo[];
  /** Why each host that was passed over was. */
  readonly misses: readonly string[];
  /** A host gave no reply, so a host that can't be read might have offered the base. */
  readonly noReply: boolean;
}

/** The hosts that can take a create of `base`, in config order. */
export const placing = (reached: readonly Reached[], base: string): Placed => {
  const hosts: HostInfo[] = [];
  const misses: string[] = [];
  let noReply = false;

  for (const { member, info, problem } of reached) {
    if (info === undefined) {
      noReply = true;
      misses.push(`${member.id} failed: ${problem ?? "no answer"}`);
    } else if (member.draining) {
      misses.push(`${member.id} is draining`);
    } else if (offers(info, base)) {
      hosts.push(info);
    } else {
      misses.push(`${member.id} offers ${offered(info)}`);
    }
  }

  return { hosts, misses, noReply };
};

/** Prefers the hosts `holding` a prebuild, which keeps config order otherwise. */
export const preferring = (
  hosts: readonly HostInfo[],
  holding: ReadonlySet<string>
): readonly HostInfo[] => [
  ...hosts.filter(({ id }) => holding.has(id)),
  ...hosts.filter(({ id }) => !holding.has(id)),
];

export interface Candidate {
  readonly host: string;
  readonly source: Source;
  readonly prebuild: string | undefined;
}

/** Where a create may go, in order, and what each host would make it from. */
export const candidatesFor = (
  hosts: readonly HostInfo[],
  prebuilds: ReadonlyMap<string, string>,
  scripted: boolean
): readonly Candidate[] =>
  preferring(hosts, new Set(prebuilds.keys())).map(({ id }) => {
    const prebuilt = prebuilds.get(id);

    return {
      host: id,
      source:
        prebuilt === undefined
          ? { kind: "base", scripted }
          : { kind: "checkpoint", name: prebuilt },
      prebuild: prebuilt,
    };
  });
