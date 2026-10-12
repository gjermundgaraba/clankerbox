/**
 * Sandboxes for Rivet's Sandbox Agent, each a clankerbox machine: the lifecycle a
 * `SandboxProvider` asks for, over the clankerbox client, and a tunnel to the Sandbox Agent
 * each machine runs.
 *
 * The machine runs the Sandbox Agent itself: its setup installs it, and its
 * `/etc/clankerbox/start` launches it on the guest's loopback at every activation, as the
 * recipes beside this package do. A machine exposes only guest port 22, so the provider reaches
 * the agent through an ssh port forward, pinned to the machine's host key, and gives the SDK a
 * loopback URL of this machine.
 */
import { randomBytes } from "node:crypto";
import {
  type ClankerboxError,
  Client,
  Internal,
  loadProfile,
  pinnedSsh,
  Precondition,
  readSetup,
  type Setup,
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
import type { Options } from "./options.ts";
import { forwarding, freePort, open, type Tunnel } from "./tunnel.ts";

/** The provider's name, which prefixes every sandbox ID the SDK hands out. */
export const name = "clankerbox";

/** The Sandbox Agent's own default port. */
const defaultAgentPort = 2468;

export const defaultCwd = "/home/sandbox";

/** How long a health check through the tunnel may take. */
const healthWait = Duration.seconds(3);

const Health = Schema.Struct({ status: Schema.Literal("ok") });

const isHealth = Schema.is(Health);

/** A setup script with its timeout, or without one, which leaves the timeout to the host. */
const timed = (script: string, timeoutSeconds: number | undefined): Setup =>
  timeoutSeconds === undefined ? { script } : { script, timeoutSeconds };

/** A sandbox's tunnel and the scope that ends it. The port outlasts the tunnel. */
interface Held {
  readonly port: number;
  readonly tunnel: Tunnel;
  readonly scope: Scope.Closeable;
}

type Services =
  | Client.Client
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * The sandboxes of one provider. `ssh` is the program its tunnels run. A sandbox's ID is its
 * machine's ID.
 */
export const make = (options: Options, ssh = "ssh") => {
  const agentPort = options.agentPort ?? defaultAgentPort;
  const held = new Map<string, Held>();

  // Opens and closes of tunnels take turns, so two calls never open one sandbox's tunnel twice.
  const turn = Semaphore.makeUnsafe(1);

  const close = (id: string) =>
    Effect.suspend(() => {
      const was = held.get(id);

      held.delete(id);

      return was === undefined ? Effect.void : Scope.close(was.scope, Exit.void);
    });

  /**
   * The sandbox's port, with its tunnel open: the one it has while that runs, and otherwise a
   * new one on the same port, since the SDK asks for a sandbox's URL only once. The machine is
   * read for each tunnel, as its endpoint changes: on boat at every start.
   */
  const opened = (id: string): Effect.Effect<number, ClankerboxError, Services> =>
    Effect.gen(function* () {
      const was = held.get(id);

      if (was?.tunnel.running() === true) {
        return was.port;
      }

      if (was !== undefined) {
        yield* Scope.close(was.scope, Exit.void);
      }

      const client = yield* Client.Client;
      const target = sshTarget(yield* client.machine(id));

      if ("lacks" in target) {
        return yield* new Precondition({
          message: `${id} has no ${target.lacks}, which its tunnel needs: see clankerbox get ${id}`,
        });
      }

      const port = was?.port ?? (yield* freePort);
      const scope = yield* Scope.make();

      const tunnel = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clankerbox-tunnel-" });

        const args = yield* pinnedSsh(target, options.sshUser ?? target.login.user, [
          ...(options.sshArguments ?? []),
          ...forwarding(port, agentPort),
        ]);

        return yield* open({ program: ssh, args, directory, port, machine: id });
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new Internal({ message: `couldn't prepare the tunnel to ${id}: ${error.message}` }),
          ),
        ),
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );

      held.set(id, { port, tunnel, scope });

      return port;
    }).pipe(Semaphore.withPermit(turn));

  /** Whether the Sandbox Agent answers its health check through the tunnel. */
  const healthy = (port: number): Effect.Effect<boolean> =>
    Effect.tryPromise((signal) =>
      fetch(`http://127.0.0.1:${port}/v1/health`, { signal }).then((reply) => reply.json()),
    ).pipe(
      Effect.map(isHealth),
      Effect.timeoutOrElse({ duration: healthWait, orElse: () => Effect.succeed(false) }),
      Effect.catch(() => Effect.succeed(false)),
    );

  /** Makes the machine `named`, from the options' source. */
  const made = (named: string) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;
      const { from } = options;

      if ("checkpoint" in from) {
        return yield* client.restore(from.checkpoint, named);
      }

      if ("machine" in from) {
        return yield* client.fork(from.machine, named);
      }

      const { label, host, setup, ...sizes } = yield* loadProfile(from.profile);
      const spec = { ...sizes, profile: label };

      if (setup === undefined) {
        return yield* client.create(named, spec, { host });
      }

      const script = yield* readSetup(setup.path);

      return yield* client.create(
        named,
        { ...spec, setup: timed(script, setup.timeoutSeconds) },
        { host },
      );
    });

  /**
   * Deletes what a failed create left: a machine whose setup failed stays on its host, unmade,
   * and the provider is the only one that knows its name. The host is the placement's to pick,
   * so the machine is found by its name, which is random.
   */
  const discard = (named: string) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;
      const { answers } = yield* client.machines;

      yield* Effect.forEach(
        answers.filter((machine) => machine.id.endsWith(`_${named}`)),
        (machine) => Effect.ignore(client.delete(machine.id)),
        { discard: true },
      );
    });

  return {
    /** Makes a sandbox's machine, and returns its ID once its create, fork or restore is done. */
    create: Effect.suspend(() => {
      const named = `${options.namePrefix ?? "sandbox"}-${randomBytes(4).toString("hex")}`;

      return made(named).pipe(
        Effect.map((machine) => machine.id),
        Effect.tapError(() => discard(named)),
      );
    }),
    /** Deletes the machine. One that is already gone is destroyed. */
    destroy: (id: string) =>
      Effect.gen(function* () {
        const client = yield* Client.Client;

        yield* close(id).pipe(Semaphore.withPermit(turn));
        yield* Effect.catchTag(client.delete(id), "NotFound", () => Effect.void);
      }),
    /** Stops the machine: its disk stays, and `reconnect` starts it again. */
    pause: (id: string) =>
      Effect.gen(function* () {
        const client = yield* Client.Client;

        yield* close(id).pipe(Semaphore.withPermit(turn));
        yield* client.stop(id);
      }),
    /**
     * Starts the machine, which boots a stopped one and leaves a running one running, and opens
     * its tunnel. A machine that no longer exists is the SDK's `SandboxDestroyedError`.
     */
    reconnect: (id: string) =>
      Effect.gen(function* () {
        const client = yield* Client.Client;

        yield* Effect.catchTag(client.start(id), "NotFound", (cause) =>
          Effect.fail(new SandboxDestroyedError(id, name, { cause })),
        );

        yield* opened(id);
      }),
    /**
     * Brings back what a failed health check may have lost. A tunnel that ended is opened again;
     * if the agent still doesn't answer, the machine is started, which runs its preparation and
     * so its `/etc/clankerbox/start`, the hook that relaunches the agent.
     */
    ensureServer: (id: string) =>
      Effect.gen(function* () {
        const client = yield* Client.Client;
        const port = yield* Effect.option(opened(id));

        if (Option.isSome(port) && (yield* healthy(port.value))) {
          return;
        }

        yield* client.start(id);
        yield* opened(id);
      }),
    /** The loopback URL that leads to the sandbox's agent. */
    url: (id: string) => Effect.map(opened(id), (port) => `http://127.0.0.1:${port}`),
    /** Ends every tunnel. The machines stay as they are. */
    closeAll: Effect.suspend(() => Effect.forEach([...held.keys()], close, { discard: true })).pipe(
      Semaphore.withPermit(turn),
    ),
  };
};

export type Sandboxes = ReturnType<typeof make>;
