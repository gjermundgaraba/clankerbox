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

/** What a machine is made as: its base, its sizes, and whether it requests the tailnet, which a copy inherits. */
export interface Spec {
  readonly base: string;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  readonly tailnet: boolean;
}

export const copied = (
  name: string,
  from: Spec,
  sizing: Sizing | undefined,
  traits: RuntimeTraits
): Effect.Effect<Spec, Unsizable> => {
  const spec = {
    base: from.base,
    tailnet: from.tailnet,
    ...sizedBy(from, sizing),
  };

  const refusal = copyRefusal(traits, name, from, spec);

  return refusal === undefined ? Effect.succeed(spec) : Effect.fail(refusal);
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
