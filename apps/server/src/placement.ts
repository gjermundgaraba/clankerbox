import type { HostInfo } from "@clankerbox/host-contract";
import {
  NotBuilt,
  NotOffered,
  offered,
  offers,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Result } from "effect";

import type { Reached } from "./hosts.ts";
import type { Source } from "./store.ts";

const sifted = <A>(
  reached: readonly Reached[],
  take: (info: HostInfo) => Result.Result<A, string>
) => {
  const taken: A[] = [];
  const misses: string[] = [];
  let noReply = false;

  for (const { member, info, problem } of reached) {
    if (info === undefined) {
      noReply = true;
      misses.push(`${member.id} failed: ${problem ?? "no answer"}`);
    } else if (member.draining) {
      misses.push(`${member.id} is draining`);
    } else {
      const took = take(info);

      if (Result.isSuccess(took)) {
        taken.push(took.success);
      } else {
        misses.push(`${member.id} ${took.failure}`);
      }
    }
  }

  return { taken, reasons: misses.join("; "), noReply };
};

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
  const { taken, reasons, noReply } = sifted(reached, (info) =>
    offers(info, base)
      ? Result.succeed(info)
      : Result.fail(`offers ${offered(info)}`)
  );

  if (Arr.isReadonlyArrayNonEmpty(taken)) {
    return Result.succeed(taken);
  }

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

export const holding = <A>(
  reached: readonly Reached[],
  copies: ReadonlyMap<string, A>,
  template: string,
  build: string
): Result.Result<
  Arr.NonEmptyReadonlyArray<readonly [HostInfo, A]>,
  NotBuilt | Unavailable
> => {
  const { taken, reasons, noReply } = sifted(
    reached.filter(({ member }) => copies.has(member.id)),
    (info) => {
      const copy = copies.get(info.id);

      return copy === undefined
        ? Result.fail(`holds no copy of ${build}`)
        : Result.succeed([info, copy] as const);
    }
  );

  if (Arr.isReadonlyArrayNonEmpty(taken)) {
    return Result.succeed(taken);
  }

  return Result.fail(
    noReply
      ? new Unavailable({
          message: `no host that holds build ${build} answered: ${reasons}`,
          readOnly: true,
        })
      : new NotBuilt({
          message: `no host that holds build ${build} can take a clone of it${reasons === "" ? "" : `: ${reasons}`}; run clankerbox template build ${template} to build it again`,
          template,
        })
  );
};

/** Where a create may go, and what that host would make it from. */
export interface Candidate {
  readonly host: string;
  readonly source: Source;
}
