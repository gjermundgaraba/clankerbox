/**
 * What every action shares. Every mutation runs in this order:
 *
 * 1. Validate the input.
 * 2. Claim the rows in one transaction, inserting the new row.
 * 3. Check runtime state, including the runtime's own `admit`.
 * 4. Only then call the runtime.
 *
 * A failure in steps 1–3, or a runtime `Refusal`, releases the claims and writes nothing; any
 * later failure leaves the claimed rows' action `failed` with the error the call replies with.
 * Each mutation runs in a fiber of the host's own, so a dropped connection never interrupts it
 * and its outcome is recorded either way.
 */
import {
  type ActionName,
  type ActionRecord,
  type HostError,
  Internal,
  type NotFound,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Fiber, FiberSet, Option } from "effect";
import { idOn, type Kind, notFoundOn } from "./ids.ts";
import { type CheckpointRef, type MachineRef, Refusal } from "./runtime.ts";
import type { CheckpointRecord, MachineRecord, Interface as StoreInterface } from "./store.ts";

/** The rows of host `host`'s store by name; a missing one is NotFound. */
export const rowsOn = (store: StoreInterface, host: string) => {
  const notFound = notFoundOn(host);

  const present =
    (kind: Kind, name: string) =>
    <A>(found: Option.Option<A>): Effect.Effect<A, NotFound> =>
      Option.match(found, {
        onNone: () => Effect.fail(notFound(kind, name)),
        onSome: Effect.succeed,
      });

  return {
    machine: (name: string) => Effect.flatMap(store.find(name), present("machine", name)),
    checkpoint: (name: string) =>
      Effect.flatMap(store.findCheckpoint(name), present("checkpoint", name)),
  };
};

export const machineRef = (host: string, record: MachineRecord): MachineRef => ({
  id: idOn(host)(record.name),
  name: record.name,
  instance: record.instance,
  native: record.native,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  port: record.port,
});

export const checkpointRef = (host: string, record: CheckpointRecord): CheckpointRef => ({
  id: idOn(host)(record.name),
  name: record.name,
  instance: record.instance,
  native: record.native,
  kind: record.kind,
  port: record.port,
});

/** An action's hold on its rows, and how to give them back or end it. */
export interface Claim<R> {
  readonly action: ActionName;
  /** The row the action works on, as the action holds it. */
  readonly record: R;
  /** Removes the row the action inserted, and puts back the action it replaced on any other. */
  readonly release: Effect.Effect<void, Internal>;
  /** Records the action's outcome on every row it holds, and the host key it read, if any. */
  readonly end: (action: ActionRecord, hostKey?: string) => Effect.Effect<void, Internal>;
}

/**
 * Steps 2 and 3: claims, then checks. A check that fails, or is interrupted, releases the claim,
 * so nothing is written.
 */
export const claimAndCheck = <R, B>(
  claim: Effect.Effect<Claim<R>, HostError>,
  check: (record: R) => Effect.Effect<B, HostError>,
): Effect.Effect<readonly [Claim<R>, B], HostError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(claim, (claimed) =>
      restore(check(claimed.record)).pipe(
        Effect.onError(() => Effect.ignore(claimed.release)),
        Effect.map((checked) => [claimed, checked] as const),
      ),
    ),
  );

/**
 * Step 4 on; `what` names the action in a defect's error. A runtime `Refusal` releases the claim like a failed
 * check; any other failure ends the action failed with the error the call replies with. A defect
 * is recorded as `Internal`, so the rows stay deletable.
 */
export const native = <A, R>(
  claimed: Claim<R>,
  what: string,
  work: Effect.Effect<A, HostError | Refusal>,
): Effect.Effect<A, HostError> =>
  work.pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(new Internal({ message: `${what} died: ${String(defect)}` })),
    ),
    Effect.catch((error) =>
      error instanceof Refusal
        ? Effect.andThen(claimed.release, Effect.fail(error.error))
        : Effect.andThen(
            claimed.end({
              name: claimed.action,
              status: "failed",
              error: { tag: error._tag, message: error.message },
            }),
            Effect.fail(error),
          ),
    ),
  );

/** Ends the action done on every row it holds. */
export const done = <R>(claimed: Claim<R>, hostKey?: string) =>
  claimed.end({ name: claimed.action, status: "done" }, hostKey);

/** Runs mutations in the host's own fiber set; the caller only waits for each. */
export const detacher = Effect.map(
  FiberSet.make<unknown>(),
  (actions) =>
    <A>(what: string, action: Effect.Effect<A, HostError>): Effect.Effect<A, HostError> =>
      Effect.flatMap(
        FiberSet.run(
          actions,
          Effect.result(
            Effect.tapError(action, (error) =>
              Effect.logWarning(`${what} failed: ${error._tag}: ${error.message}`),
            ),
          ),
        ),
        (fiber) => Effect.flatMap(Fiber.join(fiber), Effect.fromResult),
      ),
);
