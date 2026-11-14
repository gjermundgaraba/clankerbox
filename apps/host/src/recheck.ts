import type {
  Adoption,
  MachineRef,
  Ref,
  Retired,
} from "@clankerbox/host-contract";
import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Semaphore } from "effect";

import { Reaches } from "./reach.ts";
import { inTime, Runtime, stateReadWait, targetOf } from "./runtime.ts";
import type { Handle, MarkedMachine, Owned } from "./runtime.ts";

/** What the recheck's adopt and sweep read of the steps the host runs, which they never change. */
export interface Steps {
  /** A machine's handle: its ref's, or else the one the runtime finds by its instance, in a read's time. */
  readonly found: (machine: Ref) => Effect.Effect<Handle | undefined, Internal>;
  /** Held while the host accepts a step, so an adopt reopens no relay beside one. */
  readonly accepting: Semaphore.Semaphore;
  /** Whether no step the host accepted since gives the machine's name to another instance. */
  readonly reachable: (machine: MachineRef) => boolean;
  /** Each instance and handle a step the host holds names, as they are now. */
  readonly named: () => ReadonlySet<string>;
}

export interface Interface {
  readonly adopt: (machines: readonly MachineRef[]) => Effect.Effect<Adoption>;
  readonly sweep: (retired: Retired) => Effect.Effect<Retired, Internal>;
}

/** The longest a sweep takes to answer, once it runs: its list, then its deletes, which run at once. */
export const sweepsWithin = (owned: Owned): Duration.Duration =>
  Duration.sum(stateReadWait, owned.deleteWithin);

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
 * on, and answers each one's handle and endpoint, naming those whose search failed. A sweep deletes
 * each machine the runtime marked whose instance the control plane retired and no step the host holds
 * names, all at once, keeping every checkpoint it holds, and answers the retired instances it left.
 */
export const make = (hostId: string, steps: Steps) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const reaches = yield* Reaches;
    const sweeping = yield* Semaphore.make(1);
    const undeleted = new Set<string>();

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

    const swept = (machine: MarkedMachine): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const { instance } = machine;
        const what = `machine ${instance} (${machine.handle})`;
        const again = undeleted.has(instance);

        return Effect.andThen(
          again
            ? Effect.logDebug(`sweep: deleting ${what} again`)
            : Effect.logInfo(
                `sweep: deleting ${what}, which the control plane retired`
              ),
          runtime
            .delete(
              targetOf({ name: instance, instance }, machine.handle),
              new Set(machine.checkpoints)
            )
            .pipe(
              Effect.tap(() =>
                Effect.andThen(
                  Effect.sync(() => undeleted.delete(instance)),
                  again
                    ? Effect.logInfo(
                        `sweep: deleted ${what}, which an earlier sweep couldn't`
                      )
                    : Effect.void
                )
              ),
              Effect.as(true),
              Effect.catch((error) =>
                Effect.as(
                  Effect.andThen(
                    Effect.sync(() => undeleted.add(instance)),
                    again
                      ? Effect.logDebug(
                          `sweep: still couldn't delete ${what} on host ${hostId}: ${error.message}`
                        )
                      : Effect.logWarning(
                          `sweep: couldn't delete ${what}, which stays at its provider until a sweep deletes it, so each sweep of host ${hostId} tries again: ${error.message}`
                        )
                  ),
                  false
                )
              )
            )
        );
      });

    const sweep: Interface["sweep"] = (retired) => {
      const { owned } = runtime;

      if (owned === undefined || retired.machines.length === 0) {
        return Effect.succeed({ machines: [] });
      }

      return sweeping.withPermits(1)(
        Effect.gen(function* () {
          const wanted = new Set(retired.machines);

          for (const instance of undeleted) {
            if (!wanted.has(instance)) {
              undeleted.delete(instance);
            }
          }

          const machines = yield* owned.machines.pipe(
            inTime(
              `the ${runtime.traits.runtime} runtime's list of what it marked`
            )
          );

          const named = steps.named();

          const left = yield* Effect.forEach(
            machines.filter(({ instance }) => wanted.has(instance)),
            (machine) =>
              named.has(machine.instance) || named.has(machine.handle)
                ? Effect.succeed([machine.instance])
                : Effect.map(swept(machine), (deleted) =>
                    deleted ? [] : [machine.instance]
                  ),
            { concurrency: "unbounded" }
          );

          return { machines: left.flat() };
        })
      );
    };

    return { adopt, sweep } satisfies Interface;
  });
