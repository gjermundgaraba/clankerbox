import type { MachineState } from "@clankerbox/host-contract";
import {
  copySizable,
  fitted,
  givenSizes,
} from "@clankerbox/host-contract/traits";
import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import {
  formatCpu,
  formatGib,
  formatMib,
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
    return `machine ${name}'s host gives ${givenSizes(traits)}, and it was asked ${formatCpu(spec.cpu)}, ${formatMib(spec.ramMib)} of RAM and ${formatGib(spec.diskGib)} of disk`;
  }

  switch (traits.copies) {
    case "same": {
      return `machine ${name}'s host copies a machine only at its source's own sizes, so it keeps ${held} and its ${formatGib(from.diskGib)} disk`;
    }

    case "grow": {
      return spec.diskGib < from.diskGib
        ? shrunkDisk
        : `machine ${name}'s host copies a machine only at its source's sizes or larger, so its vCPUs and RAM only grow from ${held}`;
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
 * Why a fork or capture of a machine at rest, its VM read `seen`, is refused by a host whose
 * runtime copies a machine only in `captureFrom`, before a row is written; none where the VM's
 * state isn't known or the machine is still moving, as the host then decides.
 */
export const uncopiable = (
  source: MachineRow,
  seen: MachineState,
  { captureFrom }: RuntimeTraits,
  action: "fork" | "capture"
): WrongState | undefined => {
  const settled = phaseOf(source.state) === "settled";
  const known = seen === "running" || seen === "stopped" || seen === "paused";

  return settled && known && seen !== captureFrom
    ? new WrongState({
        message: `machine ${source.name} is ${seen}, and its host copies a machine only ${captureFrom}: ${captureFrom === "stopped" ? "stop" : "start"} it, then ${action} it`,
        machine: source.name,
        state: seen,
      })
    : undefined;
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
          message: `machine ${name} takes at least build ${build}'s ${formatCpu(from.cpu)}, ${formatMib(from.ramMib)} of RAM and ${formatGib(from.diskGib)} of disk`,
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
