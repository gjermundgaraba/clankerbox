import {
  copySizable,
  fitted,
  formatGib,
  formatMib,
  givenSizes,
  NotBuilt,
  templateRef,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Internal,
  NotFound,
  RuntimeTraits,
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

export const sizedBy = (from: Spec, sizing: Sizing | undefined): Spec => ({
  base: from.base,
  cpu: sizing?.cpu ?? from.cpu,
  ramMib: sizing?.ramMib ?? from.ramMib,
  diskGib: sizing?.diskGib ?? from.diskGib,
});

const copyRefusal = (
  name: string,
  from: Spec,
  spec: Spec,
  traits: RuntimeTraits
): string => {
  const held = `the source's ${from.cpu} vCPUs and ${formatMib(from.ramMib)}`;
  const shrunkDisk = `machine ${name}'s disk of ${formatGib(spec.diskGib)} is below its source's ${formatGib(from.diskGib)}, and a disk only grows`;

  if (!fitted(traits, spec)) {
    return `machine ${name}'s host gives ${givenSizes(traits)}, and it was asked ${spec.cpu} vCPUs, ${formatMib(spec.ramMib)} of RAM and ${formatGib(spec.diskGib)} of disk`;
  }

  switch (traits.copies) {
    case "same": {
      return `a ${traits.runtime} copy takes its source's own sizes, so machine ${name} keeps ${held} and its ${formatGib(from.diskGib)} disk`;
    }

    case "grow": {
      return spec.diskGib < from.diskGib
        ? shrunkDisk
        : `a ${traits.runtime} copy holds its source's RAM, so machine ${name}'s vCPUs and RAM only grow from ${held}`;
    }

    case "any": {
      return shrunkDisk;
    }
  }
};

export const copied = (
  name: string,
  from: Spec,
  sizing: Sizing | undefined,
  traits: RuntimeTraits
): Effect.Effect<Spec, Unsizable> => {
  const spec = sizedBy(from, sizing);

  if (copySizable(traits, from, spec)) {
    return Effect.succeed(spec);
  }

  return Effect.fail(
    new Unsizable({ message: copyRefusal(name, from, spec, traits) })
  );
};

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

export const refusedBySource = (
  store: Store,
  found: MachineRow,
  traits: RuntimeTraits
): Effect.Effect<NotFound | NotBuilt | Unsizable | undefined, Internal> =>
  Effect.gen(function* () {
    const { source } = found;

    if (source.kind === "base") {
      return undefined;
    }

    const from: Option.Option<Spec> =
      source.kind === "machine"
        ? yield* store.findMachine(source.name)
        : yield* store.findCheckpoint(source.name);

    if (Option.isNone(from)) {
      return found.template === undefined
        ? notFound(source.kind, source.name)
        : new NotBuilt({
            message: `build ${found.template} went before machine ${found.name} could clone it`,
            template: templateRef(found.template).template,
          });
    }

    return yield* copied(found.name, from.value, found, traits).pipe(
      Effect.match({
        onFailure: (refusal) => refusal,
        onSuccess: () => undefined,
      })
    );
  });
