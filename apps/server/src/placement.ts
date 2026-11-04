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

/** What a template build was made under, which a host's copy of it needs to restore. */
export interface BuiltUnder {
  readonly id: string;
  readonly base: string;
  readonly pin: string | undefined;
  readonly image: string;
}

/**
 * Why a host's copy of `build` takes no create, if it doesn't: the host runs another runtime pin,
 * or its base names another image, than the build was made under.
 */
export const outdated = (
  info: HostInfo,
  build: BuiltUnder
): string | undefined => {
  const image = info.images[build.base] ?? build.base;

  if (info.pin !== build.pin) {
    return `runs runtime pin ${info.pin ?? "none"}, and ${build.id} was built under ${build.pin ?? "none"}`;
  }

  return image === build.image
    ? undefined
    : `names image ${image} for base ${build.base}, and ${build.id} was built from ${build.image}`;
};

/**
 * The hosts that hold one of `copies`, of `build` of `template`, by host, and can take a clone of
 * it, in config order, each with its copy, to try in turn as `placing`'s are. An outdated copy is
 * passed over. With none, a holder that gave no reply is `Unavailable`, and `NotBuilt` otherwise.
 */
export const holding = <A>(
  reached: readonly Reached[],
  copies: ReadonlyMap<string, A>,
  template: string,
  made: BuiltUnder
): Result.Result<
  Arr.NonEmptyReadonlyArray<readonly [HostInfo, A]>,
  NotBuilt | Unavailable
> => {
  const { taken, reasons, noReply } = sifted(
    reached.filter(({ member }) => copies.has(member.id)),
    (info) => {
      const copy = copies.get(info.id);
      const why = outdated(info, made);

      if (copy === undefined) {
        return Result.fail(`holds no copy of ${made.id}`);
      }

      return why === undefined
        ? Result.succeed([info, copy] as const)
        : Result.fail(`holds an outdated copy: it ${why}`);
    }
  );

  if (Arr.isReadonlyArrayNonEmpty(taken)) {
    return Result.succeed(taken);
  }

  return Result.fail(
    noReply
      ? new Unavailable({
          message: `no host that holds build ${made.id} answered: ${reasons}`,
          readOnly: true,
        })
      : new NotBuilt({
          message: `no host that holds build ${made.id} can take a clone of it${reasons === "" ? "" : `: ${reasons}`}; run clankerbox template build ${template} to build it again`,
          template,
        })
  );
};

/** Where a create may go, and what that host would make it from. */
export interface Candidate {
  readonly host: string;
  readonly source: Source;
}
