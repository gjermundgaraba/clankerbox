import {
  type HostError,
  Internal,
  type NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Fiber, Option, Ref } from "effect";
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
   * A runtime `Refusal` releases the claim like a failed check. A defect is recorded as
   * `Internal`, so its rows stay deletable; only the log carries its cause.
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

  const done = (token: Token, recorded?: Omit<Outcome, "action">) =>
    store.end(token, { ...recorded, action: { name: token.action, status: "done" } });

  return { claimAndCheck, native, done };
};

/**
 * Runs mutations in the host's own scope, so a dropped connection never interrupts one and its
 * outcome is recorded either way.
 */
export const detacher = Effect.map(
  Effect.scope,
  (scope) =>
    <A>(what: string, action: Effect.Effect<A, HostError>): Effect.Effect<A, HostError> =>
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
