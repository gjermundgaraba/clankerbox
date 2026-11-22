import { totalmem } from "node:os";
import path from "node:path";

import { liveGrowthRefusal } from "@clankerbox/host-contract/traits";
import {
  formatMib,
  Internal,
  Invalid,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  HostError,
  Missing,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { Path, Scope } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import { Box } from "../../box.ts";
import type { Facts } from "../../box.ts";
import { checkPort, PortProbe } from "../../machine-ports.ts";
import {
  atLeast,
  CannotStart,
  changes,
  Handle,
  missing,
  missingCheckpoint,
  Runtime,
  stateReadWait,
  timeoutFail,
  unshared,
} from "../../runtime.ts";
import type {
  Command,
  Identity,
  Interface,
  MachineRef,
  MachineState,
  Observed,
  Sighting,
  Sizes,
  StateError,
  Target,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import { allotted, checkRamBudget, inUse } from "../../usage.ts";
import { throughBucket } from "../bucket/builds.ts";
import type { CheckpointFiles, Store } from "../bucket/builds.ts";
import * as S3 from "../bucket/s3.ts";
import { cliIn, expect, failure, files, regularFiles } from "../process.ts";
import { aloneOnBox, boxLock } from "./one-per-box.ts";
import { ramGrowthMib, traits as traitsOn } from "./traits.ts";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

export const SmolvmSettings = Schema.Struct({
  prefix: Schema.String,
  ramBudgetMib: Schema.optionalKey(Size),
  builds: Schema.optionalKey(S3.BuildsSettings),
});

const mib = 1024 * 1024;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/systemd_scope.rs#L222
const reservedMib = (hostRamMib: number) =>
  Math.min(
    Math.max(Math.floor((hostRamMib * 6) / 100), 8192),
    Math.floor(hostRamMib / 4)
  );

export const ramBudget = (set: number | undefined, hostRamMib: number) =>
  set ?? hostRamMib - reservedMib(hostRamMib);

export interface Settings {
  readonly prefix: string;
  readonly publishAddress: string;
  readonly ramBudgetMib: number;
  readonly stateDir: string;
  readonly arch: string;
  readonly bucket?: Store | undefined;
}

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/data/storage.rs#L14
const defaultStorageGib = 20;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/db/resize.rs#L179
const unfinishedRefusal = "an unfinished resize belongs to a different target";

// https://github.com/smol-machines/libkrun/blob/9df62257098acb5a3cd4f6807cf84f09e1b13323/src/vmm/src/memory_growth.rs#L28
const apertureRefusal = "within the platform aperture";

export const pathsIn = (stateDir: string) => ({
  dataDir: path.join(stateDir, "smolvm"),
  store: path.join(stateDir, "checkpoints"),
  forks: path.join(stateDir, "forks"),
});

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

export const nativeName = (resource: Identity): Handle =>
  Handle.make(`${resource.name}-${resource.instance.slice(0, instanceChars)}`);

const forwarded = (port: number) => `${port}:22`;

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
  machines: readonly Target[],
  read: (machine: Target) => Effect.Effect<Sighting, Internal>
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
            Effect.catch((error): Effect.Effect<Sighting> =>
              Effect.as(
                Effect.logWarning(
                  `couldn't read ${machine.name}'s state: ${error.message}`
                ),
                { state: "unknown" }
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
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String }))
  )
);

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/vm_common.rs#L2785
const pinnedRefusal = "is the fork base for";

const checkpointSuffix = ".checkpoint";

// `pack create -o` names the executable stub, and the pack is beside it with this suffix:
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/pack.rs#L683-L700
const packStub = "machine";

const packSuffix = ".smolmachine";

const freezerOf = (base: string) => `${base}_freeze`;

const basePattern = /^(?<base>base_[^_]+_[^_]+)(?:_freeze)?$/u;

const baseOf = (name: string): string | undefined =>
  basePattern.exec(name)?.groups?.["base"];

// 16 hex digits of the seed's key, then the calling smolvm's PID, which Linux keeps under 2^22:
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/image_seed.rs#L827
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/image_seed.rs#L1019
// https://man7.org/linux/man-pages/man5/proc_sys_kernel.5.html
const seedBuilder = /^image-seed-[0-9a-f]{16}-(?<pid>[1-9]\d{0,6})$/u;

const pidLimit = 2 ** 22;

