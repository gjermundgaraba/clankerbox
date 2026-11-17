import type { Adoption, MachineRef, Ref } from "@clankerbox/host-contract";
import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import type { Semaphore } from "effect";

import { Reaches } from "./reach.ts";
import { targetOf } from "./runtime.ts";
import type { Handle } from "./runtime.ts";

/** What the recheck's adopt reads of the steps the host runs, which it never changes. */
export interface Steps {
  /** A machine's handle: its ref's, or else the one the runtime finds by its instance, in a read's time. */
  readonly found: (machine: Ref) => Effect.Effect<Handle | undefined, Internal>;
  /** Held while the host accepts a step, so an adopt reopens no relay beside one. */
  readonly accepting: Semaphore.Semaphore;
  /** Whether no step the host accepted since gives the machine's name to another instance. */
  readonly reachable: (machine: MachineRef) => boolean;
}

export interface Interface {
  readonly adopt: (machines: readonly MachineRef[]) => Effect.Effect<Adoption>;
}

const heldAs = (machine: Ref, handle: Handle | undefined): string => {
  if (machine.handle !== undefined) {
    return `reached by its row's handle ${machine.handle}`;
  }

  return handle === undefined
    ? "the runtime holds no machine of its instance"
    : `the runtime found it as ${handle}`;
};

/**
 * The host's side of the control plane's recheck. An adopt gives a restarted host the machines it
 * holds: it resolves each machine's handle, reopens the relay of each that no step since has moved
 * on, and answers each one's handle and endpoint, naming those whose search failed.
 */
export const make = (steps: Steps) =>
  Effect.gen(function* () {
    const reaches = yield* Reaches;

    const adopt: Interface["adopt"] = (machines) =>
      Effect.gen(function* () {
        const [adopted, unresolved] = yield* Effect.partition(
          machines,
          (machine) =>
            steps.found(machine).pipe(
              Effect.tap((handle) =>
                Effect.logInfo(
                  `adopt ${machine.name}: ${heldAs(machine, handle)}`
                )
              ),
              Effect.map((handle) => ({ machine, handle })),
              Effect.mapError((error) => ({ machine, error }))
            ),
          { concurrency: "unbounded" }
        );

        yield* Effect.forEach(
          unresolved,
          ({ machine, error }) =>
            Effect.logWarning(
              `adopt ${machine.name}: couldn't find it, so the next adopt tries again: ${error.message}`
            ),
          { discard: true }
        );

        const reached = yield* steps.accepting.withPermits(1)(
          Effect.suspend(() =>
            reaches.adopt(
              adopted.flatMap(({ machine, handle }) =>
                handle === undefined ||
                machine.port === undefined ||
                !steps.reachable(machine)
                  ? []
                  : [{ machine: targetOf(machine, handle), port: machine.port }]
              )
            )
          )
        );

        return {
          adopted: adopted.map(({ machine, handle }) => ({
            name: machine.name,
            instance: machine.instance,
            ...(handle === undefined ? {} : { handle }),
            ...(machine.port === undefined
              ? {}
              : {
                  endpoint: reaches.endpoint(
                    reached.get(machine.name) ?? machine.port
                  ),
                }),
          })),
          unresolved: unresolved.map(({ machine }) => machine.name),
        };
      });

    return { adopt } satisfies Interface;
  });
