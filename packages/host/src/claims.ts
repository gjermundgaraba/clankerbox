import {
  type Conflict,
  type HostError,
  Internal,
  type Invalid,
  type NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Fiber, Option, Ref } from "effect";
import { idOn, type Kind, notFoundOn } from "./ids.ts";
import { type CheckpointRef, type MachineRef, Refusal, type RoomError } from "./runtime.ts";
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

/** A read of one row: a malformed or another host's ID, no such row, or the store. */
export type ReadError = Invalid | NotFound | Internal;

/** An action on rows: a read's errors, a held row or a taken name, and its runtime calls'. */
export type ActionError<Runtime> = ReadError | Conflict | Runtime;

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

export const claimsOn = (store: StoreInterface) => {
  const release = (token: Token) =>
    store
      .release(token)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`couldn't release the rows of a ${token.action}: ${error.message}`),
        ),
      );

  /** Logged, not failed, so the action's own error stays the reply. */
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

  const claimAndCheck = <H, B, R, EClaim, ECheck>(
    claim: Effect.Effect<Claim<H>, EClaim>,
    check: (
      held: H,
      join: (row: NewRow) => Effect.Effect<void, Conflict | Internal>,
    ) => Effect.Effect<B, ECheck, R>,
  ): Effect.Effect<readonly [Token, B], EClaim | ECheck, R> =>
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

  /** A defect is recorded as `Internal`, so its rows stay deletable; only the log has its cause. */
  const surviving = <A, E>(what: string, work: Effect.Effect<A, E>) =>
    Effect.catchCauseFilter(work, Cause.findDefect, (defect, cause) =>
      Effect.andThen(
        Effect.logError(`${what} died:\n${Cause.pretty(cause)}`),
        Effect.fail(new Internal({ message: `${what} died: ${String(defect)}` })),
      ),
    );

  const native = <A, E extends HostError>(
    token: Token,
    what: string,
    work: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | Internal> =>
    Effect.tapError(surviving(what, work), (error) => endFailed(token, error));

  /** A runtime `Refusal` releases the claim like a failed check. */
  const refusable = <A, E extends HostError>(
    token: Token,
    what: string,
    work: Effect.Effect<A, E | Refusal>,
  ): Effect.Effect<A, E | RoomError> =>
    Effect.catch(surviving(what, work), (error): Effect.Effect<never, E | RoomError> =>
      error instanceof Refusal
        ? Effect.andThen(release(token), Effect.fail(error.error))
        : Effect.andThen(endFailed(token, error), Effect.fail(error)),
    );

  const done = (token: Token, recorded?: Omit<Outcome, "action">) =>
    store.end(token, { ...recorded, action: { name: token.action, status: "done" } });

  return { claimAndCheck, native, refusable, done };
};

/**
 * Runs mutations in the host's own scope, so a dropped connection never interrupts one and its
 * outcome is recorded either way.
 */
export const detacher = Effect.map(
  Effect.scope,
  (scope) =>
    <A, E extends HostError>(what: string, action: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.flatMap(
        Effect.forkIn(
          Effect.tapError(action, (error) =>
            Effect.logWarning(`${what} failed: ${error._tag}: ${error.message}`),
          ),
          scope,
        ),
        Fiber.join,
      ),
);
