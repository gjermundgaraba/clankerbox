import type { HostInfo } from "@clankerbox/host-contract";
import {
  buildId,
  fitted,
  formatGib,
  formatMib,
  NotBuilt,
  NotOffered,
  offered,
  offers,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Sizes } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Result } from "effect";

import type { Reached } from "./hosts.ts";
import type { BuildRow, Source } from "./store.ts";

interface Miss {
  readonly why: string;
  readonly buildCures: boolean;
}

const missed = (why: string): Miss => ({ why, buildCures: false });

const sifted = <K, A>(
  reached: readonly Reached[],
  beforeReply: (host: string) => Result.Result<K, Miss>,
  take: (info: HostInfo, known: K) => Result.Result<A, Miss>
) => {
  const taken: A[] = [];
  const misses: string[] = [];
  let noReply = false;
  let buildCures = false;

  const passed = (host: string, miss: Miss) => {
    misses.push(`${host} ${miss.why}`);
    buildCures ||= miss.buildCures;
  };

  for (const { member, info, problem } of reached) {
    const known = member.draining
      ? Result.fail(missed("is draining"))
      : beforeReply(member.id);

    if (Result.isFailure(known)) {
      passed(member.id, known.failure);
    } else if (info === undefined) {
      noReply = true;
      misses.push(`${member.id} failed: ${problem ?? "no answer"}`);
    } else {
      const took = take(info, known.success);

      if (Result.isSuccess(took)) {
        taken.push(took.success);
      } else {
        passed(member.id, took.failure);
      }
    }
  }

  return { taken, reasons: misses.join("; "), noReply, buildCures };
};

export interface Ask {
  readonly sizes: Sizes;
  readonly host: string | undefined;
}

const sized = ({ cpu, ramMib, diskGib }: Sizes) =>
  `${cpu} vCPUs, ${formatMib(ramMib)} of RAM and ${formatGib(diskGib)} of disk`;

const among = (
  reached: readonly Reached[],
  { host }: Ask
): Result.Result<readonly Reached[], string> => {
  if (host === undefined) {
    return Result.succeed(reached);
  }

  const named = reached.filter(({ member }) => member.id === host);

  return named.length === 0
    ? Result.fail(`the control plane knows no host ${host}`)
    : Result.succeed(named);
};

/**
 * The hosts that can take a create of `base` at the sizes asked, in config order, to try in turn: a
 * later one only after a definite `Capacity`. With none, a host not draining that gave no reply
 * might have offered the base, so that is `Unavailable`, and `NotOffered` otherwise, each saying
 * why each host was passed over. An ask that names a host is placed as if that host were the only
 * one.
 */
export const placing = (
  reached: readonly Reached[],
  base: string,
  ask: Ask
): Result.Result<
  Arr.NonEmptyReadonlyArray<HostInfo>,
  NotOffered | Unavailable
> => {
  const named = among(reached, ask);

  if (Result.isFailure(named)) {
    return Result.fail(
      new NotOffered({
        message: `no host offers base ${base}: ${named.failure}`,
        base,
      })
    );
  }

  const { taken, reasons, noReply } = sifted(
    named.success,
    () => Result.void,
    (info) => {
      if (!offers(info, base)) {
        return Result.fail(missed(`offers ${offered(info)}`));
      }

      return fitted(info.traits, ask.sizes)
        ? Result.succeed(info)
        : Result.fail(missed(`has no size class of ${sized(ask.sizes)}`));
    }
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

export interface BuiltUnder extends Pick<
  BuildRow,
  "base" | "pin" | "image" | keyof Sizes
> {
  readonly id: string;
}

export const builtUnder = (
  template: string,
  { number, base, pin, image, cpu, ramMib, diskGib }: BuildRow
): BuiltUnder => ({
  id: buildId(template, number),
  base,
  pin,
  image,
  cpu,
  ramMib,
  diskGib,
});

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
 * it at the sizes asked, in config order, each with its copy, to try in turn as `placing`'s are. An
 * outdated copy is passed over. With none, a holder not draining that gave no reply is
 * `Unavailable`, and `NotBuilt` otherwise, saying why each host was passed over, and to build the
 * template again where a host lacks a copy or holds an outdated one. An ask that names a host is
 * placed as if that host were the only one, a build included, and one the control plane doesn't
 * know is `NotOffered`.
 */
export const holding = <A>(
  reached: readonly Reached[],
  copies: ReadonlyMap<string, A>,
  template: string,
  made: BuiltUnder,
  ask: Ask
): Result.Result<
  Arr.NonEmptyReadonlyArray<readonly [HostInfo, A]>,
  NotBuilt | NotOffered | Unavailable
> => {
  const named = among(reached, ask);

  if (Result.isFailure(named)) {
    return Result.fail(
      new NotOffered({
        message: `no host can take a clone of build ${made.id}: ${named.failure}`,
        base: made.base,
      })
    );
  }

  const { taken, reasons, noReply, buildCures } = sifted(
    named.success,
    (host) => {
      const copy = copies.get(host);

      return copy === undefined
        ? Result.fail({ why: `holds no copy of ${made.id}`, buildCures: true })
        : Result.succeed(copy);
    },
    (info, copy) => {
      const why = outdated(info, made);

      if (why !== undefined) {
        return Result.fail({
          why: `holds an outdated copy: it ${why}`,
          buildCures: true,
        });
      }

      return fitted(info.traits, ask.sizes)
        ? Result.succeed([info, copy] as const)
        : Result.fail(missed(`has no size class of ${sized(ask.sizes)}`));
    }
  );

  if (Arr.isReadonlyArrayNonEmpty(taken)) {
    return Result.succeed(taken);
  }

  const advice =
    ask.host === undefined
      ? `; run clankerbox template build on ${template}'s template file to build it again`
      : `; run clankerbox template build on ${template}'s template file with --host ${ask.host} to build it there`;

  return Result.fail(
    noReply
      ? new Unavailable({
          message: `no host answered that can take a clone of build ${made.id}: ${reasons}`,
          readOnly: true,
        })
      : new NotBuilt({
          message: `no host can take a clone of build ${made.id}: ${reasons}${buildCures ? advice : ""}`,
          template,
        })
  );
};

/** Where a create may go, and what that host would make it from. */
export interface Candidate {
  readonly host: string;
  readonly source: Source;
}
