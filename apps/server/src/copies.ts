import {
  checkpointKinds,
  formatGib,
  formatMib,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Internal,
  Kind,
  NotFound,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option } from "effect";

import type { MachineRow } from "./machine-chart.ts";
import { notFound } from "./store.ts";
import type { Interface as Store } from "./store.ts";

export interface Spec {
  readonly base: string;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

const sizedBy = (from: Spec, sizing: Sizing | undefined): Spec => ({
  base: from.base,
  cpu: sizing?.cpu ?? from.cpu,
  ramMib: sizing?.ramMib ?? from.ramMib,
  diskGib: sizing?.diskGib ?? from.diskGib,
});

/** The spec of a copy of `from`. A disk only grows, and a copy that holds its RAM keeps what it held. */
export const copied = (
  name: string,
  from: Spec,
  sizing: Sizing | undefined,
  kind: Kind
): Effect.Effect<Spec, Unsizable> =>
  Effect.gen(function* () {
    const spec = sizedBy(from, sizing);

    if (spec.diskGib < from.diskGib) {
      return yield* new Unsizable({
        message: `machine ${name}'s disk of ${formatGib(spec.diskGib)} is below its source's ${formatGib(from.diskGib)}, and a disk only grows`,
      });
    }

    if (
      checkpointKinds[kind] === "ram" &&
      (spec.cpu < from.cpu || spec.ramMib < from.ramMib)
    ) {
      return yield* new Unsizable({
        message: `a ${kind} copy holds its source's RAM, so machine ${name}'s vCPUs and RAM only grow from the source's ${from.cpu} vCPUs and ${formatMib(from.ramMib)}`,
      });
    }

    return spec;
  });

/** The spec of a clone of `build`'s copy, `from`, which takes no size below the build's. */
export const cloned = (
  name: string,
  build: string,
  from: Spec,
  sizing: Sizing
): Effect.Effect<Spec, Unsizable> => {
  const spec = sizedBy(from, sizing);

  return spec.cpu < from.cpu ||
    spec.ramMib < from.ramMib ||
    spec.diskGib < from.diskGib
    ? Effect.fail(
        new Unsizable({
          message: `machine ${name} takes at least build ${build}'s ${from.cpu} vCPUs, ${formatMib(from.ramMib)} of RAM and ${formatGib(from.diskGib)} of disk`,
        })
      )
    : Effect.succeed(spec);
};

/**
 * Why a copy can't be made: its source went before it began, or it can't be at the sizes it was
 * asked, as its source may have grown since.
 */
export const refusedBySource = (
  store: Store,
  found: MachineRow
): Effect.Effect<NotFound | Unsizable | undefined, Internal> =>
  Effect.gen(function* () {
    const { source } = found;

    if (source.kind === "base") {
      return undefined;
    }

    const from: Option.Option<Spec> =
      source.kind === "machine"
        ? yield* store.findMachine(source.name)
        : yield* store.findCheckpoint(source.name);

    return Option.isNone(from)
      ? notFound(source.kind, source.name)
      : yield* copied(found.name, from.value, found, found.kind).pipe(
          Effect.match({
            onFailure: (refusal) => refusal,
            onSuccess: () => undefined,
          })
        );
  });
