import type { MachineState } from "@clankerbox/host-contract";
import {
  copySizable,
  fitted,
  formatSizes,
  givenSizes,
  grownPast,
} from "@clankerbox/host-contract/traits";
import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import {
  formatCpu,
  formatGib,
  formatMib,
  isResting,
  NotBuilt,
  templateRef,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Internal,
  NotFound,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option } from "effect";

import { phaseOf } from "./machine-chart.ts";
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
  const held = `the source's ${formatCpu(from.cpu)} and ${formatMib(from.ramMib)}`;
  const shrunkDisk = `machine ${name}'s disk of ${formatGib(spec.diskGib)} is below its source's ${formatGib(from.diskGib)}, and a disk only grows`;

  if (!fitted(traits, spec)) {
    return `machine ${name}'s host gives ${givenSizes(traits)}, and it was asked ${formatSizes(spec)}`;
  }

  switch (traits.copies) {
    case "same": {
      return `machine ${name}'s host copies a machine only at its source's own sizes, so it keeps ${held} and its ${formatGib(from.diskGib)} disk`;
    }

    case "grow": {
      const past = grownPast(traits, from, spec);

      if (spec.diskGib < from.diskGib) {
        return shrunkDisk;
      }

      return past === undefined
        ? `machine ${name}'s host copies a machine only at its source's sizes or larger, so its vCPUs and RAM only grow from ${held}`
        : `machine ${name}'s host grows a copy live from ${held} once it runs, to at most ${past.limit}, and it was asked ${past.asked}`;
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

/**
 * The state a step meets in machine `found`, its VM read `seen`, where the server can refuse the
 * step before a row is written: none where the VM's state isn't known or the machine is still
 * moving, as the host then decides.
 */
export const restingAs = (
  found: MachineRow,
  seen: MachineState
): "running" | "stopped" | "paused" | undefined =>
  isResting(phaseOf(found.state)) &&
  (seen === "running" || seen === "stopped" || seen === "paused")
    ? seen
    : undefined;

/**
 * Why a fork or capture of a machine at rest, its VM read `seen`, is refused by a host whose
 * runtime copies a machine only in `captureFrom`, before a row is written.
 */
export const uncopiable = (
  source: MachineRow,
  seen: MachineState,
  { captureFrom }: RuntimeTraits,
  action: "fork" | "capture"
): WrongState | undefined => {
  const resting = restingAs(source, seen);

  return resting !== undefined && resting !== captureFrom
    ? new WrongState({
        message: `machine ${source.name} is ${seen}, and its host copies a machine only ${captureFrom}: ${captureFrom === "stopped" ? "stop" : "start"} it, then ${action} it`,
        machine: source.name,
        state: seen,
      })
    : undefined;
};

/**
 * A template's clone of `build`, sized `from`, at the sizes asked: at least the build's, and as a
 * copy of it on a runtime of `traits`, a restore of its checkpoint.
 */
export const cloned = (
  name: string,
  build: string,
  from: Spec,
  sizing: Sizing,
  traits: RuntimeTraits
): Effect.Effect<Spec, Unsizable> => {
  const spec = sizedBy(from, sizing);

  return spec.cpu < from.cpu ||
    spec.ramMib < from.ramMib ||
    spec.diskGib < from.diskGib
    ? Effect.fail(
        new Unsizable({
          message: `machine ${name} takes at least build ${build}'s ${formatSizes(from)}`,
        })
      )
    : copied(name, from, sizing, traits);
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
