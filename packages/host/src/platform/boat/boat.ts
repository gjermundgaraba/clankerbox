import { join } from "node:path";
import { Capacity, HostError, Internal, type SshEndpoint } from "@gjermundgaraba/clankerbox-sdk";
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
  typeFor,
} from "./api.ts";
import { sshKey } from "./key.ts";
import { lastLines } from "../../guest.ts";
import {
  type Command,
  type Execution,
  type Interface,
  type MachineRef,
  type MachineState,
  missing,
  observeEach,
  type Observed,
  type RoomError,
  Runtime,
  timeoutFail,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import { NativeIds } from "../../store.ts";
import { allotted, inUse } from "../../usage.ts";
import { cliIn, describe, files } from "../process.ts";

export const BoatSettings = Schema.Struct({
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isNonEmpty())),
});

export interface Settings {
  readonly apiKey: Redacted.Redacted<string>;
  readonly url: string;
  readonly hostId: string;
  readonly stateDir: string;
}

const apiVersion = "v1";

const upStates: ReadonlySet<string> = new Set(["ready", "idle", "running"]);

const activeStates: ReadonlySet<string> = new Set([...upStates, "provisioned", "cloning"]);

export const stateOf = (state: string): MachineState =>
  activeStates.has(state) ? "running" : state === "cancelled" ? "missing" : "stopped";

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

export const remoteCommand = (argv: ReadonlyArray<string>): string =>
  ["sudo", "-n", "--", ...argv].map(quote).join(" ");

const hostKeysCommand = "cat /etc/ssh/ssh_host_*_key.pub";

const hostKeyLine = /^((?:ssh|ecdsa|sk)-[a-z0-9@.-]+) (AAAA[A-Za-z0-9+/]+={0,3})(?:\s|$)/u;

export const knownHosts = (alias: string, printed: string): ReadonlyArray<string> =>
  printed.split("\n").flatMap((line) => {
    const match = hostKeyLine.exec(line.trim());

    return match === null ? [] : [`${alias} ${match[1]} ${match[2]}`];
  });

export const restoredMarker = "/var/lib/ascii-lazy/sys-done";

export const createdMark = "/run/clankerbox-created";

export const restoredWait = `[ -e ${createdMark} ] || until [ -e ${restoredMarker} ]; do sleep 0.25; done`;

const searchPath = "/usr/bin:/bin";

const upWait = Duration.minutes(10);

const upPause = Duration.seconds(1);

const sshWait = Duration.minutes(3);

const sshPause = Duration.seconds(2);

const markerWait = Duration.minutes(10);

const stopWait = Duration.minutes(5);

const stopPause = Duration.seconds(1);

const deleteWait = Duration.minutes(1);

const deletePause = Duration.millis(500);

const snapshotWait = Duration.minutes(10);

const snapshotPause = Duration.seconds(5);

const captureWait = Duration.minutes(15);

const capturePause = Duration.seconds(3);

const syncWait = Duration.minutes(5);

