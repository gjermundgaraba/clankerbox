import { totalmem } from "node:os";
import path from "node:path";

import {
  formatMib,
  Internal,
  Invalid,
  isBuildCopy,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type { HostError, Sizing } from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";

import {
  atLeast,
  CannotStart,
  changes,
  missing,
  Runtime,
  stateReadWait,
  timeoutFail,
} from "../runtime.ts";
import type {
  CheckpointRef,
  Interface,
  MachineRef,
  MachineState,
  Native,
  Observed,
  Sizes,
  StateError,
} from "../runtime.ts";
import type { HostSettings } from "../settings.ts";
import { allotted, checkRamBudget, inUse } from "../usage.ts";
import { cliIn, expect, failure, files, regularFiles } from "./process.ts";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

export const SmolvmSettings = Schema.Struct({
  prefix: Schema.String,
  ramBudgetMib: Schema.optionalKey(Size),
});

const mib = 1024 * 1024;

const reservedMib = 2048;

export const ramBudget = (
  set: number | undefined
): Effect.Effect<number, Invalid> => {
  const ramBudgetMib = set ?? Math.floor(totalmem() / mib) - reservedMib;

  return ramBudgetMib <= 0
    ? Effect.fail(
        new Invalid({
          message:
            "linux.ramBudgetMib: physical RAM leaves no default budget; set one",
        })
      )
    : Effect.succeed(ramBudgetMib);
};

export interface Settings {
  readonly prefix: string;
  readonly publishAddress: string;
  readonly ramBudgetMib: number;
  readonly stateDir: string;
  readonly arch: string;
  readonly bootId: string;
}

const bootIdFile = "/proc/sys/kernel/random/boot_id";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/live_resize.rs#L368
const ramStepMib = 128;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/data/resources.rs#L250
const minimumRamMib = 64;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/data/storage.rs#L14
const defaultStorageGib = 20;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L4511
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6466
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6539
const maximumCpu = 255;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L4517
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6470
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6543
const maximumRamMib = 2 ** 32 - 1;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/db/resize.rs#L179
const unfinishedRefusal = "an unfinished resize belongs to a different target";

export const pathsIn = (stateDir: string) => ({
  dataDir: path.join(stateDir, "smolvm"),
  store: path.join(stateDir, "checkpoints"),
  forks: path.join(stateDir, "forks"),
});

/** The oldest smolvm a linux host starts under; the `bump-smolvm` skill owns it. */
export const minimumVersion = "1.34.0";

const supported = atLeast(minimumVersion);

// https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-checkpoint/src/store.rs#L28
const captureOwner = ".capture-owner";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-checkpoint/src/store.rs#L85
const objectName = /^[0-9a-f]{64}$/u;

const objectKeyPrefix = "smolvm/";

const storedObject = (file: string): string | undefined => {
  const [dir, name, ...rest] = file.split("/");

  return dir === "objects" &&
    name !== undefined &&
    rest.length === 0 &&
    objectName.test(name)
    ? name
    : undefined;
};

const instanceChars = 8;

export const nativeName = (
  resource: Pick<MachineRef, "name" | "instance">
): string => `${resource.name}-${resource.instance.slice(0, instanceChars)}`;

const nameOf = (native: string): string =>
  native.slice(0, -(instanceChars + 1));

const observeConcurrency = 8;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/manager.rs#L127
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/process.rs#L3794
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/state_probe.rs#L41
const exitWait = Duration.seconds(30);

const exitPause = Duration.millis(500);

export const machineReadWait = Duration.subtract(
  stateReadWait,
  Duration.seconds(1)
);

export const observeEach = (
  machines: readonly Native[],
  read: (machine: Native) => Effect.Effect<MachineState, Internal>
): Effect.Effect<Observed> =>
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
                new Internal({
                  message: `no answer within ${Duration.format(machineReadWait)}`,
                })
            ),
            Effect.catch((error): Effect.Effect<MachineState> =>
              Effect.as(
                Effect.logWarning(
                  `couldn't read ${machine.name}'s state: ${error.message}`
                ),
                "unknown"
              )
            ),
            Effect.map((state) => [machine.name, state] as const)
          ),
      { concurrency: "unbounded" }
    ).pipe(Effect.map((entries): Observed => new Map(entries)))
  );

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/systemd_scope.rs#L458
const scopeName = (native: string): string => `smolvm-vm-${native}.scope`;

