import {
  Client,
  Conflict,
  Invalid,
  NotBuilt,
  NotFound,
  NotOffered,
  pinnedSsh,
  sshTarget,
  Superseded,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  ClankerboxError,
  Sizing,
  SshTarget,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import type { Path, FileSystem } from "effect";
import { Hex } from "effect/encoding";
import type { ChildProcessSpawner } from "effect/process";
import { SandboxDestroyedError } from "sandbox-agent";

import { healthPath } from "./agent.ts";
import { agentFetch } from "./fetch.ts";
import type { Options } from "./options.ts";
import { listen } from "./relay.ts";
import type { Relay } from "./relay.ts";
import {
  forwarding,
  LocalTunnelError,
  open,
  refusal,
  socketIn,
  sweepLeft,
  tunnelDirectory,
} from "./tunnel.ts";
import type { Tunnel } from "./tunnel.ts";

export const name = "clankerbox";

export const defaultCwd = "/home/admin";

const healthWait = Duration.seconds(3);

const Health = Schema.Struct({ status: Schema.Literal("ok") });

const isHealth = Schema.is(Health);

/** What a call gets once `dispose` has begun, and a `getUrl` or `ensureServer` it ended. */
export class ProviderDisposedError extends Data.TaggedError(
  "ProviderDisposedError"
)<{
  readonly message: string;
}> {}

export const disposed = () =>
  new ProviderDisposedError({
    message: "the clankerbox provider was disposed",
  });

interface Scoped<A> {
  readonly value: A;
  readonly scope: Scope.Closeable;
}

interface Sandbox {
  readonly lock: Semaphore.Semaphore;
  relay: Scoped<Relay> | undefined;
  held: Scoped<Tunnel> | undefined;
}

const urlOf = (port: number) => `http://127.0.0.1:${port}`;

const healthy = (
  sent: typeof globalThis.fetch,
  url: string
): Effect.Effect<boolean> =>
  Effect.tryPromise(async (signal) => {
    const reply = await sent(`${url}${healthPath}`, { signal });

    return await reply.json();
  }).pipe(
    Effect.map(isHealth),
    Effect.timeoutOrElse({
      duration: healthWait,
      orElse: () => Effect.succeed(false),
    }),
    Effect.orElseSucceed(() => false)
  );

const isLocal = (error: unknown): error is LocalTunnelError =>
  error instanceof LocalTunnelError;

const scoped = <A, E, R>(make: Effect.Effect<A, E, R | Scope.Scope>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const value = yield* make.pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void))
    );

    return { value, scope };
  });

const ended = <A>(was: Scoped<A> | undefined) =>
  was === undefined ? Effect.void : Scope.close(was.scope, Exit.void);

const isGone = (error: unknown): error is NotFound | Superseded =>
  error instanceof NotFound ||
  (error instanceof Superseded && error.by === "deleted");

const discard = (error: ClankerboxError) =>
  Effect.gen(function* () {
    const client = yield* Client.Client;

    if (
      error.made !== undefined &&
      !(
        error instanceof Conflict ||
        error instanceof Invalid ||
        error instanceof NotBuilt ||
        error instanceof NotOffered ||
        error instanceof Superseded ||
        error instanceof Unavailable
      )
    ) {
      yield* Effect.ignore(client.deleteMachine({ id: error.made }));
    }

    return yield* error;
  });

