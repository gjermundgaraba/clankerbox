import { randomBytes } from "node:crypto";
import {
  actionsByName,
  type ClankerboxError,
  Client,
  Conflict,
  loadProfile,
  pinnedSsh,
  Prebuild,
  specRequest,
  sshTarget,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  type Path,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { SandboxDestroyedError } from "sandbox-agent";
import { healthPath } from "./agent.ts";
import type { Options } from "./options.ts";
import { forwarding, freePort, LocalTunnelError, open, type Tunnel } from "./tunnel.ts";

/** The calls that make a machine, whose failure may leave it on its host. */
const makers = [
  actionsByName.createMachine,
  actionsByName.forkMachine,
  actionsByName.restoreMachine,
];

export const name = "clankerbox";

export const defaultCwd = "/home/sandbox";

/** The agent answers on loopback in milliseconds, so a slower one counts as not answering. */
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

  /** A sandbox's operations never overlap: the host would refuse a second start or stop as busy. */
  const locked = <A, E, R>(id: string, use: (known: Sandbox) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const known = sandbox(id);

      return Semaphore.withPermit(
        known.lock,
        Effect.suspend(() => use(known)),
      );
    });

  const portOf = (known: Sandbox): Effect.Effect<number, LocalTunnelError> =>
    Effect.gen(function* () {
      if (known.port !== undefined) {
        return known.port;
      }

      const taken = (port: number) => [...sandboxes.values()].some((other) => other.port === port);

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

      return was === undefined ? Effect.void : Scope.close(was.scope, Exit.void);
    });

  /** The machine is read for each tunnel, as its endpoint changes: on boat at every start. */
  const opened = (
    id: string,
    known: Sandbox,
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
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clankerbox-tunnel-" });

        const args = yield* pinnedSsh(
          target,
          options.sshUser ?? target.login.user,
          forwarding(port, options.sshArguments ?? []),
        );

        return yield* open({ program: ssh, args, directory, port, machine: id });
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new LocalTunnelError({
              message: `couldn't prepare the tunnel to ${id}: ${error.message}`,
            }),
          ),
        ),
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );

      known.held = { tunnel, scope };

      return port;
    });

  const healthy = (port: number): Effect.Effect<boolean> =>
    Effect.tryPromise((signal) =>
      fetch(`http://127.0.0.1:${port}${healthPath}`, { signal }).then((reply) => reply.json()),
    ).pipe(
      Effect.map(isHealth),
      Effect.timeoutOrElse({ duration: healthWait, orElse: () => Effect.succeed(false) }),
      Effect.catch(() => Effect.succeed(false)),
    );

  /** A start reruns a running machine's start hook and may move its endpoint: the tunnel ends. */
  const started = (id: string, known: Sandbox) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;

      yield* client.startMachine({ id });
      yield* closed(known);
    }).pipe(
      Effect.catchTag("NotFound", (cause) =>
        Effect.fail(new SandboxDestroyedError(id, name, { cause })),
      ),
    );

  const made = (named: string) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;
      const { from } = options;

      if ("checkpoint" in from) {
        return yield* client.restoreMachine({ checkpoint: from.checkpoint, name: named });
      }

      if ("machine" in from) {
        return yield* client.forkMachine({ machine: from.machine, name: named });
      }

      const { spec, host } = yield* specRequest("create", yield* loadProfile(from.profile), {});

      const { machine } = yield* Prebuild.create(client, named, spec, {
        host,
        fresh: options.fresh,
      });

      return machine;
    });

  /**
   * Only a failed create, fork or restore leaves its machine on the host, and then its error's
   * `made` names it; a delete of one it never wrote is `absent`. A `Conflict` is about a machine
   * another call holds or made, so it is never deleted. A failed delete leaves it to the user.
   */
  const discard = (error: ClankerboxError) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;

      if (error.made !== undefined && makers.some(({ name }) => name === error.action)) {
        yield* Effect.ignore(client.deleteMachine({ id: error.made }));
      }

      return yield* error;
    });

  return {
    create: Effect.suspend(() => {
      const named = `${options.namePrefix ?? "sandbox"}-${randomBytes(4).toString("hex")}`;

      return made(named).pipe(
        Effect.map((machine) => machine.id),
        Effect.catch((error) => (error instanceof Conflict ? Effect.fail(error) : discard(error))),
      );
    }),
    destroy: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const client = yield* Client.Client;

          yield* closed(known);
          yield* client.deleteMachine({ id });
          known.port = undefined;
        }),
      ),
    pause: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const client = yield* Client.Client;

          yield* closed(known);
          yield* client.stopMachine({ id });
        }),
      ),
    /** The SDK's `ensureServer`, which follows, opens the tunnel. */
    reconnect: (id: string) => locked(id, (known) => started(id, known)),
    /**
     * A local tunnel failure fails at once, since no start changes it. The SDK calls this only
     * while it starts: a tunnel that ends later stays down until a caller calls it again.
     */
    ensureServer: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const port = yield* opened(id, known).pipe(
            Effect.asSome,
            Effect.catchIf(
              (error) => !(error instanceof LocalTunnelError),
              () => Effect.succeedNone,
            ),
          );

          if (Option.isSome(port) && (yield* healthy(port.value))) {
            return;
          }

          yield* started(id, known);
          yield* opened(id, known);
        }),
      ),
    url: (id: string) =>
      locked(id, (known) => Effect.map(opened(id, known), (port) => `http://127.0.0.1:${port}`)),
    closeAll: Effect.suspend(() =>
      Effect.forEach([...sandboxes.keys()], (id) => locked(id, closed), { discard: true }),
    ),
  };
};