const hostKeysTimeoutSeconds = 30;

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
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | NativeIds
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const nativeIds = yield* NativeIds;
    const api = yield* makeApi({ apiKey: settings.apiKey, url: settings.url });
    const { exec: spawn } = yield* cliIn({ PATH: searchPath });

    const key = yield* sshKey(settings.stateDir);
    const keyDir = join(settings.stateDir, "boat-ssh");

    const keyOf = (machine: MachineRef) => idempotencyKey(settings.hostId, machine.instance);
    const snapshotOf = (instance: string) => snapshotName(settings.hostId, instance);

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

    const running = (machine: MachineRef, id: string, fresh: boolean) => {
      const read = Effect.flatMap(
        api.sandbox(id),
        (found): Effect.Effect<Option.Option<Sandbox>, RoomError> => {
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
                ? new Capacity({ message: `${said}; it found no machine` })
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

    const allocated = <E>(machine: MachineRef, allocate: Effect.Effect<string, E>) =>
      Effect.uninterruptible(
        Effect.tap(allocate, (id) => nativeIds.recordNative(machine.name, machine.instance, id)),
      );

    const made = (machine: MachineRef, id: string) =>
      Effect.gen(function* () {
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

    const restoredSandbox = (machine: MachineRef, id: string) =>
      Effect.andThen(
        made(machine, id),
        Effect.andThen(reachable(machine, id), restored(machine, id)),
      );

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

    const observe = Effect.fn("Boat.observe")((machines: ReadonlyArray<MachineRef>) =>
      observeEach(
        machines,
        (machine) =>
          Option.match(sandboxOf(machine), {
            onNone: () => Effect.succeed({ state: "missing" }),
            onSome: (id) =>
              Effect.map(api.sandbox(id), (found) =>
                Option.match(found, {
                  onNone: (): Observed => ({ state: "missing" }),
                  onSome: observed,
                }),
              ),
          }),
        { warn: Effect.logWarning },
      ),
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
      observe,
      admit: Effect.fn("Boat.admit")(() => Effect.void),
      capacity: Effect.fn("Boat.capacity")((machines) =>
        Effect.gen(function* () {
          const [{ activeSandboxes, maxActiveSandboxes, starts }, { running, unread }] =
            yield* Effect.all([api.limits, inUse(machines, observe)], {
              concurrency: "unbounded",
            });

          const sizes = running.map((machine) => Option.getOrElse(typeFor(machine), () => machine));

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
            ...allotted(sizes, unread),
          ];
        }),
      ),
      create: Effect.fn("Boat.create")((machine) =>
        Effect.gen(function* () {
          const type = yield* machineType(machine);

          const id = yield* allocated(machine, api.create(keyOf(machine), type.name));

          yield* made(machine, id);
          yield* api.authorize(id, key.publicKey);
          yield* reachable(machine, id, ["touch", createdMark]);
        }),
      ),
      start: Effect.fn("Boat.start")((machine) =>
        Effect.gen(function* () {
          const { id, state } = yield* presentSandbox(machine);

          if (!activeStates.has(state)) {
            yield* api.resume(id);
          }

          yield* running(machine, id, false);
          yield* reachable(machine, id);
          yield* restored(machine, id);
        }),
      ),
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
        }),
      ),
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
        }),
      ),
      capture: Effect.fn("Boat.capture")((machine, checkpoint) =>
        Effect.gen(function* () {
          const source = yield* presentSandbox(machine);
          const name = snapshotOf(checkpoint.instance);

          if (upStates.has(source.state)) {
            yield* sync(machine, source.id, "capture");
          }

          yield* api.saveSnapshot(source.id, name);

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
        }),
      ),
      restore: Effect.fn("Boat.restore")((checkpoint, machine) =>
        Effect.gen(function* () {
          const type = yield* machineType(machine);

          const id = yield* allocated(
            machine,
            api.create(keyOf(machine), type.name, snapshotOf(checkpoint.instance)),
          );

          yield* restoredSandbox(machine, id);
        }),
      ),
      fork: Effect.fn("Boat.fork")((source, machine) =>
        Effect.gen(function* () {
          const type = yield* machineType(machine);
          const from = yield* presentSandbox(source);

          if (upStates.has(from.state)) {
            yield* freshSnapshot(source, from.id);
          }

          const id = yield* allocated(machine, api.fork(keyOf(machine), from.id, type.name));

          yield* restoredSandbox(machine, id);
        }),
      ),
      deleteCheckpoint: Effect.fn("Boat.deleteCheckpoint")((checkpoint) =>
        api.deleteSnapshot(snapshotOf(checkpoint.instance)),
      ),
      exec: Effect.fn("Boat.exec")(exec),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id" | "stateDir"> & { readonly boat: typeof BoatSettings.Type },
): Layer.Layer<
  Runtime,
  HostError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | NativeIds
> =>
  Layer.effect(
    Runtime,
    make({
      apiKey: config.boat.apiKey,
      url: baseUrl,
      hostId: config.id,
      stateDir: config.stateDir,
    }),
  );