export type Services =
  | Client.Client
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/** Refuses, as `Invalid`, `sshArguments` a tunnel can't take. */
export const make = (options: Options, ssh = "ssh") => {
  const extra = options.sshArguments ?? [];
  const refused = refusal(extra);

  if (refused !== undefined) {
    throw new Invalid({ message: refused });
  }

  const sandboxes = new Map<string, Sandbox>();
  const closing = Deferred.makeUnsafe<undefined>();
  const calls = new Set<Fiber.Fiber<unknown, unknown>>();

  const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.withFiber<A, E, R>((fiber) => {
      calls.add(fiber);

      return Effect.ensuring(
        effect,
        Effect.sync(() => calls.delete(fiber))
      );
    });

  const endedByDispose = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    call(
      Effect.raceFirst(
        effect,
        Effect.andThen(Deferred.await(closing), Effect.fail(disposed()))
      )
    );

  const sandbox = (id: string): Sandbox => {
    const known = sandboxes.get(id) ?? {
      lock: Semaphore.makeUnsafe(1),
      relay: undefined,
      held: undefined,
    };

    sandboxes.set(id, known);

    return known;
  };

  const locked = <A, E, R>(
    id: string,
    use: (known: Sandbox) => Effect.Effect<A, E, R>
  ) =>
    Effect.suspend(() => {
      const known = sandbox(id);

      return Semaphore.withPermit(
        known.lock,
        Effect.suspend(() => use(known))
      );
    });

  const closed = (known: Sandbox) =>
    Effect.suspend(() => {
      const was = known.held;

      known.held = undefined;

      return ended(was);
    });

  const released = (known: Sandbox) =>
    Effect.suspend(() => {
      const was = known.relay;

      known.relay = undefined;

      return Effect.andThen(closed(known), ended(was));
    });

  const onMachine = <A, E, R>(
    id: string,
    use: (known: Sandbox) => Effect.Effect<A, E, R>
  ) =>
    locked(id, (known) =>
      use(known).pipe(
        Effect.catchIf(isGone, (cause) =>
          Effect.andThen(
            closed(known),
            Effect.fail(new SandboxDestroyedError(id, name, { cause }))
          )
        )
      )
    );

  const fetchOf = (id: string) =>
    agentFetch(id, () => {
      const port = sandboxes.get(id)?.relay?.value.port;

      return port === undefined ? undefined : urlOf(port);
    });

  const relayOf = (id: string, known: Sandbox) =>
    Effect.gen(function* () {
      known.relay ??= yield* scoped(
        listen(id, () =>
          known.held?.value.running() === true
            ? known.held.value.socket
            : undefined
        )
      );

      return known.relay.value;
    });

  let swept = false;

  const sweptFirst = Effect.suspend(() => {
    if (swept) {
      return Effect.void;
    }

    swept = true;

    return sweepLeft;
  });

  const tunnelled = (id: string, target: SshTarget) =>
    scoped(
      Effect.gen(function* () {
        yield* sweptFirst;

        const directory = yield* tunnelDirectory;

        const socket = yield* socketIn(directory, id);

        const args = yield* pinnedSsh(
          target,
          target.login.user,
          forwarding(socket, extra)
        );

        return yield* open({
          program: ssh,
          args,
          directory,
          socket,
          machine: id,
        });
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new LocalTunnelError({
              message: `couldn't prepare the tunnel to ${id}: ${error.message}`,
            })
          )
        )
      )
    );

  const opened = (
    id: string,
    known: Sandbox
  ): Effect.Effect<number, ClankerboxError | LocalTunnelError, Services> =>
    Effect.gen(function* () {
      if (known.held?.value.running() !== true) {
        yield* closed(known);

        const client = yield* Client.Client;
        const target = yield* sshTarget(yield* client.getMachine({ id }));

        yield* relayOf(id, known);
        known.held = yield* tunnelled(id, target);
      }

      return (yield* relayOf(id, known)).port;
    });

  const started = (id: string, known: Sandbox) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;

      yield* client.startMachine({ id });
      yield* closed(known);
    });

  const made = (named: string) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;
      const { from } = options;

      if ("checkpoint" in from) {
        return yield* client.restoreMachine({ ...from, name: named });
      }

      if ("machine" in from) {
        return yield* client.forkMachine({ ...from, name: named });
      }

      return yield* client.create(named, from);
    });

  return {
    create: call(
      Effect.suspend(() => {
        const named = `${options.namePrefix ?? "sandbox"}-${Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(4)))}`;

        return made(named).pipe(
          Effect.map((machine) => machine.id),
          Effect.catch(discard)
        );
      })
    ),
    destroy: (id: string) =>
      call(
        locked(id, (known) =>
          Effect.gen(function* () {
            const client = yield* Client.Client;

            yield* client
              .deleteMachine({ id })
              .pipe(Effect.ensuring(closed(known)));
            yield* released(known);
          })
        )
      ),
    pause: (id: string) =>
      call(
        onMachine(id, (known) =>
          Effect.gen(function* () {
            const client = yield* Client.Client;

            yield* client
              .stopMachine({ id })
              .pipe(Effect.ensuring(closed(known)));
          })
        )
      ),
    resize: (id: string, sizes: Sizing) =>
      call(
        onMachine(id, () =>
          Effect.flatMap(Client.Client, (client) =>
            client.resizeMachine({ ...sizes, id })
          ).pipe(
            Effect.map(({ cpu, ramMib, diskGib }) => ({ cpu, ramMib, diskGib }))
          )
        )
      ),
    reconnect: (id: string) =>
      call(onMachine(id, (known) => started(id, known))),
    ensureServer: (id: string) =>
      endedByDispose(
        onMachine(id, (known) =>
          Effect.gen(function* () {
            const port = yield* opened(id, known).pipe(
              Effect.asSome,
              Effect.catchIf(
                (error) => !isLocal(error),
                () => Effect.succeedNone
              )
            );

            if (
              Option.isSome(port) &&
              (yield* healthy(fetchOf(id), urlOf(port.value)))
            ) {
              return;
            }

            yield* started(id, known);
            yield* opened(id, known);
          })
        )
      ),
    url: (id: string) =>
      endedByDispose(
        onMachine(id, (known) => Effect.map(opened(id, known), urlOf))
      ),
    fetch: (id: string) => call(Effect.sync(() => fetchOf(id))),
    closeAll: Effect.gen(function* () {
      yield* Deferred.succeed(closing, undefined);
      yield* Fiber.awaitAll([...calls]);
      yield* Effect.forEach([...sandboxes.values()], released, {
        discard: true,
      });
    }),
  };
};
