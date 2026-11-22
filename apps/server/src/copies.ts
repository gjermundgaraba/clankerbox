import type { MachineState } from "@clankerbox/host-contract";
import { copyRefusal, formatSizes } from "@clankerbox/host-contract/traits";
import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import {
  isResting,
  NotBuilt,
  sizedBy,
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
  readonly tailnet: boolean;
}

export const copied = (
  name: string,
  copy: "fork" | "restore",
  from: Spec,
  sizing: Sizing | undefined,
  traits: RuntimeTraits
): Effect.Effect<Spec, Unsizable> => {
  const spec = {
    base: from.base,
    tailnet: from.tailnet,
    ...sizedBy(from, sizing),
  };

  const refusal = copyRefusal(traits, name, copy, from, spec);

  return refusal === undefined ? Effect.succeed(spec) : Effect.fail(refusal);
};

export const restingAs = (
  found: MachineRow,
  seen: MachineState
): "running" | "stopped" | undefined =>
  isResting(phaseOf(found.state)) && (seen === "running" || seen === "stopped")
    ? seen
    : undefined;

export const uncopiable = (
  source: MachineRow,
  seen: MachineState,
  { captureFrom, whyRunning }: RuntimeTraits,
  action: "fork" | "capture"
): WrongState | undefined => {
  const resting = restingAs(source, seen);

  if (
    resting === undefined ||
    resting === captureFrom ||
    captureFrom === "either"
  ) {
    return undefined;
  }

  return new WrongState({
    message: `machine ${source.name} is ${seen}, and its host copies a machine only running${whyRunning === undefined ? "" : `, as ${whyRunning}`}: start it, then ${action} it`,
    machine: source.name,
    state: seen,
  });
};

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
    : copied(name, "restore", from, sizing, traits);
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

    return yield* copied(
      found.name,
      source.kind === "machine" ? "fork" : "restore",
      from.value,
      found,
      traits
    ).pipe(
      Effect.match({
        onFailure: (refusal) => refusal,
        onSuccess: () => undefined,
      })
    );
  });
