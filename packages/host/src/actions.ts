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
  type ActionName,
  type HostError,
  Internal,
  type NotFound,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Fiber, FiberSet, Option, Ref } from "effect";
import { idOn, type Kind, notFoundOn } from "./ids.ts";
import { type CheckpointRef, type MachineRef, Refusal } from "./runtime.ts";
import type {
  CheckpointRecord,
  MachineRecord,
  Rows,
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

export const machineRef = (host: string, record: Omit<MachineRecord, "action">): MachineRef => ({
  id: idOn(host)(record.name),
  name: record.name,
  instance: record.instance,
  native: record.native,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  port: record.port,
});

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
   * Steps 2 and 3: claims `rows` for `action`, then runs `check`, which can claim more rows
   * through `join`, each joining the claim before, so one token covers them all. A check that
   * fails, or is interrupted, releases every row claimed so far, so nothing is written.
   */
  const claimAndCheck = <B>(
    action: ActionName,
    rows: Rows,
    check: (join: (more: Rows) => Effect.Effect<void, HostError>) => Effect.Effect<B, HostError>,
  ): Effect.Effect<readonly [Token, B], HostError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* Ref.make(yield* store.claim(action, rows));

        const join = (more: Rows) =>
          Effect.uninterruptible(
            Effect.flatMap(Ref.get(claimed), (token) =>
              Effect.flatMap(store.claim(action, more, token), (joined) =>
                Ref.set(claimed, joined),
              ),
            ),
          );

        const checked = yield* restore(check(join)).pipe(
          Effect.onError(() => Effect.flatMap(Ref.get(claimed), release)),
        );

        return [yield* Ref.get(claimed), checked] as const;
      }),
    );

  /**
   * Step 4 on; `what` names the action in a defect's error. A runtime `Refusal` releases the
   * claim like a failed check; any other failure ends the action failed with the error the call
   * replies with. A defect is recorded as `Internal`, so the rows stay deletable.
   */
  const native = <A>(
    token: Token,
    what: string,
    work: Effect.Effect<A, HostError | Refusal>,
  ): Effect.Effect<A, HostError> =>
    work.pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(new Internal({ message: `${what} died: ${String(defect)}` })),
      ),
      Effect.catch((error) =>
        error instanceof Refusal
          ? Effect.andThen(store.release(token), Effect.fail(error.error))
          : Effect.andThen(
              store.end(token, {
                action: {
                  name: token.action,
                  status: "failed",
                  error: { tag: error._tag, message: error.message },
                },
              }),
              Effect.fail(error),
            ),
      ),
    );

  /** Ends the action done on every row it holds, with the host key it read, if any. */
  const done = (token: Token, hostKey?: string) =>
    store.end(token, { action: { name: token.action, status: "done" }, hostKey });

  return { claimAndCheck, native, done };
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
