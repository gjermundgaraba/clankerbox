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
  type MachineSpec,
  pinnedSsh,
  Prebuild,
  Precondition,
  readSetup,
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
import { forwarding, freePort, LocalTunnelError, open, type Tunnel } from "./tunnel.ts";

/** The provider's name, which prefixes every sandbox ID the SDK hands out. */
export const name = "clankerbox";

export const defaultCwd = "/home/sandbox";

/**
 * How long a health check through the tunnel may take: the agent answers on loopback in
 * milliseconds, so one that takes longer is treated as not answering.
 */
const healthWait = Duration.seconds(3);

const Health = Schema.Struct({ status: Schema.Literal("ok") });

const isHealth = Schema.is(Health);

/** A sandbox's tunnel and the scope that ends it. */
interface Held {
  readonly tunnel: Tunnel;
  readonly scope: Scope.Closeable;
}

/**
 * What the provider holds for a sandbox: the lock its calls take turns on, so two never open its
 * tunnel twice; its local port, from its first tunnel until it is destroyed, since an SDK client
 * asks for a sandbox's URL only once; and its tunnel while one is open. A destroyed sandbox's
 * record keeps only its lock, since a call may still be waiting on it.
 */
interface Sandbox {
  readonly lock: Semaphore.Semaphore;
  port: number | undefined;
  held: Held | undefined;
}

/** What the sandboxes' effects need: the clankerbox client and the platform. */
export type Services =
  | Client.Client
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * The sandboxes of one provider. `ssh` is the program its tunnels run. A sandbox's ID is its
 * machine's ID.
 */
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

  /**
   * Runs `use` on the sandbox's record, holding its lock: each of the sandbox's operations runs
   * whole under it, so two never overlap, as the host would refuse the second's start or stop
   * while the first's runs.
   */
  const locked = <A, E, R>(id: string, use: (known: Sandbox) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const known = sandbox(id);

      return Semaphore.withPermit(
        known.lock,
        Effect.suspend(() => use(known)),
      );
    });

  /** The sandbox's port: its own, or a free one no other sandbox of this provider keeps. */
  const portOf = (known: Sandbox): Effect.Effect<number, Internal> =>
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

  /** Ends the sandbox's tunnel, if it has one. */
  const closed = (known: Sandbox) =>
    Effect.suspend(() => {
      const was = known.held;

      known.held = undefined;

      return was === undefined ? Effect.void : Scope.close(was.scope, Exit.void);
    });

  /**
   * The sandbox's port, with its tunnel open: the one it has while that runs, and otherwise a
   * new one. The machine is read for each tunnel, as its endpoint changes: on boat at every start.
   */
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
      const target = sshTarget(yield* client.machine(id));

      if ("lacks" in target) {
        return yield* new Precondition({
          message: `${id} has no ${target.lacks}, which its tunnel needs: see clankerbox get ${id}`,
        });
      }

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

  /** Whether the Sandbox Agent answers its health check through the tunnel. */
  const healthy = (port: number): Effect.Effect<boolean> =>
    Effect.tryPromise((signal) =>
      fetch(`http://127.0.0.1:${port}/v1/health`, { signal }).then((reply) => reply.json()),
    ).pipe(
      Effect.map(isHealth),
      Effect.timeoutOrElse({ duration: healthWait, orElse: () => Effect.succeed(false) }),
      Effect.catch(() => Effect.succeed(false)),
    );

  /**
   * Starts the machine, which boots a stopped one and runs a running one's preparation again,
   * and so its `/etc/clankerbox/start`. Its tunnel ends: the endpoint may have changed. A machine
   * that no longer exists is the SDK's `SandboxDestroyedError`, for `reconnect` and
   * `ensureServer` alike.
   */
  const started = (id: string, known: Sandbox) =>
    Effect.gen(function* () {
      const client = yield* Client.Client;

      yield* client.start(id);
      yield* closed(known);
    }).pipe(
      Effect.catchTag("NotFound", (cause) =>
        Effect.fail(new SandboxDestroyedError(id, name, { cause })),
      ),
    );

  /**
   * Makes the machine `named`, from the options' source. A profile with a setup is restored from
   * its host's prebuild of it when there is one, as `clankerbox create` does, unless `fresh`.
   */
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
      let spec: MachineSpec = { ...sizes, profile: label };

      if (setup !== undefined) {
        const { path, ...timeout } = setup;

        spec = { ...spec, setup: { script: yield* readSetup(path), ...timeout } };
      }

      if (options.fresh === true) {
        return yield* client.create(named, spec, { host });
      }

      const { machine } = yield* Prebuild.create(client, named, spec, { host });

      return machine;
    });

  /**
   * Tries to delete what a failed create may have left: a machine whose setup failed, or whose
   * fork or restore failed natively, stays on its host, and only the provider knows its name. The
   * host is the placement's to pick, so the machine is found by its name, which is random. A host
   * that doesn't answer, or a delete that fails, leaves it to `clankerbox machines`.
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
    /**
     * Makes a sandbox's machine, and returns its ID once its create, fork or restore is done.
     * Only the failures that can leave a machine behind discard it: a refusal, such as a name
     * already taken, leaves nothing of this create's.
     */
    create: Effect.suspend(() => {
      const named = `${options.namePrefix ?? "sandbox"}-${randomBytes(4).toString("hex")}`;

      const discarding = <E>(error: E) => Effect.andThen(discard(named), Effect.fail(error));

      return made(named).pipe(
        Effect.map((machine) => machine.id),
        Effect.catchTags({
          Precondition: discarding,
          Internal: discarding,
          Unavailable: discarding,
        }),
      );
    }),
    /**
     * Deletes the machine, holding the sandbox's lock throughout. One that is already gone is
     * destroyed. Its port goes only once it is: a delete that fails leaves the sandbox as it was,
     * its tunnel aside.
     */
    destroy: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const client = yield* Client.Client;

          yield* closed(known);
          yield* Effect.catchTag(client.delete(id), "NotFound", () => Effect.void);
          known.port = undefined;
        }),
      ),
    /** Stops the machine: its disk stays, and `reconnect` starts it again. */
    pause: (id: string) =>
      locked(id, (known) =>
        Effect.gen(function* () {
          const client = yield* Client.Client;

          yield* closed(known);
          yield* client.stop(id);
        }),
      ),
    /**
     * Starts the machine, which boots a stopped one and leaves a running one running. A machine
     * that no longer exists is the SDK's `SandboxDestroyedError`. The SDK's `ensureServer`,
     * which follows, opens the tunnel.
     */
    reconnect: (id: string) => locked(id, (known) => started(id, known)),
    /**
     * Brings back what a failed health check may have lost. A tunnel that ended is opened again;
     * if the agent still doesn't answer, or the tunnel can't open for a reason on the machine's
     * side, the machine is started, whose start hook relaunches an agent that doesn't answer, and
     * its tunnel opened anew. A tunnel that fails for a reason of this machine's fails at once,
     * since no start changes it. The SDK calls this only while it starts: a tunnel that ends
     * later stays down until a caller calls it again.
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
    /** The loopback URL that leads to the sandbox's agent. */
    url: (id: string) =>
      locked(id, (known) => Effect.map(opened(id, known), (port) => `http://127.0.0.1:${port}`)),
    /** Ends every tunnel. The machines stay as they are. */
    closeAll: Effect.suspend(() =>
      Effect.forEach([...sandboxes.keys()], (id) => locked(id, closed), { discard: true }),
    ),
  };
};
