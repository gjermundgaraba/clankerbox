/**
 * The boat runtime: Linux sandboxes in boat.dev's cloud, through its HTTP API v1 (`boat-api.ts`),
 * designed for boat's trial. boat runs its own machines, so the host supervises nothing and needs
 * no root, and machines get no host port: guest port 22 is reached at boat's SSH relay, or at
 * the sandbox's own address.
 *
 * boat assigns sandbox IDs, so the runtime records each one on its row (`native`) as soon as
 * boat answers, through the core's `recordNative`, and reads it from the machine the core
 * passes; a row without one has nothing on boat the host can find. A named snapshot's name derives from the host ID and the row's instance, so a checkpoint
 * row needs none.
 *
 * The refusal rule covers boat's answers that leave nothing on boat (evidence.md, boat claims):
 * its `Capacity` refusals of a create, fork, resume, restore or capture (the account's limits,
 * no machine, an 11th named snapshot), its `Precondition` refusal of a type the account's plan
 * lacks, a create, fork or restore that ends `cancelled` or gone because boat found no machine,
 * and a fork's or capture's source boat doesn't have.
 */
import { join } from "node:path";
import {
  Capacity,
  type HostError,
  Internal,
  Precondition,
  type SshEndpoint,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  type Redacted,
  Ref,
  Schedule,
  Stream,
} from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import {
  baseUrl,
  idempotencyKey,
  machineType,
  make as makeApi,
  type Sandbox,
  snapshotName,
} from "./boat-api.ts";
import { sshKey } from "./boat-key.ts";
import { cliIn, describe, files } from "./cli.ts";
import type { BoatHost } from "./config.ts";
import { lastLines } from "./guest.ts";
import {
  type Command,
  type Interface,
  type MachineRef,
  type MachineState,
  type Observed,
  type RecordNative,
  Refusal,
  Runtime,
} from "./runtime.ts";

/**
 * What the runtime needs: the API key and where boat is, the host it runs for, and the core's
 * record of a sandbox ID on its machine's row.
 */
export interface Settings {
  readonly apiKey: Redacted.Redacted<string>;
  /** `baseUrl` in production; tests point it at a fake. */
  readonly url: string;
  readonly hostId: string;
  readonly stateDir: string;
  readonly recordNative: RecordNative;
}

/** The API version the host is built for, which the host reports as its runtime's version. */
const apiVersion = "v1";

/** The states of a sandbox that runs; boat reports `ready` before its lazy restore is done. */
const upStates: ReadonlySet<string> = new Set(["ready", "idle", "running"]);

/**
 * The states boat counts as active (`GET /limits`): those that run, and a sandbox still being
 * made or resumed, which `stop` must not skip.
 */
const activeStates: ReadonlySet<string> = new Set([...upStates, "provisioned", "cloning"]);

/**
 * A machine's state from its sandbox's: an active sandbox runs, a cancelled one is gone, and
 * anything else, `error` included, is stopped.
 */
export const stateOf = (state: string): MachineState =>
  activeStates.has(state) ? "running" : state === "cancelled" ? "missing" : "stopped";

/**
 * Where guest port 22 is: boat's public IPv4 relay `host:port` when the sandbox has one, else
 * its own address. Both change on every start, so they are read with the state, never stored.
 */
export const endpointOf = (sandbox: Sandbox): SshEndpoint | undefined => {
  const relay = sandbox.sshEndpoint;

  if (relay !== undefined && relay !== null) {
    const at = relay.lastIndexOf(":");
    const port = Number(relay.slice(at + 1));

    return at > 0 && Number.isInteger(port) && port >= 1 && port <= 65_535
      ? { host: relay.slice(0, at).replace(/^\[(.*)\]$/u, "$1"), port }
      : undefined;
  }

  return sandbox.ip === undefined || sandbox.ip === null
    ? undefined
    : { host: sandbox.ip, port: 22 };
};

/** What boat says went wrong with a sandbox, as an error's tail. */
const why = (sandbox: Pick<Sandbox, "error">): string =>
  sandbox.error === undefined || sandbox.error === null ? "" : `: ${sandbox.error}`;