// smolvm deletes a VM whose name begins so once it is 30 minutes old, at its next seed build or init bake:
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/image_seed.rs#L1263-L1277
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L1017-L1038
const builderPrefixes = [
  { prefix: "image-seed-", builder: "the builder of its image seeds" },
  { prefix: "init-bake-", builder: "the builder of its init layers" },
] as const;

const takenForBuilder = (machine: Identity): Invalid | undefined => {
  const native = nativeName(machine);
  const taken = builderPrefixes.find(({ prefix }) => native.startsWith(prefix));

  return taken === undefined
    ? undefined
    : new Invalid({
        message: `a smolvm host makes no machine named ${machine.name}: smolvm takes a VM whose name begins ${taken.prefix} for ${taken.builder}, and deletes it once it is 30 minutes old`,
      });
};

const seedCaller = (name: string): number | undefined => {
  const pid = Number(seedBuilder.exec(name)?.groups?.["pid"]);

  return pid < pidLimit ? pid : undefined;
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

// smolvm pauses a machine only when asked to, or from its `serve` daemon's memory guard, and a host
// does neither, so a machine reads `paused` or `pausing` only where something else paused it:
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/api/memory_pressure.rs#L268
export const stateOf = (state: RecordState): MachineState =>
  alive.has(state) ? "running" : "stopped";

/**
 * A VM as `observe` tells it: one smolvm reads unreachable, its VM manager alive but its agent not
 * answering, is stopped, as nothing runs in it for its owner and its start boots it afresh:
 * https://github.com/smol-machines/smolvm/blob/v1.34.1/src/config.rs#L52-L60
 */
const sightingOf = (recorded: RecordState | "missing"): Sighting => {
  if (recorded === "missing") {
    return { state: "missing" };
  }

  return recorded === "unreachable"
    ? {
        state: "stopped",
        why: "smolvm reads its VM unreachable: its VM manager runs, but the agent in it doesn't answer",
      }
    : { state: stateOf(recorded) };
};

const leftBehind = (
  what: string,
  work: Effect.Effect<void, Internal>
): Effect.Effect<void> =>
  work.pipe(
    Effect.catch((error) => Effect.logWarning(`${what}: ${error.message}`))
  );

const given = (flag: string, size: number | undefined) =>
  size === undefined ? [] : [flag, String(size)];

export const make = (
  settings: Settings,
  { uid, ended }: Pick<Facts, "uid" | "ended">
): Effect.Effect<
  Interface,
  HostError | CannotStart,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | PortProbe
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const probe = yield* PortProbe;
    const layerScope = yield* Effect.scope;
    const traits = traitsOn(settings.arch);
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

    const observe = (machines: readonly Target[]) =>
      observeEach(machines, (machine) =>
        Effect.map(status(machine.handle), sightingOf)
      );

    // What admission counts: a VM smolvm reads unreachable `observe` tells stopped, as nothing runs
    // in it for its owner, but its VM manager still holds its RAM:
    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/config.rs#L52-L60
    const holdingRam = (machines: readonly Target[]) =>
      observeEach(machines, (machine) =>
        Effect.map(state(machine.handle), (seen): Sighting => ({ state: seen }))
      );

    const copyable = (machine: Target) =>
      Effect.flatMap(
        status(machine.handle),
        (recorded): Effect.Effect<"running" | "stopped", StateError> => {
          if (recorded === "running") {
            return Effect.succeed("running");
          }

          if (recorded === "missing") {
            return Effect.fail(missing(traits.runtime, machine));
          }

          if (!alive.has(recorded)) {
            return Effect.succeed("stopped");
          }

          const message =
            recorded === "unreachable"
              ? `smolvm reads machine ${machine.name} unreachable: its VM runs, but its agent doesn't answer; start it to boot it again`
              : `smolvm reads machine ${machine.name} ${recorded}, and copies only a running or stopped machine`;

          return Effect.fail(
            new WrongState({ message, machine: machine.name, state: recorded })
          );
        }
      );

    const storedAt = (native: string) =>
      path.join(paths.store, `${native}${checkpointSuffix}`);

    const captureRam = (machine: Target, store: string, output: string) => {
      const native = machine.handle;

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

    const halt = (native: string) =>
      Effect.uninterruptible(
        call(
          ["machine", "stop", "--name", native],
          `machine stop ${native}`
        ).pipe(Effect.catch((error) => exited(native, error)))
      );

    const stopped = (native: string, recorded: RecordState | "missing") =>
      Effect.gen(function* () {
        if (recorded === "missing" || !alive.has(recorded)) {
          return;
        }

        yield* halt(native);
      });

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

    const removeSeedBuilds = (
      vms: ReadonlyArray<{ readonly name: string }>,
      left: (pid: number) => Effect.Effect<boolean>
    ) =>
      Effect.forEach(
        vms,
        ({ name }) =>
          Effect.gen(function* () {
            const pid = seedCaller(name);

            if (pid !== undefined && (yield* left(pid))) {
              yield* Effect.logWarning(
                `removing ${name}, an image seed build that a smolvm call cut short left behind`
              );
              yield* leftBehind(`remove ${name}`, removeNative(name));
            }
          }),
        { discard: true }
      );

    const boot = (native: string) =>
      call(
        ["machine", "start", "--name", native, "--branchable"],
        `machine start ${native}`
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : leftBehind(
                "remove the image seed builds smolvm left behind",
                Effect.flatMap(listed, (vms) => removeSeedBuilds(vms, ended))
              )
        )
      );

    // A stopped machine is copied as a pack, which smolvm makes in a helper VM of its own that
    // reads a copy-on-write view of the machine's storage disk, so the machine itself never boots
    // and smolvm never reads it running:
    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/pack.rs#L1075-L1094
    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/pack_export.rs#L406-L445
    // The pack holds the container's root filesystem, the image's layers flattened under what the
    // guest wrote, and with --include-workspace its /workspace; the rest of the storage disk,
    // smolvm's layer cache and volumes, stays behind. It copies the whole disk rather than sharing
    // it, so a stopped machine's copy takes longer than a running one's.
    // The helper takes up to 4G of the host's RAM for the length of the pack:
    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/pack_export.rs#L326-L355
    const packed = (machine: Target, directory: string) =>
      Effect.gen(function* () {
        const stub = path.join(directory, packStub);

        yield* files(
          `couldn't create ${directory}`,
          fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
        );
        yield* call(
          [
            "pack",
            "create",
            "--from-vm",
            machine.handle,
            "--include-workspace",
            "-o",
            stub,
          ],
          `pack create ${machine.handle}`
        );
        yield* removeAll(stub);

        return `${stub}${packSuffix}`;
      });

    // A create from a pack takes the sizes, network and ports a create from an image does, the
    // pack's own sizes only its defaults:
    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/machine_spec.rs#L960-L1038
    const unpacked = (
      native: string,
      pack: string,
      machine: Sizes,
      port: number
    ) =>
      Effect.andThen(
        call(
          [
            "machine",
            "create",
            "--name",
            native,
            "--from",
            pack,
            "--cpus",
            String(machine.cpu),
            "--mem",
            String(machine.ramMib),
            "--net",
            "--net-backend",
            "virtio-net",
            "-p",
            forwarded(port),
            "--storage",
            String(machine.diskGib),
          ],
          `machine create ${native}`
        ),
        boot(native)
      );

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
                (ran): Effect.Effect<void, Internal | Unsizable> => {
                  if (
                    ran.exitCode !== 0 &&
                    ran.stderr.includes(apertureRefusal)
                  ) {
                    return Effect.fail(
                      new Unsizable({
                        message: `smolvm grows a running machine's RAM only within ${formatMib(ramGrowthMib)} above the RAM it booted with, or less on a host whose guests address less memory, and this one would grow to ${formatMib(size)}: stop it to give it more`,
                      })
                    );
                  }

                  return size === had &&
                    ran.exitCode !== 0 &&
                    ran.stderr.includes(unfinishedRefusal)
                    ? Effect.void
                    : Effect.asVoid(
                        expect(ran, `smolvm machine resize ${native}`)
                      );
                }
              ),
        { discard: true }
      );
    };

    const sizable = (
      machine: Pick<MachineRef, "name">,
      from: Sizes,
      to: Sizes,
      live: boolean
    ) => {
      const refusal = live
        ? liveGrowthRefusal(traits, machine.name, from, to)
        : undefined;

      return refusal === undefined ? Effect.void : Effect.fail(refusal);
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

    const rebootedFrom = (
      from: string,
      source: Sizes,
      machine: Identity & Sizes,
      port: number
    ) =>
      Effect.gen(function* () {
        const native = nativeName(machine);

        yield* createdFrom(native, from, [forwarded(port)]);
        yield* boot(native);
        yield* halt(native);
        yield* updated(native, changes(source, machine));
        yield* boot(native);
      });

    const stored = (native: string) =>
      files(`couldn't check ${storedAt(native)}`, fs.exists(storedAt(native)));

    const retire = (base: string) =>
      Effect.gen(function* () {
        yield* removeNative(freezerOf(base));

        if ((yield* status(base)) === "missing") {
          return;
        }

        const ran = yield* smolvm(
          ["machine", "delete", "--name", base, "--force"],
          `machine delete ${base}`
        );

        if (ran.exitCode !== 0 && ran.stderr.includes(pinnedRefusal)) {
          return;
        }

        if (ran.exitCode !== 0) {
          return yield* failure(`smolvm machine delete ${base}`, ran);
        }

        yield* Effect.ignore(
          systemctl(
            ["reset-failed", scopeName(base)],
            `reset-failed ${scopeName(base)}`
          )
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`retire ${base}: ${error.message}`)
        )
      );

    const retireBases = Effect.flatMap(listed, (vms) =>
      Effect.forEach(
        new Set(vms.flatMap(({ name }) => baseOf(name) ?? [])),
        retire,
        { discard: true }
      )
    );

    const orphaned = (parent: string) => {
      const base = baseOf(parent);

      return base === undefined ? Effect.void : retire(base);
    };

    const objects = path.join(paths.store, "objects");

    const prune = Effect.gen(function* () {
      // https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-checkpoint/src/store.rs#L1666
      if (yield* files(`couldn't check ${objects}`, fs.exists(objects))) {
        yield* call(
          ["machine", "checkpoint-prune", "--store", paths.store],
          "machine checkpoint-prune"
        );
      }
    });

    const settle = Effect.andThen(retireBases, prune).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`retire the parked bases: ${error.message}`)
      )
    );

    const heldMib = Effect.gen(function* () {
      const held = (yield* listed).flatMap(({ name }) =>
        baseOf(name) === undefined && seedCaller(name) === undefined
          ? []
          : [scopeName(name)]
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

    const execIn = Effect.fn("Smolvm.exec")(function* (
      machine: Target,
      { argv, stdin, user }: Command
    ) {
      const native = machine.handle;
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
    });

    const created = (machine: Identity & Sizes, image: string, port: number) =>
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
            forwarded(port),
            "--storage",
            String(machine.diskGib),
          ],
          `machine create ${native}`
        );

        yield* boot(native);
      });

    const restored = (
      checkpoint: Target & Sizes,
      machine: Identity & Sizes,
      port: number
    ) =>
      Effect.gen(function* () {
        const native = nativeName(machine);

        const pack = path.join(
          storedAt(checkpoint.handle),
          `${packStub}${packSuffix}`
        );

        yield* (yield* files(`couldn't check ${pack}`, fs.exists(pack)))
          ? unpacked(native, pack, machine, port)
          : rebootedFrom(
              storedAt(checkpoint.handle),
              checkpoint,
              machine,
              port
            );
      });

    const forked = (
      source: Target & Sizes,
      machine: Identity & Sizes,
      port: number
    ) => {
      const native = nativeName(machine);
      const store = path.join(paths.forks, native);

      return Effect.flatMap(copyable(source), (held) => {
        if (held === "stopped") {
          return Effect.flatMap(packed(source, store), (pack) =>
            unpacked(native, pack, machine, port)
          );
        }

        const output = path.join(store, `${native}${checkpointSuffix}`);

        return Effect.andThen(
          captureRam(source, store, output),
          rebootedFrom(output, source, machine, port)
        );
      }).pipe(
        Effect.ensuring(
          removeAll(store).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`fork ${machine.name}: ${error.message}`)
            )
          )
        )
      );
    };

    const local: CheckpointFiles = {
      checkpointFiles: Effect.fn("Smolvm.checkpointFiles")((checkpoint) =>
        Effect.map(regularFiles(fs, storedAt(checkpoint.handle)), (found) =>
          found.flatMap((file) => {
            const object = storedObject(file);

            return file === captureOwner
              ? []
              : [
                  {
                    path: file,
                    file: path.join(storedAt(checkpoint.handle), file),
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
          yield* files(
            `couldn't create ${objects}`,
            fs.makeDirectory(objects, { recursive: true, mode: 0o700 })
          );

          // Prune removes every store object with one link:
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

          const handle = nativeName(checkpoint);

          yield* files(
            `couldn't install checkpoint ${checkpoint.name}`,
            fs.rename(staged, storedAt(handle))
          );

          return handle;
        })
      ),
    };

    return {
      version,
      pin,
      prepares: "with-setup",
      reach: { _tag: "published", address: settings.publishAddress },
      admission: {
        admit: Effect.fn("Smolvm.admit")((activation) =>
          Effect.andThen(
            checkPort(probe, settings.publishAddress, activation),
            Effect.flatMap(heldMib, (held) =>
              checkRamBudget(
                settings.ramBudgetMib,
                activation,
                holdingRam,
                held
              )
            )
          )
        ),
      },
      builds:
        settings.bucket === undefined
          ? unshared(traits.runtime)
          : yield* throughBucket(settings.bucket, local),
      traits,
      guest: "debian",
      kernel: "own",
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

        yield* leftBehind(
          "remove the image seed builds smolvm calls cut short left behind",
          Effect.flatMap(listed, (vms) => removeSeedBuilds(vms, ended))
        );
        yield* Effect.forkIn(settle, layerScope);
      }),
      find: Effect.fn("Smolvm.find")((machine) => {
        const handle = nativeName(machine);

        return Effect.map(status(handle), (recorded) =>
          recorded === "missing" ? undefined : handle
        );
      }),
      checkpointHandle: nativeName,
      observe: Effect.fn("Smolvm.observe")(observe),
      capacity: Effect.fn("Smolvm.capacity")((machines) =>
        Effect.map(inUse(machines, holdingRam), ({ running, unread }) =>
          allotted(running, unread, settings.ramBudgetMib)
        )
      ),
      capture: Effect.fn("Smolvm.capture")(function* (machine, checkpoint) {
        const handle = nativeName(checkpoint);

        yield* (yield* copyable(machine)) === "running"
          ? Effect.asVoid(captureRam(machine, paths.store, storedAt(handle)))
          : Effect.asVoid(packed(machine, storedAt(handle))).pipe(
              Effect.onError(() =>
                leftBehind(
                  `remove what capture ${checkpoint.name} left`,
                  removeAll(storedAt(handle))
                )
              )
            );

        return handle;
      }),
      make: Effect.fn("Smolvm.make")(function* (machine, origin, port) {
        const taken = takenForBuilder(machine);

        if (taken !== undefined) {
          return yield* taken;
        }

        yield* Match.valueTags(origin, {
          image: ({ image }) => created(machine, image, port),
          checkpoint: ({ checkpoint }) =>
            Effect.flatMap(
              stored(checkpoint.handle),
              (held): Effect.Effect<void, Internal | Missing | Unsizable> =>
                held
                  ? restored(checkpoint, machine, port)
                  : Effect.fail(missingCheckpoint(traits.runtime, checkpoint))
            ),
          machine: (source) => forked(source.machine, machine, port),
        });

        return {
          handle: nativeName(machine),
          sizes: {
            cpu: machine.cpu,
            ramMib: machine.ramMib,
            diskGib: machine.diskGib,
          },
        };
      }),
      deleteCheckpoint: Effect.fn("Smolvm.deleteCheckpoint")((checkpoint) =>
        Effect.andThen(removeAll(storedAt(checkpoint.handle)), prune)
      ),
      start: Effect.fn("Smolvm.start")((machine) =>
        Effect.gen(function* () {
          const native = machine.handle;
          const recorded = yield* status(native);

          if (recorded === "running") {
            return;
          }

          if (recorded === "missing") {
            return yield* missing(traits.runtime, machine);
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
        Effect.flatMap(status(machine.handle), (recorded) =>
          stopped(machine.handle, recorded)
        )
      ),
      sizable,
      resize: Effect.fn("Smolvm.resize")((machine, to, running) =>
        running
          ? grown(machine.handle, machine, to)
          : updated(machine.handle, to)
      ),
      sizes: Effect.fn("Smolvm.sizes")((machine) => {
        const native = machine.handle;

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
          const native = machine.handle;

          if (native === undefined) {
            return;
          }

          const found = yield* recordOf(native);

          if (found === "missing") {
            return yield* retireBases.pipe(
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
      exec: execIn,
    } satisfies Interface;
  });

export const layer = (
  settings: typeof SmolvmSettings.Type,
  config: Pick<HostSettings, "stateDir" | "listen">,
  lock = boxLock
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Box
  | PortProbe
> =>
  Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const box = yield* Box;

      yield* aloneOnBox(lock);

      return yield* make(
        {
          prefix: settings.prefix,
          publishAddress: config.listen.address,
          ramBudgetMib: ramBudget(
            settings.ramBudgetMib,
            Math.floor(totalmem() / mib)
          ),
          stateDir: config.stateDir,
          arch: process.arch,
          bucket:
            settings.builds === undefined
              ? undefined
              : yield* S3.make(settings.builds),
        },
        box
      );
    })
  );
