import type { HostInfo } from "@clankerbox/host-contract";
import {
  NotOffered,
  offered,
  offers,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Result } from "effect";

import type { Reached } from "./hosts.ts";
import type { Source } from "./store.ts";

/**
 * The hosts that can take a create of `base`, in config order, to try in turn: a later one only
 * after a definite `Capacity`. With none, a host that gave no reply might have offered the base, so
 * that is `Unavailable`, and `NotOffered` otherwise, each saying why each host was passed over.
 */
export const placing = (
  reached: readonly Reached[],
  base: string
): Result.Result<
  Arr.NonEmptyReadonlyArray<HostInfo>,
  NotOffered | Unavailable
> => {
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

  if (Arr.isReadonlyArrayNonEmpty(hosts)) {
    return Result.succeed(hosts);
  }

  const reasons = misses.join("; ");

  return Result.fail(
    noReply
      ? new Unavailable({
          message: `no host answered that can take base ${base}: ${reasons}`,
          readOnly: true,
        })
      : new NotOffered({
          message: `no host offers base ${base}: ${reasons}`,
          base,
        })
  );
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