/** One argument as a POSIX shell reads it back: single-quoted, with `'` written `'\''`. */
export const quote = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`;

/**
 * The command line an exec sends: ssh joins its arguments into one string that the guest's
 * shell parses, so every argument is quoted. `user` runs it as root through `sudo -n`.
 */
export const remoteCommand = (argv: ReadonlyArray<string>): string =>
  ["sudo", "-n", "--", ...argv].map(quote).join(" ");

/** The guest's SSH host keys, which the runtime reads over boat's API before every SSH. */
const hostKeysCommand = "cat /etc/ssh/ssh_host_*_key.pub";

/** A public key line: its type, then its base64 blob, which always begins with `AAAA`. */
const hostKeyLine = /^((?:ssh|ecdsa|sk)-[a-z0-9@.-]+) (AAAA[A-Za-z0-9+/]+={0,3})(?:\s|$)/u;

/** The known-hosts lines that pin the keys `printed` under `alias`. */
export const knownHosts = (alias: string, printed: string): ReadonlyArray<string> =>
  printed.split("\n").flatMap((line) => {
    const match = hostKeyLine.exec(line.trim());

    return match === null ? [] : [`${alias} ${match[1]} ${match[2]}`];
  });

/**
 * boat's marker that `/var/lib` and `/var/opt` are restored in full after a fork, resume or
 * restore. It is undocumented: re-check it at every change of boat's API or image.
 */
export const restoredMarker = "/var/lib/ascii-lazy/sys-done";

/** Where `ssh` is, on macOS and on Ubuntu. */
const searchPath = "/usr/bin:/bin";

/**
 * How long a sandbox may take to run after a create, fork, resume or restore: boat answered
 * ready 0.1–4.4 s after one, and without `failFast` a call waits for a machine.
 */
const upWait = Duration.minutes(10);

const upPause = Duration.seconds(1);

/** How long until SSH answers once boat reads the sandbox ready. */
const sshWait = Duration.minutes(3);

const sshPause = Duration.seconds(2);

/**
 * How long `/var/lib` may take to be restored: 10–14 s with 1 GiB there, and Docker keeps its
 * images and volumes there too.
 */
const markerWait = Duration.minutes(10);

/** How long until boat reads a stopped sandbox `archived`; it took 2.3–18.9 s. */
const stopWait = Duration.minutes(5);

const stopPause = Duration.seconds(1);

/** How long a deleted sandbox may take to answer 404; it took under a second. */
const deleteWait = Duration.minutes(1);

const deletePause = Duration.millis(500);

/**
 * How long a running fork source may take to complete a snapshot attempt begun after its sync:
 * 41 s with little new data, 102 s after writing 3 GiB. boat attempts one about once a minute.
 */
const snapshotWait = Duration.minutes(10);

const snapshotPause = Duration.seconds(5);

/** How long a named snapshot may take to save: about two minutes from a running sandbox. */
const captureWait = Duration.minutes(15);

const capturePause = Duration.seconds(3);

/** How long `sync` may take in a fork's source. */
const syncWait = Duration.minutes(5);

/** How long reading the host keys over boat's command API may take, in the guest. */
const hostKeysTimeoutSeconds = 30;

/** Waits until `read` answers `Some`, polling every `pause`; `None` once `wait` has passed. */
const poll = <A, E, R>(
  read: Effect.Effect<Option.Option<A>, E, R>,
  pause: Duration.Duration,
  wait: Duration.Duration,
) =>
  read.pipe(
    Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(pause) }),
    Effect.timeoutOption(wait),
    Effect.map(Option.flatten),
  );

export const make = (
  settings: Settings,
): Effect.Effect<
  Interface,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const api = yield* makeApi({ apiKey: settings.apiKey, url: settings.url });
    const { exec: spawn } = yield* cliIn({ PATH: searchPath });

    // Generated the first time the runtime starts in the state dir; the store holds its lock.
    const key = yield* sshKey(settings.stateDir);
    const keyDir = join(settings.stateDir, "boat-ssh");

    const keyOf = (machine: MachineRef) => idempotencyKey(settings.hostId, machine.instance);
    const snapshotOf = (instance: string) => snapshotName(settings.hostId, instance);

    /**
     * The machine's sandbox ID, from its row. The core reads the row again after a create, fork
     * or restore, and the runtime's own steps pass on the ID they made.
     */
    const sandboxOf = (machine: MachineRef): Option.Option<string> =>
      Option.fromNullishOr(machine.native);

    const recordedSandbox = (machine: MachineRef) =>
      Option.match(sandboxOf(machine), {
        onNone: () =>
          Effect.fail(
            new Internal({ message: `machine ${machine.id} has no boat sandbox recorded` }),
          ),
        onSome: Effect.succeed,
      });

    /**
     * A source boat has, for a fork or a capture: one without a recorded sandbox, or one boat
     * reports cancelled or gone, is refused before anything native.
     */
    const sourceSandbox = (machine: MachineRef) =>
      Effect.gen(function* () {
        const missing = new Refusal({
          error: new Precondition({
            message: `machine ${machine.id} is missing from the boat runtime; delete it`,
          }),
        });

        const id = sandboxOf(machine);

        if (Option.isNone(id)) {
          return yield* missing;
        }

        const found = yield* api.sandbox(id.value);

        if (Option.isNone(found) || stateOf(found.value.state) === "missing") {
          return yield* missing;
        }

        return found.value;
      });

    /**
     * The boat type that covers a new machine; none is a `Precondition`, refused before
     * anything native.
     */
    const typeOf = (machine: MachineRef) =>
      Effect.mapError(machineType(machine), (error) => new Refusal({ error }));

    /**
     * Calls that make or resume a sandbox, or save a snapshot: boat's `Capacity` refusals, and
     * its `Precondition` refusal of a type the plan lacks, leave nothing on boat, so they fall
     * under the refusal rule. A 404 from them is boat's own (a restore's snapshot deleted under
     * it), not a resource of the host's, so it is `Internal`.
     */
    const refusing = <A>(
      call: Effect.Effect<A, HostError>,
    ): Effect.Effect<A, HostError | Refusal> =>
      call.pipe(
        Effect.catchTags({
          Capacity: (error) => Effect.fail(new Refusal({ error })),
          Precondition: (error) => Effect.fail(new Refusal({ error })),
        }),
        Effect.catchTag("NotFound", (error) =>
          Effect.fail(new Internal({ message: error.message })),
        ),
      );

    /**
     * Waits until boat reads the sandbox running. A create, fork or restore that ends cancelled,
     * or gone, found no machine and left nothing: a refusal. After a resume, either is a
     * failure. An `error` state is boat's failure.
     */
    const running = (machine: MachineRef, id: string, fresh: boolean) => {
      const read = Effect.flatMap(
        api.sandbox(id),
        (found): Effect.Effect<Option.Option<Sandbox>, HostError | Refusal> => {
          if (Option.isSome(found) && upStates.has(found.value.state)) {
            return Effect.succeed(found);
          }

          if (Option.isNone(found) || found.value.state === "cancelled") {
            const said = `boat ${Option.isNone(found) ? "no longer has" : "cancelled"} sandbox ${id} of ${machine.id}${Option.isSome(found) ? why(found.value) : ""}`;

            return Effect.fail(
              fresh
                ? new Refusal({ error: new Capacity({ message: `${said}; it found no machine` }) })
                : new Internal({ message: said }),
            );
          }

          return found.value.state === "error"
            ? Effect.fail(
                new Internal({
                  message: `boat's sandbox ${id} of ${machine.id} failed${why(found.value)}`,
                }),
              )
            : Effect.succeedNone;
        },
      );

      return Effect.flatMap(poll(read, upPause, upWait), (found) =>
        Option.isSome(found)
          ? Effect.void
          : Effect.fail(
              new Internal({
                message: `boat's sandbox ${id} of ${machine.id} didn't run within ${Duration.format(upWait)}`,
              }),
            ),
      );
    };

    /**
     * Pins the guest's current host keys for one SSH connection: read through boat's command
     * API, over HTTPS, into a known-hosts file of the connection's own. Every activation has new
     * keys, and preparation re-mints them, so a pin is never reused.
     */
    const pin = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        const ran = yield* api.command(id, hostKeysCommand, hostKeysTimeoutSeconds);
        const lines = knownHosts(id, ran.stdout);

        if (ran.exitCode !== 0 || lines.length === 0) {
          return yield* new Internal({
            message: `couldn't read ${machine.id}'s SSH host keys through boat's command API (exit ${ran.exitCode ?? "none"}${ran.timedOut ? ", timed out" : ""}): ${lastLines(ran.stderr)}`,
          });
        }

        const directory = yield* Effect.mapError(
          fs.makeTempDirectoryScoped({ directory: keyDir, prefix: "known-hosts-" }),
          (error) =>
            new Internal({
              message: `couldn't make a known-hosts file in ${keyDir}: ${describe(error)}`,
            }),
        );

        const file = join(directory, "known_hosts");

        yield* files(
          `couldn't write ${file}`,
          fs.writeFileString(file, `${lines.join("\n")}\n`, { mode: 0o600 }),
        );

        return file;
      });

    /**
     * Runs a command as root over SSH: as `user`, through `sudo -n`, with the host's own key and
     * the guest's host keys pinned, at the endpoint boat reports now. Each exec opens its own
     * connection. Errors name the machine, never the command.
     */
    const execIn = (machine: MachineRef, id: string, { argv, stdin }: Command) =>
      Effect.gen(function* () {
        const found = yield* api.sandbox(id);

        if (Option.isNone(found) || !upStates.has(found.value.state)) {
          return yield* new Internal({
            message: `machine ${machine.id} doesn't run: boat reads its sandbox ${id} ${Option.isNone(found) ? "gone" : found.value.state}`,
          });
        }

        const endpoint = endpointOf(found.value);

        if (endpoint === undefined) {
          return yield* new Internal({
            message: `boat reports no address for ${machine.id}'s sandbox ${id}`,
          });
        }

        const pinned = yield* pin(machine, id);

        return yield* spawn(
          "ssh",
          [
            "-F",
            "/dev/null",
            "-T",
            "-i",
            key.file,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-o",
            `UserKnownHostsFile=${pinned}`,
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "UpdateHostKeys=no",
            "-o",
            `HostKeyAlias=${id}`,
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "LogLevel=ERROR",
            "-p",
            String(endpoint.port),
            "-l",
            "user",
            "--",
            endpoint.host,
            remoteCommand(argv),
          ],
          stdin,
          `ssh ${machine.id}`,
        );
      });

    const exec: Interface["exec"] = (machine, command) =>
      Effect.flatMap(recordedSandbox(machine), (id) => execIn(machine, id, command));

    /** Runs a command to its end; its exit code, and the last lines of its output. */
    const runToEnd = (machine: MachineRef, id: string, argv: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.flatMap(execIn(machine, id, { argv }), (execution) =>
          Effect.all(
            {
              exitCode: execution.exitCode,
              output: Stream.mkString(Stream.decodeText(execution.output)),
            },
            { concurrency: "unbounded" },
          ),
        ),
      ).pipe(Effect.map(({ exitCode, output }) => ({ exitCode, output: lastLines(output) })));

    /**
     * Waits until SSH answers, which it may not for a moment after boat reads the sandbox ready.
     * Reading the host keys through boat's command API may fail that early too, so a failed
     * probe is tried again; the last one's output or error is the timeout's.
     */
    const reachable = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        const last = yield* Ref.make("");

        const answered = yield* runToEnd(machine, id, ["true"]).pipe(
          Effect.catch((error) => Effect.succeed({ exitCode: -1, output: error.message })),
          Effect.tap(({ output }) => Ref.set(last, output)),
          Effect.repeat({
            until: ({ exitCode }) => exitCode === 0,
            schedule: Schedule.spaced(sshPause),
          }),
          Effect.timeoutOption(sshWait),
        );

        if (Option.isNone(answered)) {
          return yield* new Internal({
            message: `${machine.id} didn't answer SSH within ${Duration.format(sshWait)}: ${yield* Ref.get(last)}`,
          });
        }
      });

    /**
     * Waits, in one SSH session, for boat's marker that `/var/lib` and `/var/opt` are restored,
     * where preparation keeps its state and enabled units start from. A fresh create has none.
     */
    const restored = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        const waited = yield* runToEnd(machine, id, [
          "/bin/sh",
          "-c",
          `until [ -e ${restoredMarker} ]; do sleep 0.25; done`,
        ]).pipe(Effect.timeoutOption(markerWait));

        if (Option.isNone(waited)) {
          return yield* new Internal({
            message: `${machine.id}'s /var/lib wasn't restored within ${Duration.format(markerWait)}: no ${restoredMarker}`,
          });
        }

        if (waited.value.exitCode !== 0) {
          return yield* new Internal({
            message: `waiting for ${machine.id}'s ${restoredMarker} exited ${waited.value.exitCode}: ${waited.value.output}`,
          });
        }
      });

    /**
     * After a create, fork or restore answers: records the sandbox on the row before anything
     * else, waits for it to run, and names it after the machine on boat's dashboard. The name
     * is only the operator's label, and delete goes by the recorded ID, so a rename boat refuses
     * is a warning.
     */
    const made = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        yield* settings.recordNative(machine.name, machine.instance, id);
        yield* running(machine, id, true);
        yield* api
          .rename(id, machine.id)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `couldn't name ${machine.id}'s boat sandbox ${id} on boat's dashboard: ${error.message}`,
              ),
            ),
          );
      });

    /** A fork's or restore's sandbox, once made: SSH answers and `/var/lib` is restored. */
    const restoredSandbox = (machine: MachineRef, id: string) =>
      Effect.andThen(
        made(machine, id),
        Effect.andThen(reachable(machine, id), restored(machine, id)),
      );

    /**
     * Writes the running guest's filesystems out with `sync`, before boat snapshots its disk for
     * a fork or a capture, so the snapshot holds everything written before the call.
     */
    const sync = (machine: MachineRef, id: string, before: "fork" | "capture") =>
      Effect.gen(function* () {
        const synced = yield* runToEnd(machine, id, ["sync"]).pipe(Effect.timeoutOption(syncWait));

        if (Option.isNone(synced) || synced.value.exitCode !== 0) {
          return yield* new Internal({
            message: `sync in ${machine.id} before its ${before} ${Option.isNone(synced) ? `ran past ${Duration.format(syncWait)}` : `exited ${synced.value.exitCode}: ${synced.value.output}`}`,
          });
        }
      });

    /**
     * Waits until a snapshot attempt that began after the source's sync has completed, so the
     * fork holds everything written before it. The times are boat's, and "after" is read
     * against the host's clock.
     */
    const freshSnapshot = (source: MachineRef, id: string) =>
      Effect.gen(function* () {
        yield* sync(source, id, "fork");

        const noted = yield* DateTime.now;

        const read = Effect.map(api.sandbox(id), (found) =>
          Option.filter(found, (sandbox) =>
            Option.match(
              Option.flatMap(Option.fromNullishOr(sandbox.lastSnapshotAttemptAt), DateTime.make),
              {
                onNone: () => false,
                onSome: (attempt) =>
                  DateTime.isGreaterThan(attempt, noted) &&
                  sandbox.lastSnapshotStatus === "completed",
              },
            ),
          ),
        );

        if (Option.isNone(yield* poll(read, snapshotPause, snapshotWait))) {
          return yield* new Internal({
            message: `boat completed no snapshot of ${source.id} within ${Duration.format(snapshotWait)} of its sync, so the fork wouldn't hold its latest writes`,
          });
        }
      });

    /** Waits until boat reads the stopped sandbox `archived`. */
    const archived = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        const last = yield* Ref.make<Option.Option<Sandbox>>(Option.none());

        const read = Effect.flatMap(api.sandbox(id), (found) =>
          Effect.as(
            Ref.set(last, found),
            Option.filter(found, (sandbox) => sandbox.state === "archived"),
          ),
        );

        if (Option.isSome(yield* poll(read, stopPause, stopWait))) {
          return;
        }

        const seen = yield* Ref.get(last);

        return yield* new Internal({
          message: `boat didn't archive ${machine.id}'s sandbox ${id} within ${Duration.format(stopWait)} of its stop: ${Option.match(seen, { onNone: () => "it is gone", onSome: (sandbox) => `it reads ${sandbox.state}${why(sandbox)}` })}`,
        });
      });

    return {
      name: "boat",
      version: apiVersion,
      publishAddress: undefined,
      pin: undefined,
      checkpointKind: "disk",
      startup: () => Effect.void,
      /**
       * A `GET` of each recorded sandbox, all at once, and none when no machine has one. A
       * machine whose sandbox boat answers 404 for, or has none recorded, is missing.
       */
      observe: (machines) =>
        Effect.gen(function* () {
          const recorded = machines.flatMap((machine) => machine.native ?? []);
          const found = recorded.length === 0 ? new Map() : yield* api.sandboxes(recorded);

          return machines.map((machine): Observed => {
            const sandbox = machine.native === undefined ? undefined : found.get(machine.native);

            if (sandbox === undefined) {
              return { state: "missing" };
            }

            const state = stateOf(sandbox.state);
            const ssh = upStates.has(sandbox.state) ? endpointOf(sandbox) : undefined;

            return ssh === undefined ? { state } : { state, ssh };
          });
        }),
      /**
       * One of boat's types must cover the machine; whether the account's plan includes it is
       * boat's to say. boat's own count of active sandboxes includes the operator's, so its 429
       * refusal, under the refusal rule, is the count.
       */
      admit: ({ machine }) => Effect.asVoid(machineType(machine)),
      /** boat has one image, so `image` names it only in the host's bases. */
      create: (machine) =>
        Effect.gen(function* () {
          const type = yield* typeOf(machine);

          const id = yield* refusing(api.create(keyOf(machine), type.name));

          yield* made(machine, id);
          yield* api.authorize(id, key.publicKey);
          yield* reachable(machine, id);
        }),
      start: (machine) =>
        Effect.gen(function* () {
          const id = yield* recordedSandbox(machine);

          yield* refusing(api.resume(id));
          yield* running(machine, id, false);
          yield* reachable(machine, id);
          yield* restored(machine, id);
        }),
      /** Never with `force`: a stop boat refuses, as when its final snapshot fails, is the error. */
      stop: (machine) =>
        Effect.gen(function* () {
          const id = yield* recordedSandbox(machine);

          yield* api.stop(id);
          yield* archived(machine, id);
        }),
      /**
       * Deletes the sandbox and waits until boat answers 404, never for its purge. A row without
       * a recorded sandbox has nothing on boat the host can find, so only the row goes.
       */
      delete: (machine) =>
        Effect.gen(function* () {
          const id = sandboxOf(machine);

          if (Option.isNone(id)) {
            return;
          }

          yield* api.delete(id.value);

          const gone = yield* poll(
            Effect.map(api.sandbox(id.value), (found) =>
              Option.isNone(found) ? Option.some(true) : Option.none(),
            ),
            deletePause,
            deleteWait,
          );

          if (Option.isNone(gone)) {
            return yield* new Internal({
              message: `boat still has ${machine.id}'s sandbox ${id.value} ${Duration.format(deleteWait)} after its delete`,
            });
          }
        }),
      /**
       * A named snapshot of a running or a stopped sandbox, always of its disk. A running one
       * syncs first, as a fork's source does.
       */
      capture: (machine, checkpoint) =>
        Effect.gen(function* () {
          const source = yield* sourceSandbox(machine);
          const name = snapshotOf(checkpoint.instance);

          if (upStates.has(source.state)) {
            yield* sync(machine, source.id, "capture");
          }

          yield* refusing(api.saveSnapshot(source.id, name));

          const settled = yield* poll(
            Effect.map(api.snapshot(name), (found) =>
              Option.filter(found, (snapshot) => snapshot.status !== "saving"),
            ),
            capturePause,
            captureWait,
          );

          if (Option.isNone(settled)) {
            return yield* new Internal({
              message: `boat didn't save snapshot ${name} of ${machine.id} within ${Duration.format(captureWait)}`,
            });
          }

          if (settled.value.status !== "ready") {
            return yield* new Internal({
              message: `boat's snapshot ${name} of ${machine.id} is ${settled.value.status}${settled.value.error === undefined ? "" : `: ${settled.value.error}`}`,
            });
          }
        }),
      restore: (checkpoint, machine) =>
        Effect.gen(function* () {
          const type = yield* typeOf(machine);

          const id = yield* refusing(
            api.create(keyOf(machine), type.name, snapshotOf(checkpoint.instance)),
          );

          yield* restoredSandbox(machine, id);
        }),
      /**
       * A stopped source forks at once, holding everything up to its stop. A running one keeps
       * running, and forks once a snapshot begun after its sync has completed. Forks carry the
       * disk only.
       */
      fork: (source, machine) =>
        Effect.gen(function* () {
          const from = yield* sourceSandbox(source);

          if (upStates.has(from.state)) {
            yield* freshSnapshot(source, from.id);
          }

          const type = yield* typeOf(machine);

          const id = yield* refusing(api.fork(keyOf(machine), from.id, type.name));

          yield* restoredSandbox(machine, id);
        }),
      deleteCheckpoint: (checkpoint) => api.deleteSnapshot(snapshotOf(checkpoint.instance)),
      exec,
    } satisfies Interface;
  });

export const layer = (
  config: Pick<BoatHost, "id" | "stateDir" | "boat">,
  recordNative: RecordNative,
): Layer.Layer<
  Runtime,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Layer.effect(
    Runtime,
    make({
      apiKey: config.boat.apiKey,
      url: baseUrl,
      hostId: config.id,
      stateDir: config.stateDir,
      recordNative,
    }),
  );
