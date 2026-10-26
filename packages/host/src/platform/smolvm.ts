import { totalmem } from "node:os";
import { join } from "node:path";
import {
  formatMib,
  type HostError,
  Internal,
  Invalid,
  requirements,
  type Sizing,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import {
  changes,
  type CheckpointRef,
  type Interface,
  type MachineRef,
  type MachineState,
  missing,
  Runtime,
  type Sizes,
  type StateError,
  stateReadWait,
  timeoutFail,
} from "../runtime.ts";
import type { HostSettings } from "../settings.ts";
import { CannotStart } from "../startup.ts";
import { allotted, checkRamBudget, inUse } from "../usage.ts";
import { cliIn, expect, failure, files } from "./process.ts";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

export const SmolvmSettings = Schema.Struct({
  prefix: Schema.String,
  ramBudgetMib: Schema.optionalKey(Size),
});

const mib = 1024 * 1024;

const reservedMib = 2048;

export const ramBudget = (set: number | undefined): Effect.Effect<number, Invalid> => {
  const ramBudgetMib = set ?? Math.floor(totalmem() / mib) - reservedMib;

  return ramBudgetMib <= 0
    ? Effect.fail(
        new Invalid({
          message: "linux.ramBudgetMib: physical RAM leaves no default budget; set one",
        }),
      )
    : Effect.succeed(ramBudgetMib);
};

export interface Settings {
  readonly prefix: string;
  readonly publishAddress: string;
  readonly ramBudgetMib: number;
  readonly stateDir: string;
  /** As Node names it: smolvm grows a running machine's vCPUs only on `x64`. */
  readonly arch: string;
}

// Source: smolvm src/agent/live_resize.rs target_added_mib
const ramStepMib = 128;

// Source: smolvm src/data/resources.rs MIN_MEMORY_MIB
const minimumRamMib = 64;

// Source: smolvm src/data/storage.rs DEFAULT_STORAGE_SIZE_GIB
const defaultStorageGib = 20;

// Source: smolvm src/cli/machine.rs CreateCmd, ResizeCmd, UpdateCmd
const maximumCpu = 255;

// Source: smolvm src/cli/machine.rs CreateCmd, ResizeCmd, UpdateCmd
const maximumRamMib = 2 ** 32 - 1;

// Source: smolvm src/db/resize.rs begin_resize
const unfinishedRefusal = "an unfinished resize belongs to a different target";

export const pathsIn = (stateDir: string) => ({
  dataDir: join(stateDir, "smolvm"),
  store: join(stateDir, "checkpoints"),
  forks: join(stateDir, "forks"),
});

export const pin = `smolvm ${requirements.smolvm.testedVersion} ${process.platform}-${process.arch}`;

export const nativeName = (resource: Pick<MachineRef, "name" | "instance">): string =>
  `${resource.name}-${resource.instance.slice(0, 8)}`;

const observeConcurrency = 8;

export const machineReadWait = Duration.subtract(stateReadWait, Duration.seconds(1));

export const observeEach = (
  machines: ReadonlyArray<MachineRef>,
  read: (machine: MachineRef) => Effect.Effect<MachineState, Internal>,
): Effect.Effect<ReadonlyArray<MachineState>> =>
  Effect.flatMap(Semaphore.make(observeConcurrency), (turns) =>
    Effect.forEach(
      machines,
      (machine) =>
        turns
          .withPermits(1)(read(machine))
          .pipe(
            timeoutFail(
              machineReadWait,
              () =>
                new Internal({ message: `no answer within ${Duration.format(machineReadWait)}` }),
            ),
            Effect.catch((error): Effect.Effect<MachineState> =>
              Effect.as(
                Effect.logWarning(`couldn't read ${machine.id}'s state: ${error.message}`),
                "unknown",
              ),
            ),
          ),
      { concurrency: "unbounded" },
    ),
  );

// Source: smolvm src/systemd_scope.rs scope_name
const scopeName = (native: string): string => `smolvm-vm-${native}.scope`;

export const templates = ["storage-template.ext4", "overlay-template.ext4"] as const;

// Source: smolvm src/agent/manager.rs vm_data_dir, src/agent/fork.rs control_socket_path, src/agent/launcher_dynamic.rs MAX_UNIX_SOCKET_PATH
const socketPathMax = 107;

export const controlSocket = (dataDir: string): string =>
  join(dataDir, ".cache", "smolvm", "vms", "0".repeat(16), "control.sock");

const searchPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// Source: smolvm src/main.rs apply_system_data_root, src/process.rs oom_score_adj_for, src/usage.rs recording_enabled; tracing-subscriber NO_COLOR
export const environment = (settings: Settings) => ({
  PATH: searchPath,
  HOME: pathsIn(settings.stateDir).dataDir,
  SMOLVM_DATA_DIR: pathsIn(settings.stateDir).dataDir,
  SMOLVM_AGENT_ROOTFS: join(settings.prefix, ".local", "share", "smolvm", "agent-rootfs"),
  SMOLVM_RESTORE_TMPFS: "0",
  SMOLVM_VM_USE_SCOPE: "1",
  SMOLVM_OOM_VICTIM_ORDER: "0",
  SMOLVM_USAGE: "0",
  SMOLVM_PUBLISH_ADDR: settings.publishAddress,
  SMOLVM_EGRESS_FLOOR: "strict",
  NO_COLOR: "1",
});

// Source: smolvm src/config.rs RecordState
const RecordState = Schema.Literals([
  "created",
  "running",
  "stopped",
  "paused",
  "pausing",
  "failed",
  "unreachable",
  "frozen",
]);

type RecordState = typeof RecordState.Type;

const decodeStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ state: RecordState })),
);

