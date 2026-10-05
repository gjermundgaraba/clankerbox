/**
 * What every action shares. Every mutation runs in this order:
 *
 * 1. Validate the input.
 * 2. Claim the rows, inserting the new row.
 * 3. Check runtime state, including the runtime's own `admit`.
 * 4. Only then call the runtime.
 *
 * A failure in steps 1–3, or a runtime `Refusal`, releases the claims and writes nothing; any
 * later failure leaves the claimed rows' action `failed` with the error the call replies with.
 * Each mutation runs in a fiber of the host's own, so a dropped connection never interrupts it
 * and its outcome is recorded either way.
 */
import {
  type HostError,
  Internal,
  type NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Fiber, FiberSet, Option, Ref } from "effect";
import { idOn, type Kind, notFoundOn } from "./ids.ts";
import { type CheckpointRef, type MachineRef, Refusal } from "./runtime.ts";
import type {
  CheckpointRecord,
  Claim,
  MachineRecord,
  NewMachine,
  NewRow,
  Outcome,
  Interface as StoreInterface,
  Token,
} from "./store.ts";

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

export const machineRef = (host: string, record: NewMachine): MachineRef => ({
  id: idOn(host)(record.name),
  name: record.name,
  instance: record.instance,
  native: record.native,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  port: record.port,
});

/**
 * Step 3's check that a machine was made: one whose create, fork or restore failed can only be
 * read, stopped or deleted, so start, fork and capture refuse it, a half-made VM never boots, and
 * delete cleans it up.
 */
export const madeOn =
  (host: string) =>
  (record: MachineRecord): Effect.Effect<void, Precondition> =>
    record.made
      ? Effect.void
      : Effect.fail(
          new Precondition({
            message: `machine ${idOn(host)(record.name)} was never made: its create, fork or restore failed; delete it`,
          }),
        );

export const checkpointRef = (
  host: string,
  record: Omit<CheckpointRecord, "action">,
): CheckpointRef => ({
  id: idOn(host)(record.name),
  name: record.name,
  instance: record.instance,
  native: record.native,
  kind: record.kind,
  port: record.port,
});

/** How the actions claim, check, call the runtime and end, over the store `store`. */
export const claimsOn = (store: StoreInterface) => {
  /** A release that fails leaves its rows held until the next host start marks them failed. */
  const release = (token: Token) =>
    store
      .release(token)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`couldn't release the rows of a ${token.action}: ${error.message}`),
        ),
      );

  /**
   * Ends the action failed with `error`. An end that fails is logged, so the action's error
   * stays the reply, and leaves its rows running until the next host start marks them failed.
   */
  const endFailed = (token: Token, error: HostError) =>
    store
      .end(token, {
        action: {
          name: token.action,
          status: "failed",
          error: { tag: error._tag, message: error.message },
        },
      })
      .pipe(
        Effect.catch((failure) =>
          Effect.logWarning(`couldn't record the failure of a ${token.action}: ${failure.message}`),
        ),
      );

  /**
   * Steps 2 and 3: runs `claim`, then `check` with the record of the row it claimed. The
   * check can insert a row through `join`, which joins the claim, so one token covers them all.
   * A check that fails, or is interrupted, releases every row claimed so far, so nothing is
   * written.
   */
  const claimAndCheck = <H, B, R>(
    claim: Effect.Effect<Claim<H>, HostError>,
    check: (
      held: H,
      join: (row: NewRow) => Effect.Effect<void, HostError>,
    ) => Effect.Effect<B, HostError, R>,
  ): Effect.Effect<readonly [Token, B], HostError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { token, held } = yield* claim;
        const claimed = yield* Ref.make(token);

        const join = (row: NewRow) =>
          Effect.uninterruptible(
            Effect.flatMap(Ref.get(claimed), (joining) =>
              Effect.flatMap(store.insert(joining.action, row, joining), (joined) =>
                Ref.set(claimed, joined),
              ),
            ),
          );

        const checked = yield* restore(check(held, join)).pipe(
          Effect.onError(() => Effect.flatMap(Ref.get(claimed), release)),
        );

        return [yield* Ref.get(claimed), checked] as const;
      }),
    );

  /**
   * Step 4 on; `what` names the action in a defect's error. A runtime `Refusal` releases the
   * claim like a failed check; any other failure ends the action failed with the error the call
   * replies with. A defect is logged with its cause, then recorded as `Internal`, so the rows
   * stay deletable; the reply carries only its message.
   */
  const native = <A>(
    token: Token,
    what: string,
    work: Effect.Effect<A, HostError | Refusal>,
  ): Effect.Effect<A, HostError> =>
    work.pipe(
      Effect.catchCauseFilter(Cause.findDefect, (defect, cause) =>
        Effect.andThen(
          Effect.logError(`${what} died:\n${Cause.pretty(cause)}`),
          Effect.fail(new Internal({ message: `${what} died: ${String(defect)}` })),
        ),
      ),
      Effect.catch((error) =>
        error instanceof Refusal
          ? Effect.andThen(release(token), Effect.fail(error.error))
          : Effect.andThen(endFailed(token, error), Effect.fail(error)),
      ),
    );

  /** Ends the action done on every row it holds, with what else it recorded. */
  const done = (token: Token, recorded?: Omit<Outcome, "action">) =>
    store.end(token, { ...recorded, action: { name: token.action, status: "done" } });

  return { claimAndCheck, native, done, release };
};

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
