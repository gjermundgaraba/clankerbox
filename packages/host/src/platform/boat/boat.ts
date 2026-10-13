/**
 * The refusal rule covers boat's answers that leave nothing on boat (the bump-boat-api skill):
 * its `Capacity` and `Precondition` refusals of a create, fork, resume, restore or capture, a
 * create, fork or restore that ends `cancelled` because boat found no machine, and a machine to
 * start, or a fork's or capture's source, that boat doesn't have.
 *
 * Errors and warnings are scrubbed of the API key where they leave the runtime, so nothing boat
 * or the guest echoes carries it out.
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
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
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
} from "./api.ts";
import { sshKey } from "./key.ts";
import { lastLines } from "../../guest.ts";
import {
  type Command,
  type Execution,
  type Interface,
  machineReadWait,
  type MachineRef,
  type MachineState,
  missing,
  type Observed,
  type RecordNative,
  Refusal,
  type RoomError,
  Runtime,
  type RuntimeError,
  timeoutFail,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import { cliIn, describe, files } from "../process.ts";

/**
 * The API key stays `Redacted` from the moment it is decoded, so nothing that prints the config
 * prints it.
 */
export const BoatSettings = Schema.Struct({
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isNonEmpty())),
});

export type Boat = typeof BoatSettings.Type;

export interface BoatHost extends HostSettings {
  readonly runtime: "boat";
  readonly boat: Boat;
}

export interface Settings {
  readonly apiKey: Redacted.Redacted<string>;
  readonly url: string;
  readonly hostId: string;
  readonly stateDir: string;
  readonly recordNative: RecordNative;
}

const apiVersion = "v1";

/** boat reports `ready` before its lazy restore is done. */
const upStates: ReadonlySet<string> = new Set(["ready", "idle", "running"]);

/**
 * boat counts these as active (`GET /limits`): a sandbox still being made or resumed, which
 * `stop` must not skip and `start` doesn't resume again.
 */
const activeStates: ReadonlySet<string> = new Set([...upStates, "provisioned", "cloning"]);

export const stateOf = (state: string): MachineState =>
  activeStates.has(state) ? "running" : state === "cancelled" ? "missing" : "stopped";

/** Both change on every start, so they are read with the state, never stored. */
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

const observed = (sandbox: Sandbox): Observed => {
  const state = stateOf(sandbox.state);
  const ssh = upStates.has(sandbox.state) ? endpointOf(sandbox) : undefined;

  return ssh === undefined ? { state } : { state, ssh };
};

const why = (sandbox: Pick<Sandbox, "error">): string =>
  sandbox.error === undefined || sandbox.error === null ? "" : `: ${sandbox.error}`;