export const templates = [
  "storage-template.ext4",
  "overlay-template.ext4",
] as const;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/manager.rs#L390
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/fork.rs#L322
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/launcher_dynamic.rs#L1284
const socketPathMax = 107;

export const controlSocket = (dataDir: string): string =>
  path.join(dataDir, ".cache", "smolvm", "vms", "0".repeat(16), "control.sock");

const searchPath =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/process.rs#L1510
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/process.rs#L480
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/usage.rs#L178
// https://github.com/tokio-rs/tracing/blob/tracing-subscriber-0.3.23/tracing-subscriber/src/fmt/fmt_layer.rs#L743
export const environment = (settings: Settings) => ({
  PATH: searchPath,
  HOME: pathsIn(settings.stateDir).dataDir,
  SMOLVM_DATA_DIR: pathsIn(settings.stateDir).dataDir,
  SMOLVM_AGENT_ROOTFS: path.join(
    settings.prefix,
    ".local",
    "share",
    "smolvm",
    "agent-rootfs"
  ),
  SMOLVM_RESTORE_TMPFS: "0",
  SMOLVM_VM_USE_SCOPE: "1",
  SMOLVM_OOM_VICTIM_ORDER: "0",
  SMOLVM_USAGE: "0",
  SMOLVM_PUBLISH_ADDR: settings.publishAddress,
  SMOLVM_EGRESS_FLOOR: "strict",
  NO_COLOR: "1",
});

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/config.rs#L39
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

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/vm_common.rs#L3492
const decodeStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      state: RecordState,
      parent_machine: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })
  )
);

const decodeList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
);

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/vm_common.rs#L2785
const pinnedRefusal = "is the fork base for";

const checkpointSuffix = ".checkpoint";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-checkpoint/src/store.rs#L20
const checkpointIndex = "checkpoint.json";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-pack/src/format.rs#L463
// https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-pack/src/format.rs#L632
const decodeIndex = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      manifest: Schema.Struct({
        smolvm_version: Schema.optionalKey(Schema.String),
        checkpoint: Schema.Struct({
          network: Schema.optionalKey(
            Schema.Struct({
              ports: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({ host: Schema.Int, guest: Schema.Int })
                )
              ),
            })
          ),
        }),
      }),
    })
  )
);

interface BaseName {
  readonly bootId: string;
  readonly build: string;
}

const baseName = ({ bootId, build }: BaseName) => `base_${bootId}_${build}`;

const freezerOf = (base: string) => `${base}_freeze`;

const basePattern = /^base_(?<bootId>[^_]+)_(?<build>[^_]+)(?:_freeze)?$/u;

const baseParts = (name: string): BaseName | undefined => {
  const { bootId, build } = basePattern.exec(name)?.groups ?? {};

  return bootId === undefined || build === undefined
    ? undefined
    : { bootId, build };
};

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/vm_common.rs#L3449
const decodeSizes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      cpus: Size,
      memory_mib: Size,
      storage_gb: Schema.NullOr(Size),
    })
  )
);

const alive: ReadonlySet<RecordState> = new Set([
  "running",
  "pausing",
  "unreachable",
  "frozen",
]);

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/embedded/runtime.rs#L412
const resumable: ReadonlySet<RecordState> = new Set(["pausing", "paused"]);

export const stateOf = (state: RecordState): MachineState => {
  if (state === "paused") {
    return "paused";
  }

  return alive.has(state) ? "running" : "stopped";
};

const given = (flag: string, size: number | undefined) =>
  size === undefined ? [] : [flag, String(size)];

