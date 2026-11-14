import type { HostInfo } from "@clankerbox/host-contract";
import {
  buildId,
  fitted,
  formatCpu,
  formatGib,
  givenSizes,
  formatMib,
  NotBuilt,
  NotOffered,
  offered,
  offers,
  Unavailable,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Sizes } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Result } from "effect";

import type { Reached } from "./hosts.ts";
import type { BuildRow, Source } from "./store.ts";

interface Miss {
  readonly why: string;
  readonly cure?: "build" | "sizes";
}

const sized = ({ cpu, ramMib, diskGib }: Sizes) =>
  `${formatCpu(cpu)}, ${formatMib(ramMib)} of RAM and ${formatGib(diskGib)} of disk`;

const missed = (why: string): Miss => ({ why });

const unsized = (info: HostInfo, sizes: Sizes): Miss => ({
  why: `has no size class of ${sized(sizes)}, and gives ${givenSizes(info.traits)}`,
  cure: "sizes",
});

const sifted = <K, A>(
  reached: readonly Reached[],
  beforeReply: (host: string) => Result.Result<K, Miss>,
  take: (info: HostInfo, known: K) => Result.Result<A, Miss>
) => {
  const taken: A[] = [];
  const misses: string[] = [];
  const cures = new Set<Miss["cure"]>();
  let noReply = false;

  const passed = (host: string, miss: Miss) => {
    misses.push(`${host} ${miss.why}`);
    cures.add(miss.cure);
  };

  for (const { member, info, problem } of reached) {
    const known = member.draining
      ? Result.fail(missed("is draining"))
      : beforeReply(member.id);

    if (Result.isFailure(known)) {
      passed(member.id, known.failure);
    } else if (problem?.incompatible === true) {
      passed(member.id, missed(`can't be used: ${problem.message}`));
    } else if (info === undefined) {
      noReply = true;
      misses.push(`${member.id} failed: ${problem?.message ?? "no answer"}`);
    } else {
      const took = take(info, known.success);

      if (Result.isSuccess(took)) {
        taken.push(took.success);
      } else {
        passed(member.id, took.failure);
      }
    }
  }

  return { taken, reasons: misses.join("; "), noReply, cures };
};

export interface Ask {
  readonly sizes: Sizes;
  readonly host: string | undefined;
}

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
 * might have taken it, so that is `Unavailable`; a host that offers the base at other sizes makes it
 * `Unsizable`; and `NotOffered` is the rest, each saying why each host was passed over. An ask that
 * names a host is placed as if that host were the only one, and one the control plane doesn't know
 * is `NotOffered`.
 */
export const placing = (
  reached: readonly Reached[],
  base: string,
  ask: Ask
): Result.Result<
  Arr.NonEmptyReadonlyArray<HostInfo>,
  NotOffered | Unsizable | Unavailable
> => {
  const named = among(reached, ask);

  if (Result.isFailure(named)) {
    return Result.fail(new NotOffered({ message: named.failure, base }));
  }

  const { taken, reasons, noReply, cures } = sifted(
    named.success,
    () => Result.void,
    (info) => {
      if (!offers(info, base)) {
        return Result.fail(missed(`offers ${offered(info)}`));
      }

      return fitted(info.traits, ask.sizes)
        ? Result.succeed(info)
        : Result.fail(unsized(info, ask.sizes));
    }
  );

  if (Arr.isReadonlyArrayNonEmpty(taken)) {
    return Result.succeed(taken);
  }

  if (noReply) {
    return Result.fail(
      new Unavailable({
        message: `no host answered that can take base ${base}: ${reasons}`,
        readOnly: true,
      })
    );
  }

  return Result.fail(
    cures.has("sizes")
      ? new Unsizable({
          message: `no host that offers base ${base} gives the sizes asked: ${reasons}`,
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
  NotBuilt | NotOffered | Unsizable | Unavailable
> => {
  const named = among(reached, ask);

  if (Result.isFailure(named)) {
    return Result.fail(
      new NotOffered({ message: named.failure, base: made.base })
    );
  }

  const { taken, reasons, noReply, cures } = sifted(
    named.success,
    (host) => {
      const copy = copies.get(host);

      return copy === undefined
        ? Result.fail<Miss>({
            why: `holds no copy of ${made.id}`,
            cure: "build",
          })
        : Result.succeed(copy);
    },
    (info, copy) => {
      const why = outdated(info, made);

      if (why !== undefined) {
        return Result.fail<Miss>({
          why: `holds an outdated copy: it ${why}`,
          cure: "build",
        });
      }

      return fitted(info.traits, ask.sizes)
        ? Result.succeed([info, copy] as const)
        : Result.fail(unsized(info, ask.sizes));
    }
  );

  if (Arr.isReadonlyArrayNonEmpty(taken)) {
    return Result.succeed(taken);
  }

  if (noReply) {
    return Result.fail(
      new Unavailable({
        message: `no host answered that can take a clone of build ${made.id}: ${reasons}`,
        readOnly: true,
      })
    );
  }

  const advice = cures.has("build")
    ? `; run clankerbox template build on ${template}'s template file ${ask.host === undefined ? "to build it again" : `with --host ${ask.host} to build it there`}`
    : "";

  return Result.fail(
    cures.has("sizes")
      ? new Unsizable({
          message: `no host that holds a current copy of build ${made.id} gives the sizes asked: ${reasons}${advice}`,
        })
      : new NotBuilt({
          message: `no host can take a clone of build ${made.id}: ${reasons}${advice}`,
          template,
        })
  );
};

/** Where a create may go, and what that host would make it from. */
export interface Candidate {
  readonly host: string;
  readonly source: Source;
}