export const quote = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`;

/**
 * ssh joins its arguments into one string that the guest's shell parses, so every argument is
 * quoted.
 */
export const remoteCommand = (argv: ReadonlyArray<string>): string =>
  ["sudo", "-n", "--", ...argv].map(quote).join(" ");

const hostKeysCommand = "cat /etc/ssh/ssh_host_*_key.pub";

const hostKeyLine = /^((?:ssh|ecdsa|sk)-[a-z0-9@.-]+) (AAAA[A-Za-z0-9+/]+={0,3})(?:\s|$)/u;

export const knownHosts = (alias: string, printed: string): ReadonlyArray<string> =>
  printed.split("\n").flatMap((line) => {
    const match = hostKeyLine.exec(line.trim());

    return match === null ? [] : [`${alias} ${match[1]} ${match[2]}`];
  });

/**
 * boat's marker that `/var/lib` and `/var/opt` are restored in full. Undocumented: re-check it at
 * every change of boat's API or image.
 */
export const restoredMarker = "/var/lib/ascii-lazy/sys-done";

/**
 * The create's machine has nothing restored into it, so no restore marker comes. `/run` is a
 * tmpfs that no snapshot carries, and boat runs every fork, resume and restore on a fresh
 * machine, so the mark never outlives the create's machine. Preparation's instance file can't
 * take its place: a resume restores this machine's own, while the rest of `/var/lib` may still
 * be on its way.
 */
export const createdMark = "/run/clankerbox-created";

export const restoredWait = `[ -e ${createdMark} ] || until [ -e ${restoredMarker} ]; do sleep 0.25; done`;

const searchPath = "/usr/bin:/bin";

/**
 * boat answered ready 0.1–4.4 s after a create, fork, resume or restore, and without `failFast` a
 * call waits for a machine.
 */
const upWait = Duration.minutes(10);

const upPause = Duration.seconds(1);

const sshWait = Duration.minutes(3);

const sshPause = Duration.seconds(2);

/** 10–14 s with 1 GiB in `/var/lib`, and Docker keeps its images and volumes there too. */
const markerWait = Duration.minutes(10);

/** It took 2.3–18.9 s. */
const stopWait = Duration.minutes(5);

const stopPause = Duration.seconds(1);

/** It took under a second. */
const deleteWait = Duration.minutes(1);

const deletePause = Duration.millis(500);

/**
 * For a running fork source's snapshot attempt begun after its sync: 41 s with little new data,
 * 102 s after writing 3 GiB. boat starts one every 60 s, and one attempt took 3.8–24.4 s in the
 * timing spike (the bump-boat-api skill).
 */
const snapshotWait = Duration.minutes(10);

const snapshotPause = Duration.seconds(5);

/** About two minutes from a running sandbox. */
const captureWait = Duration.minutes(15);

const capturePause = Duration.seconds(3);

const syncWait = Duration.minutes(5);

const hostKeysTimeoutSeconds = 30;

/** A fresh activation may answer with this for a moment, so the SSH wait tries again. */
class HostKeysUnread extends Data.TaggedError("HostKeysUnread")<{ readonly message: string }> {}

const poll = <A, B, E, R, L>(
  read: Effect.Effect<A, E, R>,
  settled: (answer: A) => Option.Option<B>,
  timing: { readonly pause: Duration.Duration; readonly wait: Duration.Duration },
  late: (last: Option.Option<A>) => L,
): Effect.Effect<B, E | L, R> =>
  Effect.gen(function* () {
    const last = yield* Ref.make(Option.none<A>());

    return yield* read.pipe(
      Effect.tap((answer) => Ref.set(last, Option.some(answer))),
      Effect.map(settled),
      Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(timing.pause) }),
      // The repeat ends only on `Some`.
      Effect.map(Option.getOrThrow),
      Effect.timeoutOrElse({
        duration: timing.wait,
        orElse: () => Effect.flatMap(Ref.get(last), (seen) => Effect.fail(late(seen))),
      }),
    );
  });

export const make = (
  settings: Settings,
): Effect.Effect<
  Interface,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const secret = Redacted.value(settings.apiKey);

    const scrub = (text: string) => (secret === "" ? text : text.replaceAll(secret, "<redacted>"));

    const scrubber = <E extends RoomError, I extends { readonly message: string }>(
      errors: Schema.Codec<E, I>,
    ) => {
      const encode = Schema.encodeSync(errors);
      const decode = Schema.decodeSync(errors);

      return (error: E): E => {
        const encoded = encode(error);

        return decode({ ...encoded, message: scrub(encoded.message) });
      };
    };

    const scrubbed = scrubber(Schema.Union([Precondition, Internal]));

    const scrubbedRoom = scrubber(Schema.Union([Precondition, Internal, Capacity]));

    const scrubbing = <A, R>(action: Effect.Effect<A, RuntimeError, R>) =>
      Effect.mapError(action, scrubbed);

    const scrubbingRefusal = <A, R>(action: Effect.Effect<A, RoomError | Refusal, R>) =>
      Effect.mapError(action, (error) =>
        error instanceof Refusal
          ? new Refusal({ error: scrubbedRoom(error.error) })
          : scrubbedRoom(error),
      );

    const warn = (message: string) => Effect.logWarning(scrub(message));

    const api = yield* makeApi({ apiKey: settings.apiKey, url: settings.url });
    const { exec: spawn } = yield* cliIn({ PATH: searchPath });

    // The store holds the state dir's lock before the runtime is built.
    const key = yield* sshKey(settings.stateDir);
    const keyDir = join(settings.stateDir, "boat-ssh");

    const keyOf = (machine: MachineRef) => idempotencyKey(settings.hostId, machine.instance);
    const snapshotOf = (instance: string) => snapshotName(settings.hostId, instance);

    /**
     * The core reads the row again after a create, fork or restore, and the runtime's own steps
     * pass on the ID they made.
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
     * One without a recorded sandbox, or one boat reports cancelled or gone, is refused before
     * anything native.
     */
    const presentSandbox = (machine: MachineRef) =>
      Effect.gen(function* () {
        const id = sandboxOf(machine);

        if (Option.isNone(id)) {
          return yield* missing("boat", machine);
        }

        const found = yield* api.sandbox(id.value);

        if (Option.isNone(found) || stateOf(found.value.state) === "missing") {
          return yield* missing("boat", machine);
        }

        return found.value;
      });

    const typeOf = (machine: MachineRef) =>
      Effect.mapError(machineType(machine), (error) => new Refusal({ error }));

    const refusing = <A>(call: Effect.Effect<A, RoomError>): Effect.Effect<A, Internal | Refusal> =>
      call.pipe(
        Effect.catchTags({
          Capacity: (error) => Effect.fail(new Refusal({ error })),
          Precondition: (error) => Effect.fail(new Refusal({ error })),
        }),
      );

    /**
     * A create, fork or restore that ends cancelled found no machine and left nothing: a refusal.
     * One boat answers 404 for after accepting it is unclear, as boat reports a cancelled sandbox
     * once before its 404: a failure, so its row and sandbox ID stay. At a start, either is a
     * failure.
     */
    const running = (machine: MachineRef, id: string, fresh: boolean) => {
      const read = Effect.flatMap(
        api.sandbox(id),
        (found): Effect.Effect<Option.Option<Sandbox>, RuntimeError | Refusal> => {
          if (Option.isSome(found) && upStates.has(found.value.state)) {
            return Effect.succeed(found);
          }

          if (Option.isNone(found)) {
            return Effect.fail(
              new Internal({ message: `boat no longer has sandbox ${id} of ${machine.id}` }),
            );
          }

          if (found.value.state === "cancelled") {
            const said = `boat cancelled sandbox ${id} of ${machine.id}${why(found.value)}`;

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

      return Effect.asVoid(
        poll(
          read,
          (found) => found,
          { pause: upPause, wait: upWait },
          () =>
            new Internal({
              message: `boat's sandbox ${id} of ${machine.id} didn't run within ${Duration.format(upWait)}`,
            }),
        ),
      );
    };

    /**
     * Read over boat's command API, over HTTPS. Every activation has new keys, and preparation
     * re-mints them, so a pin is never reused.
     */
    const pin = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        const ran = yield* Effect.mapError(
          api.command(id, hostKeysCommand, hostKeysTimeoutSeconds),
          (error) => new HostKeysUnread({ message: error.message }),
        );

        const lines = knownHosts(id, ran.stdout);

        if (ran.exitCode !== 0 || lines.length === 0) {
          return yield* new HostKeysUnread({
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
     * Each exec opens its own connection. Errors name the machine, never the command. A sandbox
     * that doesn't run, or has no address, fails before the host keys are read.
     */
    const session = (machine: MachineRef, id: string, { argv, stdin }: Command) =>
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

    const execIn = (machine: MachineRef, id: string, command: Command) =>
      Effect.catchTag(session(machine, id, command), "HostKeysUnread", (error) =>
        Effect.fail(new Internal({ message: error.message })),
      );

    const exec: Interface["exec"] = (machine, command) =>
      Effect.flatMap(recordedSandbox(machine), (id) => execIn(machine, id, command));

    const finished = (execution: Execution) =>
      Effect.all(
        {
          exitCode: execution.exitCode,
          output: Stream.mkString(Stream.decodeText(execution.output)),
        },
        { concurrency: "unbounded" },
      ).pipe(Effect.map(({ exitCode, output }) => ({ exitCode, output: lastLines(output) })));

    const runToEnd = (machine: MachineRef, id: string, argv: ReadonlyArray<string>) =>
      Effect.scoped(Effect.flatMap(execIn(machine, id, { argv }), finished));

    /**
     * SSH may not answer for a moment after boat reads the sandbox ready. Only a failed SSH and a
     * failed read of the host keys, which may fail that early too, are tried again.
     */
    const reachable = (machine: MachineRef, id: string, argv: ReadonlyArray<string> = ["true"]) =>
      poll(
        Effect.scoped(Effect.flatMap(session(machine, id, { argv }), finished)).pipe(
          Effect.catchTag("HostKeysUnread", (error) =>
            Effect.succeed({ exitCode: -1, output: error.message }),
          ),
        ),
        Option.liftPredicate(({ exitCode }) => exitCode === 0),
        { pause: sshPause, wait: sshWait },
        (last) =>
          new Internal({
            message: `${machine.id} didn't answer SSH within ${Duration.format(sshWait)}: ${Option.match(last, { onNone: () => "", onSome: ({ output }) => output })}`,
          }),
      );

    /**
     * `/var/lib` and `/var/opt` hold preparation's state and what enabled units start from;
     * a create restores nothing, so no marker comes on its own machine (`createdMark`).
     */
    const restored = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        const waited = yield* runToEnd(machine, id, ["/bin/sh", "-c", restoredWait]).pipe(
          timeoutFail(
            markerWait,
            () =>
              new Internal({
                message: `${machine.id}'s /var/lib wasn't restored within ${Duration.format(markerWait)}: no ${restoredMarker}`,
              }),
          ),
        );

        if (waited.exitCode !== 0) {
          return yield* new Internal({
            message: `waiting for ${machine.id}'s ${restoredMarker} exited ${waited.exitCode}: ${waited.output}`,
          });
        }
      });

    /**
     * The sandbox is recorded on the row before anything else. The name is only the operator's
     * label, and delete goes by the recorded ID, so a rename boat refuses is a warning.
     */
    const made = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
        yield* settings.recordNative(machine.name, machine.instance, id);
        yield* running(machine, id, true);
        yield* api
          .rename(id, machine.id)
          .pipe(
            Effect.catch((error) =>
              warn(
                `couldn't name ${machine.id}'s boat sandbox ${id} on boat's dashboard: ${error.message}`,
              ),
            ),
          );
      });

    const restoredSandbox = (machine: MachineRef, id: string) =>
      Effect.andThen(
        made(machine, id),
        Effect.andThen(reachable(machine, id), restored(machine, id)),
      );

    /**
     * So the snapshot boat takes for a fork or a capture holds everything written before the
     * call.
     */
    const sync = (machine: MachineRef, id: string, before: "fork" | "capture") =>
      Effect.gen(function* () {
        const synced = yield* runToEnd(machine, id, ["sync"]).pipe(
          timeoutFail(
            syncWait,
            () =>
              new Internal({
                message: `sync in ${machine.id} before its ${before} ran past ${Duration.format(syncWait)}`,
              }),
          ),
        );

        if (synced.exitCode !== 0) {
          return yield* new Internal({
            message: `sync in ${machine.id} before its ${before} exited ${synced.exitCode}: ${synced.output}`,
          });
        }
      });

    /**
     * boat stamps `lastSnapshotAttemptAt` when an attempt starts (the bump-boat-api skill), so the
     * value read after the sync names the last attempt begun before it; once it changes, a later
     * attempt has begun. Only boat's own values are compared, never against the host's clock.
     */
    const freshSnapshot = (source: MachineRef, id: string) =>
      Effect.gen(function* () {
        yield* sync(source, id, "fork");

        const synced = yield* api.sandbox(id);

        if (Option.isNone(synced)) {
          return yield* new Internal({
            message: `boat no longer has ${source.id}'s sandbox ${id} after its sync`,
          });
        }

        const noted = synced.value.lastSnapshotAttemptAt;

        yield* poll(
          api.sandbox(id),
          (found) =>
            Option.filter(
              found,
              ({ lastSnapshotAttemptAt: attempt, lastSnapshotStatus: status }) =>
                attempt !== undefined &&
                attempt !== null &&
                attempt !== noted &&
                status === "completed",
            ),
          { pause: snapshotPause, wait: snapshotWait },
          () =>
            new Internal({
              message: `boat completed no snapshot of ${source.id} within ${Duration.format(snapshotWait)} of its sync, so the fork wouldn't hold its latest writes`,
            }),
        );
      });

    const archived = (machine: MachineRef, id: string) =>
      poll(
        api.sandbox(id),
        (found) => Option.filter(found, (sandbox) => sandbox.state === "archived"),
        { pause: stopPause, wait: stopWait },
        (last) =>
          new Internal({
            message: `boat didn't archive ${machine.id}'s sandbox ${id} within ${Duration.format(stopWait)} of its stop: ${Option.match(Option.flatten(last), { onNone: () => "it is gone", onSome: (sandbox) => `it reads ${sandbox.state}${why(sandbox)}` })}`,
          }),
      );

    return {
      name: "boat",
      version: apiVersion,
      publishAddress: undefined,
      pin: undefined,
      checkpointKind: "disk",
      captureFrom: "running",
      loginUser: "root",
      startup: Effect.fn("Boat.startup")(() => Effect.void),
      /**
       * A `GET` of each recorded sandbox, all at once: a host holds few machines, and boat limits
       * starts, not reads; a list would also hold the operator's own sandboxes, a page at a time.
       * A few quick repeats ride out a blip, and one hung read makes only its own machine unknown.
       */
      observe: Effect.fn("Boat.observe")((machines) =>
        Effect.forEach(
          machines,
          (machine): Effect.Effect<Observed> =>
            Option.match(sandboxOf(machine), {
              onNone: () => Effect.succeed({ state: "missing" }),
              onSome: (id) =>
                api.sandbox(id).pipe(
                  timeoutFail(
                    machineReadWait,
                    () =>
                      new Internal({
                        message: `boat answered no read of sandbox ${id} within ${Duration.format(machineReadWait)}`,
                      }),
                  ),
                  Effect.map((found) =>
                    Option.match(found, {
                      onNone: (): Observed => ({ state: "missing" }),
                      onSome: observed,
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.as(warn(`couldn't read ${machine.id}'s state: ${error.message}`), {
                      state: "unknown",
                    } satisfies Observed),
                  ),
                ),
            }),
          { concurrency: "unbounded" },
        ),
      ),
      /**
       * Whether the account's plan includes the type is boat's to say. boat's own count of active
       * sandboxes includes the operator's, so its 429 refusal is the count.
       */
      admit: Effect.fn("Boat.admit")(({ machine }) => Effect.asVoid(machineType(machine))),
      /** One request, so a refusal is boat's own answer. */
      capacity: Effect.fn("Boat.capacity")(() =>
        Effect.map(scrubbing(api.limits), ({ activeSandboxes, maxActiveSandboxes, starts }) => {
          const windows = [
            ["startsPerMinute", starts?.minute],
            ["startsPerHour", starts?.hour],
            ["startsPerDay", starts?.day],
          ] as const;

          return [
            {
              resource: "activeSandboxes" as const,
              limit: maxActiveSandboxes,
              used: activeSandboxes,
            },
            ...windows.flatMap(([resource, window]) =>
              window == null ? [] : [{ resource, limit: window.limit, used: window.used }],
            ),
          ];
        }),
      ),
      /** boat has one image, so `image` names it only in the host's bases. */
      create: Effect.fn("Boat.create")((machine) =>
        Effect.gen(function* () {
          const type = yield* typeOf(machine);

          const id = yield* refusing(api.create(keyOf(machine), type.name));

          yield* made(machine, id);
          yield* api.authorize(id, key.publicKey);
          yield* reachable(machine, id, ["touch", createdMark]);
        }).pipe(scrubbingRefusal),
      ),
      /**
       * A sandbox boat still makes or resumes, or that runs, isn't resumed again. The start waits
       * for the marker too, as boat reads a sandbox ready before it exists, so preparation never
       * meets a half-restored `/var/lib`.
       */
      start: Effect.fn("Boat.start")((machine) =>
        Effect.gen(function* () {
          const { id, state } = yield* presentSandbox(machine);

          if (!activeStates.has(state)) {
            yield* refusing(api.resume(id));
          }

          yield* running(machine, id, false);
          yield* reachable(machine, id);
          yield* restored(machine, id);
        }).pipe(scrubbingRefusal),
      ),
      /**
       * Never with `force`: a stop boat refuses, as when its final snapshot fails, is the error.
       */
      stop: Effect.fn("Boat.stop")((machine) =>
        Effect.gen(function* () {
          const id = sandboxOf(machine);

          if (Option.isNone(id)) {
            return;
          }

          const found = yield* api.sandbox(id.value);

          if (Option.isNone(found) || !activeStates.has(found.value.state)) {
            return;
          }

          yield* api.stop(id.value);
          yield* archived(machine, id.value);
        }).pipe(scrubbing),
      ),
      /**
       * Never waits for the purge. A sandbox boat reports cancelled or gone gets no `DELETE`: boat
       * answers that with a 403, not a 404, for a sandbox another API key made, even once gone.
       */
      delete: Effect.fn("Boat.delete")((machine) =>
        Effect.gen(function* () {
          const id = sandboxOf(machine);

          if (Option.isNone(id)) {
            return;
          }

          const found = yield* api.sandbox(id.value);

          if (Option.isNone(found) || stateOf(found.value.state) === "missing") {
            return;
          }

          yield* api.delete(id.value);

          yield* poll(
            api.sandbox(id.value),
            Option.liftPredicate(Option.isNone),
            { pause: deletePause, wait: deleteWait },
            () =>
              new Internal({
                message: `boat still has ${machine.id}'s sandbox ${id.value} ${Duration.format(deleteWait)} after its delete`,
              }),
          );
        }).pipe(scrubbing),
      ),
      /** Always of the disk. A running sandbox syncs first, as a fork's source does. */
      capture: Effect.fn("Boat.capture")((machine, checkpoint) =>
        Effect.gen(function* () {
          const source = yield* presentSandbox(machine);
          const name = snapshotOf(checkpoint.instance);

          if (upStates.has(source.state)) {
            yield* sync(machine, source.id, "capture");
          }

          yield* refusing(api.saveSnapshot(source.id, name));

          const settled = yield* poll(
            api.snapshot(name),
            (found) => Option.filter(found, (snapshot) => snapshot.status !== "saving"),
            { pause: capturePause, wait: captureWait },
            () =>
              new Internal({
                message: `boat didn't save snapshot ${name} of ${machine.id} within ${Duration.format(captureWait)}`,
              }),
          );

          if (settled.status !== "ready") {
            return yield* new Internal({
              message: `boat's snapshot ${name} of ${machine.id} is ${settled.status}${settled.error === undefined ? "" : `: ${settled.error}`}`,
            });
          }
        }).pipe(scrubbingRefusal),
      ),
      restore: Effect.fn("Boat.restore")((checkpoint, machine) =>
        Effect.gen(function* () {
          const type = yield* typeOf(machine);

          const id = yield* refusing(
            api.create(keyOf(machine), type.name, snapshotOf(checkpoint.instance)),
          );

          yield* restoredSandbox(machine, id);
        }).pipe(scrubbingRefusal),
      ),
      /**
       * A stopped source forks at once. A running one keeps running, and forks once a snapshot
       * begun after its sync has completed. Forks carry the disk only.
       */
      fork: Effect.fn("Boat.fork")((source, machine) =>
        Effect.gen(function* () {
          const type = yield* typeOf(machine);
          const from = yield* presentSandbox(source);

          if (upStates.has(from.state)) {
            yield* freshSnapshot(source, from.id);
          }

          const id = yield* refusing(api.fork(keyOf(machine), from.id, type.name));

          yield* restoredSandbox(machine, id);
        }).pipe(scrubbingRefusal),
      ),
      deleteCheckpoint: Effect.fn("Boat.deleteCheckpoint")((checkpoint) =>
        scrubbing(api.deleteSnapshot(snapshotOf(checkpoint.instance))),
      ),
      exec: Effect.fn("Boat.exec")((machine, command) => scrubbing(exec(machine, command))),
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