export const make = (
  settings: Settings,
  uid: number | undefined
): Effect.Effect<
  Interface,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const binary = path.join(settings.prefix, "smolvm");
    const paths = pathsIn(settings.stateDir);
    const { run, exec } = yield* cliIn(environment(settings));

    const smolvm = (args: readonly string[], what: string) =>
      run(binary, args, `smolvm ${what}`);

    const call = (args: readonly string[], what: string) =>
      Effect.flatMap(smolvm(args, what), (ran) =>
        expect(ran, `smolvm ${what}`)
      );

    const systemctl = (args: readonly string[], what: string) =>
      Effect.flatMap(run("systemctl", args, `systemctl ${what}`), (ran) =>
        expect(ran, `systemctl ${what}`)
      );

    const removeAll = (directory: string) =>
      files(
        `couldn't remove ${directory}`,
        fs.remove(directory, { recursive: true, force: true })
      );

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
      const file = path.join(settings.prefix, template);

      const present = yield* files(`couldn't check ${file}`, fs.exists(file));

      if (!present) {
        return yield* new CannotStart({
          message: `smolvm prefix ${settings.prefix} has no ${template}: expand it at install with zstd -d --sparse ${file}.zst -o ${file}`,
        });
      }
    }

    const reported = (yield* call(["--version"], "--version")).stdout.trim();

    const version = reported.replace(/^smolvm /u, "");

    if (version === reported || !supported(version)) {
      return yield* new CannotStart({
        message: `${binary} reports "${reported}", and this host needs smolvm ${minimumVersion} or later`,
      });
    }

    const pin = `smolvm ${version} ${process.platform}-${process.arch}`;

    const recordOf = (native: string) =>
      Effect.flatMap(
        smolvm(
          ["machine", "status", "--name", native, "--json"],
          `machine status ${native}`
        ),
        (
          ran
        ): Effect.Effect<
          | { readonly state: RecordState; readonly parent: string | undefined }
          | "missing",
          Internal
        > => {
          if (ran.exitCode === 0) {
            return decodeStatus(ran.stdout).pipe(
              Effect.map(({ state, parent_machine }) => ({
                state,
                parent: parent_machine ?? undefined,
              })),
              Effect.mapError(
                (error) =>
                  new Internal({
                    message: `smolvm machine status ${native} answered something unexpected: ${error.message}`,
                  })
              )
            );
          }

          return ran.stderr.includes(`machine '${native}' not found`)
            ? Effect.succeed("missing" as const)
            : Effect.fail(failure(`smolvm machine status ${native}`, ran));
        }
      );

    const status = (native: string) =>
      Effect.map(recordOf(native), (found) =>
        found === "missing" ? found : found.state
      );

    const state = (native: string): Effect.Effect<MachineState, Internal> =>
      Effect.map(status(native), (recorded) =>
        recorded === "missing" ? recorded : stateOf(recorded)
      );

    const exited = (native: string, error: Internal) =>
      status(native).pipe(
        Effect.repeat({
          until: (recorded) => recorded !== "unreachable",
          schedule: Schedule.spaced(exitPause),
        }),
        Effect.mapError(
          (read) =>
            new Internal({ message: `${error.message}; then ${read.message}` })
        ),
        timeoutFail(
          exitWait,
          () =>
            new Internal({
              message: `${error.message}; smolvm still read it unreachable ${Duration.format(exitWait)} later`,
            })
        ),
        Effect.flatMap((recorded) =>
          recorded === "stopped" || recorded === "missing"
            ? Effect.void
            : Effect.fail(error)
        )
      );

    const observe = (machines: readonly Native[]) =>
      observeEach(machines, (machine) => state(nativeName(machine)));

    const boot = (native: string) =>
      call(
        ["machine", "start", "--name", native, "--branchable"],
        `machine start ${native}`
      );

    const resume = (native: string) =>
      call(["machine", "resume", "--name", native], `machine resume ${native}`);

    const copyable = (machine: MachineRef, stopped: string) =>
      Effect.flatMap(
        status(nativeName(machine)),
        (recorded): Effect.Effect<void, StateError> => {
          if (recorded === "running") {
            return Effect.void;
          }

          if (recorded === "missing") {
            return Effect.fail(missing("linux", machine));
          }

          const refusal =
            alive.has(recorded) || resumable.has(recorded)
              ? `smolvm reads machine ${machine.name} ${recorded}, and copies only a running machine`
              : stopped;

          const message =
            recorded === "unreachable"
              ? `smolvm reads machine ${machine.name} unreachable: its VM runs, but its agent doesn't answer; start it to boot it again`
              : refusal;

          return Effect.fail(
            new WrongState({ message, machine: machine.name, state: recorded })
          );
        }
      );

    const storedAt = (native: string) =>
      path.join(paths.store, `${native}${checkpointSuffix}`);

    const checkpointDir = (checkpoint: CheckpointRef) =>
      storedAt(nativeName(checkpoint));

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
        `machine checkpoint ${native}`
      );
    };

    const removing = (native: string, recorded: RecordState | "missing") =>
      Effect.gen(function* () {
        const scope = scopeName(native);

        if (recorded === "missing") {
          return;
        }

        if (stateOf(recorded) === "running") {
          yield* call(
            ["machine", "stop", "--name", native, "--timeout", "0"],
            `machine stop ${native}`
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`delete ${native}: ${error.message}`)
            )
          );
        }

        const loaded = yield* systemctl(
          ["show", "--property=LoadState", "--value", scope],
          `show ${scope}`
        );

        const killed = loaded.stdout.trim() === "loaded";

        if (killed) {
          yield* systemctl(
            ["kill", "--signal=SIGKILL", scope],
            `kill ${scope}`
          );
        }

        yield* call(
          ["machine", "delete", "--name", native, "--force"],
          `machine delete ${native}`
        );

        if (killed) {
          yield* Effect.ignore(
            systemctl(["reset-failed", scope], `reset-failed ${scope}`)
          );
        }
      });

    const removeNative = (native: string) =>
      Effect.flatMap(status(native), (recorded) => removing(native, recorded));

    const updated = (native: string, to: Sizing) => {
      const flags = [
        ...given("--cpus", to.cpu),
        ...given("--mem", to.ramMib),
        ...given("--storage", to.diskGib),
      ];

      return flags.length === 0
        ? Effect.void
        : Effect.asVoid(
            call(
              ["machine", "update", "--name", native, ...flags],
              `machine update ${native}`
            )
          );
    };

    const grown = (native: string, machine: Sizes, to: Sizing) => {
      const each: ReadonlyArray<readonly [string, number, number | undefined]> =
        [
          ["--mem", machine.ramMib, to.ramMib],
          [
            "--cpus",
            machine.cpu,
            to.cpu === machine.cpu && settings.arch !== "x64"
              ? undefined
              : to.cpu,
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
                  `machine resize ${native}`
                ),
                (ran) =>
                  size === had &&
                  ran.exitCode !== 0 &&
                  ran.stderr.includes(unfinishedRefusal)
                    ? Effect.void
                    : Effect.asVoid(
                        expect(ran, `smolvm machine resize ${native}`)
                      )
              ),
        { discard: true }
      );
    };

    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/live_resize.rs#L391
    const sizable = (
      machine: Pick<MachineRef, "name">,
      from: Sizes,
      to: Sizes,
      live: boolean
    ) => {
      if (to.ramMib < minimumRamMib) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm gives a machine at least ${formatMib(minimumRamMib)} of RAM, and ${machine.name} would have ${formatMib(to.ramMib)}`,
          })
        );
      }

      if (to.cpu > maximumCpu) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm's CLI takes at most ${maximumCpu} vCPUs, and ${machine.name} would have ${to.cpu}`,
          })
        );
      }

      if (to.ramMib > maximumRamMib) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm's CLI takes at most ${formatMib(maximumRamMib)} of RAM, and ${machine.name} would have ${formatMib(to.ramMib)}`,
          })
        );
      }

      if (!live) {
        return Effect.void;
      }

      if ((to.ramMib - from.ramMib) % ramStepMib !== 0) {
        return Effect.fail(
          new Unsizable({
            message: `smolvm grows a running machine's RAM in ${ramStepMib}M steps, and ${machine.name}'s would grow from ${formatMib(from.ramMib)} to ${formatMib(to.ramMib)}`,
          })
        );
      }

      return to.cpu > from.cpu && settings.arch !== "x64"
        ? Effect.fail(
            new Unsizable({
              message: `smolvm grows a running machine's vCPUs only on x86_64, and this host is ${settings.arch}: give ${machine.name} more vCPUs once it is stopped`,
            })
          )
        : Effect.void;
    };

    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/machine_spec.rs#L1181
    const createdFrom = (
      native: string,
      from: string,
      forwards: readonly string[]
    ) =>
      call(
        [
          "machine",
          "create",
          "--name",
          native,
          "--from",
          from,
          ...forwards.flatMap((forward) => ["-p", forward]),
          "--restore-cache-entries",
          "0",
        ],
        `machine create ${native}`
      );

    const restoreRam = (from: string, source: Sizes, machine: MachineRef) =>
      Effect.gen(function* () {
        const native = nativeName(machine);

        yield* createdFrom(native, from, [`${machine.port}:22`]);
        yield* boot(native);
        yield* grown(native, source, changes(source, machine));
      });

    const baseOf = (build: string) =>
      baseName({ bootId: settings.bootId, build });

    const locks = new Map<string, Semaphore.Semaphore>();

    const alone = (base: string) => {
      const lock = locks.get(base) ?? Semaphore.makeUnsafe(1);

      locks.set(base, lock);

      return lock.withPermits(1);
    };

    const stored = (native: string) =>
      files(`couldn't check ${storedAt(native)}`, fs.exists(storedAt(native)));

    const retire = (base: string) =>
      Effect.gen(function* () {
        yield* removeNative(freezerOf(base));

        if ((yield* status(base)) === "missing") {
          return true;
        }

        const ran = yield* smolvm(
          ["machine", "delete", "--name", base, "--force"],
          `machine delete ${base}`
        );

        if (ran.exitCode !== 0) {
          return ran.stderr.includes(pinnedRefusal)
            ? false
            : yield* failure(`smolvm machine delete ${base}`, ran);
        }

        yield* Effect.ignore(
          systemctl(
            ["reset-failed", scopeName(base)],
            `reset-failed ${scopeName(base)}`
          )
        );

        return true;
      });

    const freeze = (base: string) =>
      Effect.andThen(
        call(
          [
            "machine",
            "branch",
            "--from",
            base,
            "--name",
            freezerOf(base),
            "--freeze-source",
          ],
          `machine branch ${freezerOf(base)}`
        ),
        removeNative(freezerOf(base))
      );

    const indexOf = (build: string) =>
      Effect.gen(function* () {
        const index = path.join(storedAt(build), checkpointIndex);

        const read = yield* files(
          `couldn't read ${index}`,
          fs.readFileString(index)
        );

        const { manifest } = yield* Effect.mapError(
          decodeIndex(read),
          (error) =>
            new Internal({
              message: `${index} holds something unexpected: ${error.message}`,
            })
        );

        return {
          capturedUnder: manifest.smolvm_version,
          forwards: manifest.checkpoint.network?.ports ?? [],
        };
      });

    const parkAnew = (base: string, build: string) =>
      Effect.gen(function* () {
        const [took] = yield* Effect.timed(
          Effect.gen(function* () {
            const { forwards } = yield* indexOf(build);

            yield* createdFrom(base, storedAt(build), []);

            if (forwards.length > 0) {
              yield* call(
                [
                  "machine",
                  "update",
                  "--name",
                  base,
                  ...forwards.flatMap(({ host, guest }) => [
                    "--remove-port",
                    `${host}:${guest}`,
                  ]),
                ],
                `machine update ${base}`
              );
            }

            yield* boot(base);
            yield* freeze(base);
          })
        );

        yield* Effect.logInfo(`parked ${base} in ${Duration.format(took)}`);
      });

    const settled = (base: string, build: string) =>
      Effect.gen(function* () {
        yield* removeNative(freezerOf(base));

        const recorded = yield* status(base);

        if (recorded === "frozen") {
          return;
        }

        if (recorded === "running") {
          yield* freeze(base);

          return;
        }

        if (recorded !== "missing" && !(yield* retire(base))) {
          return yield* Effect.logWarning(
            `${base} is ${recorded}, and the copies branched from it keep it: copies of its build restore until they go`
          );
        }

        yield* parkAnew(base, build);
      });

    const capturedElsewhere = (build: string) =>
      Effect.map(indexOf(build), ({ capturedUnder }) => {
        if (capturedUnder === version) {
          return undefined;
        }

        return capturedUnder === undefined
          ? `${build}'s ${checkpointIndex} names no smolvm version`
          : `${build} was captured under smolvm ${capturedUnder}, not this host's ${version}`;
      });

    const parking = (build: string) =>
      alone(baseOf(build))(
        Effect.gen(function* () {
          if (!(yield* stored(build))) {
            return;
          }

          const why = yield* capturedElsewhere(build);

          if (why !== undefined) {
            return yield* Effect.logWarning(
              `${why}, so it parks no base and its copies restore`
            );
          }

          yield* settled(baseOf(build), build);
        })
      );

    const stale = ({ bootId, build }: BaseName) =>
      Effect.gen(function* () {
        if (bootId !== settings.bootId || !(yield* stored(build))) {
          return true;
        }

        return (yield* capturedElsewhere(build)) !== undefined;
      });

    const retireStale = (named: BaseName) => {
      const base = baseName(named);

      return alone(base)(
        Effect.gen(function* () {
          if (yield* stale(named)) {
            yield* retire(base);
          }
        })
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`retire ${base}: ${error.message}`)
        )
      );
    };

    const orphaned = (parent: string) => {
      const named = baseParts(parent);

      return named === undefined ? Effect.void : retireStale(named);
    };

    const listed = Effect.flatMap(
      call(["machine", "ls", "--json"], "machine ls"),
      (ran) =>
        Effect.mapError(
          decodeList(ran.stdout),
          (error) =>
            new Internal({
              message: `smolvm machine ls answered something unexpected: ${error.message}`,
            })
        )
    );

    const builds = Effect.map(
      files(`couldn't list ${paths.store}`, fs.readDirectory(paths.store)),
      (entries) =>
        entries.flatMap((entry) => {
          const build = entry.endsWith(checkpointSuffix)
            ? entry.slice(0, -checkpointSuffix.length)
            : "";

          return isBuildCopy(nameOf(build)) ? [build] : [];
        })
    );

    const retireAllStale = Effect.gen(function* () {
      const listedBases = new Map(
        (yield* listed).flatMap(({ name }) => {
          const named = baseParts(name);

          return named === undefined ? [] : [[baseName(named), named]];
        })
      );

      yield* Effect.forEach(listedBases.values(), retireStale, {
        discard: true,
      });
    });

    const bases = {
      park: Effect.fn("Smolvm.park")((build: CheckpointRef) =>
        isBuildCopy(build.name) ? parking(nativeName(build)) : Effect.void
      ),
      settle: Effect.gen(function* () {
        yield* retireAllStale;

        yield* Effect.forEach(
          yield* builds,
          (build) =>
            parking(build).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`park ${baseOf(build)}: ${error.message}`)
              )
            ),
          { discard: true }
        );
      }),
    };

    const heldMib = Effect.gen(function* () {
      const held = (yield* listed).flatMap(({ name }) =>
        baseParts(name) === undefined ? [] : [scopeName(name)]
      );

      if (held.length === 0) {
        return 0;
      }

      const shown = yield* systemctl(
        ["show", "--property=MemoryCurrent", "--value", ...held],
        "show the parked bases' memory"
      );

      const bytes = shown.stdout
        .split("\n")
        .filter((line) => /^\d+$/u.test(line))
        .reduce((sum, line) => sum + Number(line), 0);

      return Math.ceil(bytes / mib);
    });

    const branched = (base: string, machine: MachineRef) =>
      Effect.gen(function* () {
        const native = nativeName(machine);

        const [took] = yield* Effect.timed(
          call(
            [
              "machine",
              "branch",
              "--from",
              base,
              "--name",
              native,
              "--freeze-source",
              "--branchable",
              "-p",
              `${machine.port}:22`,
            ],
            `machine branch ${native}`
          )
        );

        yield* Effect.logInfo(
          `branched ${native} from ${base} in ${Duration.format(took)}`
        );
      });

    return {
      version,
      publishAddress: settings.publishAddress,
      pin,
      stopResumes: true,
      growsLive: true,
      bases,
      startup: Effect.gen(function* () {
        yield* removeAll(paths.forks);

        for (const dir of [paths.store, paths.forks]) {
          yield* files(
            `couldn't create ${dir}`,
            fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
          );
        }

        for (const entry of yield* files(
          `couldn't list ${paths.store}`,
          fs.readDirectory(paths.store)
        )) {
          if (entry.endsWith(".fetching")) {
            yield* removeAll(path.join(paths.store, entry));
          }
        }
      }),
      adopt: () => Effect.void,
      observe: Effect.fn("Smolvm.observe")(observe),
      admit: Effect.fn("Smolvm.admit")((activation) =>
        Effect.flatMap(heldMib, (held) =>
          checkRamBudget(settings.ramBudgetMib, activation, observe, held)
        )
      ),
      capacity: Effect.fn("Smolvm.capacity")((machines) =>
        Effect.map(inUse(machines, observe), ({ running, unread }) =>
          allotted(running, unread, settings.ramBudgetMib)
        )
      ),
      capture: Effect.fn("Smolvm.capture")((machine, checkpoint) =>
        Effect.andThen(
          copyable(
            machine,
            `a smolvm checkpoint holds a running machine's RAM, and ${machine.name} is stopped: start it first`
          ),
          captureRam(machine, paths.store, checkpointDir(checkpoint))
        )
      ),
      restore: Effect.fn("Smolvm.restore")((checkpoint, machine) =>
        Effect.gen(function* () {
          const base = baseOf(nativeName(checkpoint));
          const native = nativeName(machine);

          const frozen = Effect.matchEffect(status(base), {
            onFailure: (error) =>
              Effect.as(
                Effect.logWarning(
                  `couldn't read ${base}, so ${native} restores the copy: ${error.message}`
                ),
                false
              ),
            onSuccess: (recorded) => Effect.succeed(recorded === "frozen"),
          });

          const restored = restoreRam(
            checkpointDir(checkpoint),
            checkpoint,
            machine
          );

          if (!(yield* frozen)) {
            return yield* restored;
          }

          const went = yield* branched(base, machine).pipe(
            Effect.as(false),
            Effect.catch((error) =>
              Effect.flatMap(frozen, (still) =>
                still
                  ? Effect.fail(error)
                  : removeNative(native).pipe(
                      Effect.as(true),
                      Effect.catch((error_) =>
                        Effect.andThen(
                          Effect.logWarning(
                            `${base} went before ${native} could branch it, and ${native} couldn't be removed to restore the copy: ${error_.message}`
                          ),
                          Effect.fail(error)
                        )
                      )
                    )
              )
            )
          );

          if (went) {
            yield* Effect.logWarning(
              `${base} went before ${native} could branch it, so ${native} restores the copy`
            );

            return yield* restored;
          }

          yield* grown(native, checkpoint, changes(checkpoint, machine));
        })
      ),
      fork: Effect.fn("Smolvm.fork")((source, machine) => {
        const store = path.join(paths.forks, nativeName(machine));
        const output = path.join(store, `${nativeName(machine)}.checkpoint`);

        return Effect.andThen(
          copyable(
            source,
            `a fork copies a running machine, RAM included, and ${source.name} is stopped: start it first`
          ),
          Effect.andThen(
            captureRam(source, store, output),
            restoreRam(output, source, machine)
          ).pipe(
            Effect.ensuring(
              removeAll(store).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`fork ${machine.name}: ${error.message}`)
                )
              )
            )
          )
        );
      }),
      deleteCheckpoint: Effect.fn("Smolvm.deleteCheckpoint")((checkpoint) => {
        const objects = path.join(paths.store, "objects");

        const base = baseOf(nativeName(checkpoint));

        return alone(base)(
          Effect.gen(function* () {
            yield* removeAll(checkpointDir(checkpoint));

            // https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-checkpoint/src/store.rs#L1666
            if (yield* files(`couldn't check ${objects}`, fs.exists(objects))) {
              yield* call(
                ["machine", "checkpoint-prune", "--store", paths.store],
                "machine checkpoint-prune"
              );
            }

            yield* retire(base);
          })
        );
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
            `machine create ${native}`
          );

          yield* boot(native);
        })
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

          // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/vm_common.rs#L1637
          if (recorded === "frozen") {
            return yield* new WrongState({
              message: `smolvm reads machine ${machine.name} ${recorded}, and doesn't start it from there`,
              machine: machine.name,
              state: recorded,
            });
          }

          yield* boot(native);
        })
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

          yield* Effect.uninterruptible(
            call(
              ["machine", "stop", "--name", native],
              `machine stop ${native}`
            ).pipe(Effect.catch((error) => exited(native, error)))
          );
        })
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
              message: `smolvm reads machine ${machine.name} ${recorded}, and pauses only a running machine`,
              machine: machine.name,
              state: recorded,
            });
          }

          yield* call(
            ["machine", "pause", "--name", native],
            `machine pause ${native}`
          );
        })
      ),
      sizable,
      resize: Effect.fn("Smolvm.resize")((machine, to, running) =>
        running
          ? grown(nativeName(machine), machine, to)
          : updated(nativeName(machine), to)
      ),
      sizes: Effect.fn("Smolvm.sizes")((machine) => {
        const native = nativeName(machine);

        return Effect.flatMap(
          call(
            ["machine", "status", "--name", native, "--json"],
            `machine status ${native}`
          ),
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
                  })
              )
            )
        );
      }),
      delete: Effect.fn("Smolvm.delete")((machine) =>
        Effect.gen(function* () {
          const native = nativeName(machine);
          const found = yield* recordOf(native);

          if (found === "missing") {
            return yield* retireAllStale.pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `retire the bases ${native} may have kept: ${error.message}`
                )
              )
            );
          }

          yield* removing(native, found.state);

          if (found.parent !== undefined) {
            yield* orphaned(found.parent);
          }
        })
      ),
      exec: Effect.fn("Smolvm.exec")(function* (
        machine,
        { argv, stdin, user }
      ) {
        const native = nativeName(machine);
        const what = `smolvm machine exec ${native}`;

        const inGuest = (as: string, command: readonly string[]) => [
          "machine",
          "exec",
          "--name",
          native,
          "--user",
          as,
          "-i",
          "--",
          ...command,
        ];

        if (user === undefined || user === "root") {
          return yield* exec(binary, inGuest("root", argv), stdin, what);
        }

        // smolvm's --user hands crun only uid:gid, so the user's supplementary groups are lost:
        // https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-agent/src/oci.rs#L272
        const sudo = yield* run(
          binary,
          inGuest("root", ["/bin/sh", "-c", "command -v sudo"]),
          what
        );

        return yield* exec(
          binary,
          sudo.exitCode === 0
            ? inGuest("root", ["sudo", "-n", "-u", user, "-H", "--", ...argv])
            : inGuest(user, argv),
          stdin,
          what
        );
      }),
      checkpointFiles: Effect.fn("Smolvm.checkpointFiles")((checkpoint) =>
        Effect.map(regularFiles(fs, checkpointDir(checkpoint)), (found) =>
          found.flatMap((file) => {
            const object = storedObject(file);

            return file === captureOwner
              ? []
              : [
                  {
                    path: file,
                    file: path.join(checkpointDir(checkpoint), file),
                    ...(object === undefined
                      ? {}
                      : { key: `${objectKeyPrefix}${object}` }),
                  },
                ];
          })
        )
      ),
      held: (key) => {
        const hash = key.slice(objectKeyPrefix.length);
        const file = path.join(paths.store, "objects", hash);

        return key.startsWith(objectKeyPrefix) && objectName.test(hash)
          ? Effect.map(
              Effect.orElseSucceed(fs.exists(file), () => false),
              (exists) => (exists ? file : undefined)
            )
          : Effect.undefined;
      },
      staging: (checkpoint) =>
        path.join(paths.store, `${nativeName(checkpoint)}.fetching`),
      install: Effect.fn("Smolvm.install")((checkpoint, staged) =>
        Effect.gen(function* () {
          const objects = path.join(paths.store, "objects");

          yield* files(
            `couldn't create ${objects}`,
            fs.makeDirectory(objects, { recursive: true, mode: 0o700 })
          );

          // Prune removes every store object with one link, so each takes the store's name too.
          // https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-checkpoint/src/store.rs#L3021
          for (const file of yield* regularFiles(fs, staged)) {
            const object = storedObject(file);

            if (object !== undefined) {
              yield* files(
                `couldn't add object ${object} to the store`,
                fs
                  .link(path.join(staged, file), path.join(objects, object))
                  .pipe(
                    Effect.catchReason(
                      "PlatformError",
                      "AlreadyExists",
                      () => Effect.void
                    )
                  )
              );
            }
          }

          yield* files(
            `couldn't install checkpoint ${checkpoint.name}`,
            fs.rename(staged, checkpointDir(checkpoint))
          );
        })
      ),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "stateDir" | "listen"> & {
    readonly linux: typeof SmolvmSettings.Type;
  }
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ramBudgetMib = yield* ramBudget(config.linux.ramBudgetMib);

      const bootId = yield* files(
        `couldn't read the host's boot ID from ${bootIdFile}`,
        fs.readFileString(bootIdFile)
      );

      return yield* make(
        {
          prefix: config.linux.prefix,
          publishAddress: config.listen.address,
          ramBudgetMib,
          stateDir: config.stateDir,
          arch: process.arch,
          bootId: bootId.replaceAll("-", "").slice(0, 8),
        },
        process.getuid?.()
      );
    })
  );
