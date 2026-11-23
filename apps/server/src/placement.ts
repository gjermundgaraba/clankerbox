import type { HostInfo } from "@clankerbox/host-contract";
import {
  fitted,
  formatSizes,
  givenSizes,
  offered,
  offers,
} from "@clankerbox/host-contract/traits";
import {
  buildId,
  NotBuilt,
  NotOffered,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import type { RuntimeName, Sizes } from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Array as Arr, Result } from "effect";

import { phaseOf as copyPhaseOf } from "./checkpoint-chart.ts";
import type { CheckpointRow } from "./checkpoint-chart.ts";
import type { Reached } from "./hosts.ts";
import type { BuildRow, Source } from "./store.ts";

interface Miss {
  readonly why: string;
  readonly cure?: "build" | "sizes";
}

const missed = (why: string): Miss => ({ why });

const unsized = (info: HostInfo, sizes: Sizes): Miss => ({
  why:
    info.traits.sizes._tag === "classes"
      ? `has no size class of ${formatSizes(sizes)}, and gives ${givenSizes(info.traits)}`
      : `gives ${givenSizes(info.traits)}, not ${formatSizes(sizes)}`,
  cure: "sizes",
});

const sifted = <K, A>(
  reached: readonly Reached[],
  beforeReply: (host: Reached) => Result.Result<K, Miss>,
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

  for (const each of reached) {
    const { member, info, problem } = each;

    const known = member.draining
      ? Result.fail(missed("is draining"))
      : beforeReply(each);

    if (Result.isFailure(known)) {
      passed(member.id, known.failure);
    } else if (problem?._tag === "Incompatible") {
      passed(member.id, missed(`can't be used: ${problem.message}`));
    } else if (info === undefined) {
      noReply = true;
      misses.push(`${member.id} failed: ${problem.message}`);
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
  readonly tailnet: boolean;
}

export const unjoined = (
  info: HostInfo,
  { tailnet }: Pick<Ask, "tailnet">
): Miss | undefined =>
  tailnet && !info.joins
    ? missed("joins no machine to the tailnet")
    : undefined;

export const unjoinedCopy = (
  info: HostInfo,
  from: { readonly base: string; readonly tailnet: boolean },
  source: string
): NotOffered | undefined => {
  const miss = unjoined(info, from);

  return miss === undefined
    ? undefined
    : new NotOffered({
        message: `${source} requests the tailnet, as its copy would, and its host ${info.id} ${miss.why}`,
        base: from.base,
      });
};

const onTailnet = ({ tailnet }: Ask) => (tailnet ? " on the tailnet" : "");

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

export const placing = (
  reached: readonly Reached[],
  base: string,
  runtime: RuntimeName,
  ask: Ask
): Result.Result<
  Arr.NonEmptyReadonlyArray<HostInfo>,
  NotOffered | Unsizable | Action.Unavailable
> => {
  const named = among(reached, ask);

  if (Result.isFailure(named)) {
    return Result.fail(new NotOffered({ message: named.failure, base }));
  }

  const { taken, reasons, noReply, cures } = sifted(
    named.success,
    () => Result.void,
    (info) => {
      if (info.traits.runtime !== runtime) {
        return Result.fail(missed(`runs ${info.traits.runtime}`));
      }

      if (!offers(info, base)) {
        return Result.fail(missed(`offers ${offered(info)}`));
      }

      const off = unjoined(info, ask);

      if (off !== undefined) {
        return Result.fail(off);
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
      new Action.Unavailable({
        message: `no ${runtime} host answered that can take base ${base}${onTailnet(ask)}: ${reasons}`,
      })
    );
  }

  return Result.fail(
    cures.has("sizes")
      ? new Unsizable({
          message: `no ${runtime} host that offers base ${base}${onTailnet(ask)} gives the sizes asked: ${reasons}`,
        })
      : new NotOffered({
          message: `no ${runtime} host offers base ${base}${onTailnet(ask)}: ${reasons}`,
          base,
        })
  );
};

export interface BuiltUnder extends Pick<
  BuildRow,
  "base" | "pin" | "image" | "tailnet" | keyof Sizes
> {
  readonly id: string;
}

export const builtUnder = (
  template: string,
  { number, base, pin, image, tailnet, cpu, ramMib, diskGib }: BuildRow
): BuiltUnder => ({
  id: buildId(template, number),
  base,
  pin,
  image,
  tailnet,
  cpu,
  ramMib,
  diskGib,
});

export const imageOf = (info: HostInfo, base: string): string =>
  info.images[base] ?? base;

export const outdated = (
  info: HostInfo,
  build: BuiltUnder
): string | undefined => {
  const image = imageOf(info, build.base);

  if (info.pin !== build.pin) {
    return `runs runtime pin ${info.pin ?? "none"}, and ${build.id} was built under ${build.pin ?? "none"}`;
  }

  return image === build.image
    ? undefined
    : `names image ${image} for base ${build.base}, and ${build.id} was built from ${build.image}`;
};

const unreadyCopy = (
  made: BuiltUnder,
  { state, error }: Pick<CheckpointRow, "state" | "error">
): Miss =>
  copyPhaseOf(state) === "failed"
    ? {
        why: `holds a copy of ${made.id} that failed: ${error?.message ?? "it ended"}`,
        cure: "build",
      }
    : missed(`holds a copy of ${made.id} that isn't ready yet`);

export const holding = <A>(
  reached: readonly Reached[],
  copies: ReadonlyMap<string, A>,
  template: string,
  made: BuiltUnder,
  ask: Ask,
  unready: ReadonlyMap<string, Pick<CheckpointRow, "state" | "error">>
): Result.Result<
  Arr.NonEmptyReadonlyArray<readonly [HostInfo, A]>,
  NotBuilt | NotOffered | Unsizable | Action.Unavailable
> => {
  const named = among(reached, ask);

  if (Result.isFailure(named)) {
    return Result.fail(
      new NotOffered({ message: named.failure, base: made.base })
    );
  }

  const { taken, reasons, noReply, cures } = sifted(
    named.success,
    ({ member, info }) => {
      const copy = copies.get(member.id);
      const other = unready.get(member.id);
      const off = info === undefined ? undefined : unjoined(info, ask);

      if (off !== undefined) {
        return Result.fail(off);
      }

      if (copy !== undefined) {
        return Result.succeed(copy);
      }

      return Result.fail<Miss>(
        other === undefined
          ? { why: `holds no copy of ${made.id}`, cure: "build" }
          : unreadyCopy(made, other)
      );
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
      new Action.Unavailable({
        message: `no host answered that can take a clone of build ${made.id}${onTailnet(ask)}: ${reasons}`,
      })
    );
  }

  const advice = cures.has("build")
    ? `; run clankerbox template build on ${template}'s template file ${ask.host === undefined ? "to build it again" : `with --host ${ask.host} to build it there`}`
    : "";

  return Result.fail(
    cures.has("sizes")
      ? new Unsizable({
          message: `no host that holds a current copy of build ${made.id}${onTailnet(ask)} gives the sizes asked: ${reasons}${advice}`,
        })
      : new NotBuilt({
          message: `no host can take a clone of build ${made.id}${onTailnet(ask)}: ${reasons}${advice}`,
          template,
        })
  );
};

export interface Candidate {
  readonly host: string;
  readonly source: Source;
}
