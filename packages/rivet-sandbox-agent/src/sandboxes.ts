import {
  Client,
  Conflict,
  loadProfile,
  pinnedSsh,
  Prebuild,
  specRequest,
  sshTarget,
  Superseded,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  ClankerboxError,
  NotFound,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import type { Path } from "effect";
import { Hex } from "effect/encoding";
import type { ChildProcessSpawner } from "effect/process";
import { SandboxDestroyedError } from "sandbox-agent";

import { healthPath } from "./agent.ts";
import type { Options } from "./options.ts";
import { forwarding, freePort, LocalTunnelError, open } from "./tunnel.ts";
import type { Tunnel } from "./tunnel.ts";

export const name = "clankerbox";

export const defaultCwd = "/home/admin";

const healthWait = Duration.seconds(3);

const Health = Schema.Struct({ status: Schema.Literal("ok") });

const isHealth = Schema.is(Health);

interface Held {
  readonly tunnel: Tunnel;
  readonly scope: Scope.Closeable;
}

/**
 * The port is kept from the first tunnel until destroy, since an SDK client asks for a URL only
 * once. A destroyed sandbox keeps its lock, since a call may still be waiting on it.
 */
interface Sandbox {
  readonly lock: Semaphore.Semaphore;
  port: number | undefined;
  held: Held | undefined;
}

const healthy = (port: number): Effect.Effect<boolean> =>
  Effect.tryPromise(async (signal) => {
    const reply = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
      signal,
    });

    return await reply.json();
  }).pipe(
    Effect.map(isHealth),
    Effect.timeoutOrElse({
      duration: healthWait,
      orElse: () => Effect.succeed(false),
    }),
    Effect.orElseSucceed(() => false)
  );

const destroyed = (id: string) => (cause: NotFound) =>
  Effect.fail(new SandboxDestroyedError(id, name, { cause }));

const discard = (error: ClankerboxError) =>
  Effect.gen(function* () {
    const client = yield* Client.Client;

    if (
      error.made !== undefined &&
      !(error instanceof Conflict || error instanceof Superseded)
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

export const make = (options: Options, ssh = "ssh") => {
  const sandboxes = new Map<string, Sandbox>();

  const sandbox = (id: string): Sandbox => {
    const known = sandboxes.get(id) ?? {
      lock: Semaphore.makeUnsafe(1),
      port: undefined,
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

  const taken = (port: number) =>
    [...sandboxes.values()].some((other) => other.port === port);

  const portOf = (known: Sandbox): Effect.Effect<number, LocalTunnelError> =>
    Effect.gen(function* () {
      if (known.port !== undefined) {
        return known.port;
      }

      let port = yield* freePort;

      while (taken(port)) {
        port = yield* freePort;
      }

      known.port = port;

      return port;
    });

  const closed = (known: Sandbox) =>
    Effect.suspend(() => {
      const was = known.held;

      known.held = undefined;

      return was === undefined
        ? Effect.void
        : Scope.close(was.scope, Exit.void);
    });

  const opened = (
    id: string,
    known: Sandbox
  ): Effect.Effect<number, ClankerboxError | LocalTunnelError, Services> =>
    Effect.gen(function* () {
      if (known.held?.tunnel.running() === true) {
        return yield* portOf(known);
      }

      yield* closed(known);

      const client = yield* Client.Client;
      const target = yield* sshTarget(yield* client.getMachine({ id }));

      const port = yield* portOf(known);
      const scope = yield* Scope.make();

      const tunnel = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "clankerbox-tunnel-",
        });

        const args = yield* pinnedSsh(
          target,
          target.login.user,
          forwarding(port, options.sshArguments ?? [])
        );

        return yield* open({
          program: ssh,
          args,
          directory,
          port,
          machine: id,
        });
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new LocalTunnelError({
              message: `couldn't prepare the tunnel to ${id}: ${error.message}`,
            })
          )
        ),
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void))
      );

      known.held = { tunnel, scope };

      return port;
    });

  const started = (id: string, known: Sandbox) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;

      yield* client.startMachine({ id });
      yield* closed(known);
    }).pipe(Effect.catchTag("NotFound", destroyed(id)));

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

      const { spec, host } = yield* specRequest(
        "create",
        yield* loadProfile(from.profile),
        {
          authorizedKeys: options.authorizedKeys,
          cpu: from.cpu,
          ramMib: from.ramMib,
          diskGib: from.diskGib,
        }
      );

      const { machine } = yield* Prebuild.create(client, named, spec, {
        host,
        fresh: options.fresh,
      });

      return machine;
    });

  return {
    create: Effect.suspend(() => {
      const named = `${options.namePrefix ?? "sandbox"}-${Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(4)))}`;

      return made(named).pipe(
        Effect.map((machine) => machine.id),
        Effect.catch(discard)
      );
    }),
    destroy: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const client = yield* Client.Client;

          yield* closed(known);
          yield* client.deleteMachine({ id });
          known.port = undefined;
        })
      ),
    pause: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const client = yield* Client.Client;

          yield* closed(known);
          yield* client.stopMachine({ id });
        })
      ),
    resize: (id: string, sizes: Sizing) =>
      locked(id, () =>
        Effect.flatMap(Client.Client, (client) =>
          client.resizeMachine({ ...sizes, id })
        ).pipe(
          Effect.map(({ cpu, ramMib, diskGib }) => ({ cpu, ramMib, diskGib })),
          Effect.catchTag("NotFound", destroyed(id))
        )
      ),
    reconnect: (id: string) => locked(id, (known) => started(id, known)),
    ensureServer: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const port = yield* opened(id, known).pipe(
            Effect.asSome,
            Effect.catchIf(
              (error) => !(error instanceof LocalTunnelError),
              () => Effect.succeedNone
            )
          );

          if (Option.isSome(port) && (yield* healthy(port.value))) {
            return;
          }

          yield* started(id, known);
          yield* opened(id, known);
        })
      ),
    url: (id: string) =>
      locked(id, (known) =>
        Effect.map(opened(id, known), (port) => `http://127.0.0.1:${port}`)
      ),
    closeAll: Effect.suspend(() =>
      Effect.forEach([...sandboxes.keys()], (id) => locked(id, closed), {
        discard: true,
      })
    ),
  };
};