// Source: smolvm src/cli/vm_common.rs machine_status_json
const decodeSizes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ cpus: Size, memory_mib: Size, storage_gb: Schema.NullOr(Size) }),
  ),
);

const alive: ReadonlySet<RecordState> = new Set(["running", "pausing", "unreachable", "frozen"]);

// Source: smolvm src/embedded/runtime.rs resume_machine_inner
const resumable: ReadonlySet<RecordState> = new Set(["pausing", "paused"]);

export const stateOf = (state: RecordState): MachineState => {
  if (state === "paused") {
    return "paused";
  }

  return alive.has(state) ? "running" : "stopped";
};

export const make = (
  settings: Settings,
  uid: number | undefined,
): Effect.Effect<
  Interface,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const binary = join(settings.prefix, "smolvm");
    const paths = pathsIn(settings.stateDir);
    const { run, exec } = yield* cliIn(environment(settings));

    const smolvm = (args: ReadonlyArray<string>, what: string) =>
      run(binary, args, `smolvm ${what}`);

    const call = (args: ReadonlyArray<string>, what: string) =>
      Effect.flatMap(smolvm(args, what), (ran) => expect(ran, `smolvm ${what}`));

    const systemctl = (args: ReadonlyArray<string>, what: string) =>
      Effect.flatMap(run("systemctl", args, `systemctl ${what}`), (ran) =>
        expect(ran, `systemctl ${what}`),
      );

    const removeAll = (path: string) =>
      files(`couldn't remove ${path}`, fs.remove(path, { recursive: true, force: true }));

    if (uid !== 0) {
      return yield* new CannotStart({
        message: `a smolvm host runs as root, and this one runs as uid ${uid ?? "unknown"}`,
      });
    }

    const socket = controlSocket(paths.dataDir);

    if (Buffer.byteLength(socket) > socketPathMax) {
      return yield* new CannotStart({
        message: `smolvm's sockets under ${paths.dataDir} would need ${Buffer.byteLength(socket)} bytes, past Linux's ${socketPathMax}: use a shorter state dir`,
      });
    }

    for (const template of templates) {
      const file = join(settings.prefix, template);

      const present = yield* files(`couldn't check ${file}`, fs.exists(file));

      if (!present) {
        return yield* new CannotStart({
          message: `smolvm prefix ${settings.prefix} has no ${template}: expand it at install with zstd -d --sparse ${file}.zst -o ${file}`,
        });
      }
    }

    const reported = (yield* call(["--version"], "--version")).stdout.trim();

    if (reported !== `smolvm ${requirements.smolvm.testedVersion}`) {
      return yield* new CannotStart({
        message: `${binary} reports "${reported}", and this host was tested on smolvm ${requirements.smolvm.testedVersion}`,
      });
    }

    const status = (native: string): Effect.Effect<RecordState | "missing", Internal> =>
      Effect.flatMap(
        smolvm(["machine", "status", "--name", native, "--json"], `machine status ${native}`),
        (ran) => {
          if (ran.exitCode === 0) {
            return decodeStatus(ran.stdout).pipe(
              Effect.map(({ state }) => state),
              Effect.mapError(
                (error) =>
                  new Internal({
                    message: `smolvm machine status ${native} answered something unexpected: ${error.message}`,
                  }),
              ),
            );
          }

          return ran.stderr.includes(`machine '${native}' not found`)
            ? Effect.succeed("missing" as const)
            : Effect.fail(failure(`smolvm machine status ${native}`, ran));
        },
      );

    const state = (native: string): Effect.Effect<MachineState, Internal> =>
      Effect.map(status(native), (recorded) =>
        recorded === "missing" ? recorded : stateOf(recorded),
      );

    const observe = (machines: ReadonlyArray<MachineRef>) =>
      observeEach(machines, (machine) => state(nativeName(machine)));

    const boot = (native: string) =>
      call(["machine", "start", "--name", native, "--branchable"], `machine start ${native}`);

    const resume = (native: string) =>
      call(["machine", "resume", "--name", native], `machine resume ${native}`);

    const copyable = (machine: MachineRef, stopped: string) =>
      Effect.flatMap(status(nativeName(machine)), (recorded): Effect.Effect<void, StateError> => {
        if (recorded === "running") {
          return Effect.void;
        }

        if (recorded === "missing") {
          return Effect.fail(missing("linux", machine));
        }

        const message =
          recorded === "unreachable"
            ? `smolvm reads machine ${machine.id} unreachable: its VM runs, but its agent doesn't answer; start it to boot it again`
            : alive.has(recorded) || resumable.has(recorded)
              ? `smolvm reads machine ${machine.id} ${recorded}, and copies only a running machine`
              : stopped;

        return Effect.fail(new WrongState({ message, machine: machine.id, state: recorded }));
      });

    const checkpointDir = (checkpoint: CheckpointRef) =>
      join(paths.store, `${nativeName(checkpoint)}.checkpoint`);

    const captureRam = (machine: MachineRef, store: string, output: string) => {
      const native = nativeName(machine);

      return call(
        [
          "machine",
          "checkpoint",
          "--name",
          native,
          "--store",
          store,
          "--output",
          output,
          "--history",
          "0",
        ],
        `machine checkpoint ${native}`,
      );
    };

    const removeVm = (machine: MachineRef) =>
      Effect.gen(function* () {
        const native = nativeName(machine);
        const scope = scopeName(native);
        const observed = yield* state(native);

        if (observed === "missing") {
          return;
        }

        if (observed === "running") {
          const stopped = yield* smolvm(
            ["machine", "stop", "--name", native, "--timeout", "0"],
            `machine stop ${native}`,
          );

          if (stopped.exitCode !== 0) {
            yield* Effect.logWarning(
              `delete ${machine.id}: ${failure(`smolvm machine stop ${native}`, stopped).message}`,
            );
          }
        }

        const loaded = yield* systemctl(
          ["show", "--property=LoadState", "--value", scope],
          `show ${scope}`,
        );

        const killed = loaded.stdout.trim() === "loaded";

        if (killed) {
          yield* systemctl(["kill", "--signal=SIGKILL", scope], `kill ${scope}`);
        }

        yield* call(["machine", "delete", "--name", native, "--force"], `machine delete ${native}`);

        if (killed) {
          yield* Effect.ignore(systemctl(["reset-failed", scope], `reset-failed ${scope}`));
        }
      });

    const updated = (native: string, to: Sizing) => {
      const given = (flag: string, size: number | undefined) =>
        size === undefined ? [] : [flag, String(size)];

      const flags = [
        ...given("--cpus", to.cpu),
        ...given("--mem", to.ramMib),
        ...given("--storage", to.diskGib),
      ];

      return flags.length === 0
        ? Effect.void
        : Effect.asVoid(
            call(["machine", "update", "--name", native, ...flags], `machine update ${native}`),
          );
    };

    const grown = (native: string, machine: Sizes, to: Sizing) => {
      const each: ReadonlyArray<readonly [string, number, number | undefined]> = [
        ["--mem", machine.ramMib, to.ramMib],
        [
          "--cpus",
          machine.cpu,
          to.cpu === machine.cpu && settings.arch !== "x64" ? undefined : to.cpu,
        ],
        ["--storage", machine.diskGib, to.diskGib],
      ];

      return Effect.forEach(
        each,
        ([flag, had, size]) =>
          size === undefined
            ? Effect.void
            : Effect.flatMap(
                smolvm(
                  ["machine", "resize", "--name", native, flag, String(size)],
                  `machine resize ${native}`,
                ),
                (ran) =>
                  size === had && ran.exitCode !== 0 && ran.stderr.includes(unfinishedRefusal)
                    ? Effect.void
                    : Effect.asVoid(expect(ran, `smolvm machine resize ${native}`)),
              ),
        { discard: true },
      );
    };

    // Source: smolvm src/agent/live_resize.rs ensure_live_compute_platform
    const sizable = (machine: Pick<MachineRef, "id">, from: Sizes, to: Sizes, live: boolean) => {
      if (to.ramMib < minimumRamMib) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm gives a machine at least ${formatMib(minimumRamMib)} of RAM, and ${machine.id} would have ${formatMib(to.ramMib)}`,
          }),
        );
      }

      if (to.cpu > maximumCpu) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm's CLI takes at most ${maximumCpu} vCPUs, and ${machine.id} would have ${to.cpu}`,
          }),
        );
      }

      if (to.ramMib > maximumRamMib) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm's CLI takes at most ${formatMib(maximumRamMib)} of RAM, and ${machine.id} would have ${formatMib(to.ramMib)}`,
          }),
        );
      }

      if (!live) {
        return Effect.void;
      }

      if ((to.ramMib - from.ramMib) % ramStepMib !== 0) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm grows a running machine's RAM in ${ramStepMib}M steps, and ${machine.id}'s would grow from ${formatMib(from.ramMib)} to ${formatMib(to.ramMib)}`,
          }),
        );
      }

      return to.cpu > from.cpu && settings.arch !== "x64"
        ? Effect.fail(
            new Unsizable({
              message: `smolvm grows a running machine's vCPUs only on x86_64, and this host is ${settings.arch}: give ${machine.id} more vCPUs once it is stopped`,
            }),
          )
        : Effect.void;
    };

    const restoreRam = (
      from: string,
      source: Pick<MachineRef, "port"> & Sizes,
      machine: MachineRef,
    ) =>
      Effect.gen(function* () {
        const native = nativeName(machine);
        const { port } = machine;

        yield* call(
          ["machine", "create", "--name", native, "--from", from, "--restore-cache-entries", "0"],
          `machine create ${native}`,
        );

        if (source.port !== port) {
          yield* call(
            [
              "machine",
              "update",
              "--name",
              native,
              "--remove-port",
              `${source.port}:22`,
              "-p",
              `${port}:22`,
            ],
            `machine update ${native}`,
          );
        }

        yield* boot(native);
        yield* grown(native, source, changes(source, machine));
      });

    return {
      version: requirements.smolvm.testedVersion,
      publishAddress: settings.publishAddress,
      pin,
      stopResumes: true,
      growsLive: true,
      startup: Effect.fn("Smolvm.startup")(() =>
        Effect.gen(function* () {
          yield* removeAll(paths.forks);

          for (const dir of [paths.store, paths.forks]) {
            yield* files(
              `couldn't create ${dir}`,
              fs.makeDirectory(dir, { recursive: true, mode: 0o700 }),
            );
          }
        }),
      ),
      observe: Effect.fn("Smolvm.observe")(observe),
      admit: Effect.fn("Smolvm.admit")((activation) =>
        checkRamBudget(settings.ramBudgetMib, activation, observe),
      ),
      capacity: Effect.fn("Smolvm.capacity")((machines) =>
        Effect.map(inUse(machines, observe), ({ running, unread }) =>
          allotted(running, unread, settings.ramBudgetMib),
        ),
      ),
      capture: Effect.fn("Smolvm.capture")((machine, checkpoint) =>
        Effect.andThen(
          copyable(
            machine,
            `a smolvm checkpoint holds a running machine's RAM, and ${machine.id} is stopped: start it first`,
          ),
          captureRam(machine, paths.store, checkpointDir(checkpoint)),
        ),
      ),
      restore: Effect.fn("Smolvm.restore")((checkpoint, machine) =>
        restoreRam(checkpointDir(checkpoint), checkpoint, machine),
      ),
      fork: Effect.fn("Smolvm.fork")((source, machine) => {
        const store = join(paths.forks, nativeName(machine));
        const output = join(store, `${nativeName(machine)}.checkpoint`);

        return Effect.andThen(
          copyable(
            source,
            `a fork copies a running machine, RAM included, and ${source.id} is stopped: start it first`,
          ),
          Effect.andThen(
            captureRam(source, store, output),
            restoreRam(output, source, machine),
          ).pipe(
            Effect.ensuring(
              removeAll(store).pipe(
                Effect.catch((error) => Effect.logWarning(`fork ${machine.id}: ${error.message}`)),
              ),
            ),
          ),
        );
      }),
      deleteCheckpoint: Effect.fn("Smolvm.deleteCheckpoint")((checkpoint) => {
        const objects = join(paths.store, "objects");

        // Source: smolvm crates/smolvm-checkpoint/src/store.rs prune
        return Effect.gen(function* () {
          yield* removeAll(checkpointDir(checkpoint));

          if (yield* files(`couldn't check ${objects}`, fs.exists(objects))) {
            yield* call(
              ["machine", "checkpoint-prune", "--store", paths.store],
              "machine checkpoint-prune",
            );
          }
        });
      }),
      create: Effect.fn("Smolvm.create")((machine, image) =>
        Effect.gen(function* () {
          const native = nativeName(machine);

          yield* call(
            [
              "machine",
              "create",
              "--name",
              native,
              "--image",
              image,
              "--cpus",
              String(machine.cpu),
              "--mem",
              String(machine.ramMib),
              "--net",
              "--net-backend",
              "virtio-net",
              "-p",
              `${machine.port}:22`,
              "--storage",
              String(machine.diskGib),
            ],
            `machine create ${native}`,
          );

          yield* boot(native);
        }),
      ),
      start: Effect.fn("Smolvm.start")((machine) =>
        Effect.gen(function* () {
          const native = nativeName(machine);
          const recorded = yield* status(native);

          if (recorded === "running") {
            return;
          }

          if (recorded === "missing") {
            return yield* missing("linux", machine);
          }

          if (resumable.has(recorded)) {
            yield* resume(native);

            return;
          }

          // Source: smolvm src/cli/vm_common.rs start_vm_named_with_db
          if (recorded === "frozen") {
            return yield* new WrongState({
              message: `smolvm reads machine ${machine.id} ${recorded}, and doesn't start it from there`,
              machine: machine.id,
              state: recorded,
            });
          }

          yield* boot(native);
        }),
      ),
      stop: Effect.fn("Smolvm.stop")((machine) =>
        Effect.gen(function* () {
          const native = nativeName(machine);
          const recorded = yield* status(native);

          if (recorded === "missing") {
            return;
          }

          if (resumable.has(recorded)) {
            yield* resume(native);
          } else if (!alive.has(recorded)) {
            return;
          }

          yield* call(["machine", "stop", "--name", native], `machine stop ${native}`);
        }),
      ),
      pause: Effect.fn("Smolvm.pause")((machine) =>
        Effect.gen(function* () {
          const native = nativeName(machine);
          const recorded = yield* status(native);

          if (recorded === "paused") {
            return;
          }

          if (recorded === "missing") {
            return yield* missing("linux", machine);
          }

          if (recorded === "pausing") {
            yield* resume(native);
          } else if (recorded !== "running") {
            return yield* new WrongState({
              message: `smolvm reads machine ${machine.id} ${recorded}, and pauses only a running machine`,
              machine: machine.id,
              state: recorded,
            });
          }

          yield* call(["machine", "pause", "--name", native], `machine pause ${native}`);
        }),
      ),
      sizable,
      resize: Effect.fn("Smolvm.resize")((machine, to, running) =>
        running ? grown(nativeName(machine), machine, to) : updated(nativeName(machine), to),
      ),
      sizes: Effect.fn("Smolvm.sizes")((machine) => {
        const native = nativeName(machine);

        return Effect.flatMap(
          call(["machine", "status", "--name", native, "--json"], `machine status ${native}`),
          (ran) =>
            decodeSizes(ran.stdout).pipe(
              Effect.map(({ cpus, memory_mib, storage_gb }) => ({
                cpu: cpus,
                ramMib: memory_mib,
                diskGib: storage_gb ?? defaultStorageGib,
              })),
              Effect.mapError(
                (error) =>
                  new Internal({
                    message: `smolvm machine status ${native} answered something unexpected: ${error.message}`,
                  }),
              ),
            ),
        );
      }),
      delete: Effect.fn("Smolvm.delete")(removeVm),
      exec: Effect.fn("Smolvm.exec")((machine, { argv, stdin, user }) => {
        const native = nativeName(machine);

        return exec(
          binary,
          ["machine", "exec", "--name", native, "--user", user ?? "root", "-i", "--", ...argv],
          stdin,
          `smolvm machine exec ${native}`,
        );
      }),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "stateDir" | "listen"> & {
    readonly linux: typeof SmolvmSettings.Type;
  },
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(
    Runtime,
    Effect.flatMap(ramBudget(config.linux.ramBudgetMib), (ramBudgetMib) =>
      make(
        {
          prefix: config.linux.prefix,
          publishAddress: config.listen.address,
          ramBudgetMib,
          stateDir: config.stateDir,
          arch: process.arch,
        },
        process.getuid?.(),
      ),
    ),
  );
