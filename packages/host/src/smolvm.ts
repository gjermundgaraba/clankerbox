/**
 * The smolvm runtime: Linux guests through the smolvm CLI of a versioned install prefix, on a
 * host that runs as root. smolvm's exit codes are trusted: `machine start` returns once the
 * agent answers, `stop` once the VM is dead, and nothing polls around them. Every call runs
 * with the same environment, `environment()`; the bump-smolvm skill holds the claims behind it.
 *
 * A checkpoint is always `ram`: a running machine's RAM and disks, as a store checkpoint in the
 * host's one store. A fork is such a checkpoint into a store of its own, restored, then the
 * store is removed whole. `machine branch` is never called: each branch adds a backing layer to
 * its source, and smolvm refuses the 33rd.
 */
import { join } from "node:path";
import { type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { cliIn, expect, failure, files, portOf } from "./cli.ts";
import type { Smolvm, SmolvmHost } from "./config.ts";
import { checkRamBudget } from "./ram-budget.ts";
import {
  type CheckpointRef,
  type Interface,
  machineReadWait,
  type MachineRef,
  type MachineState,
  missing,
  type Observed,
  Refusal,
  Runtime,
  timeoutFail,
} from "./runtime.ts";

/**
 * The smolvm release this host was tested on. Another release is refused at startup: a bump
 * re-checks smolvm's claims (the bump-smolvm skill) before this changes.
 */
export const testedVersion = "1.22.2";

/** What the runtime needs: the host config's smolvm settings, and the host's state dir. */
export interface Settings extends Smolvm {
  readonly stateDir: string;
}

/**
 * Where the runtime keeps its files, all in the host's state dir, so they are the host's alone:
 * the one inventory (`SMOLVM_DATA_DIR`), the one checkpoint store, and each fork's own store
 * while the fork runs.
 */
export const pathsIn = (stateDir: string) => ({
  dataDir: join(stateDir, "smolvm"),
  store: join(stateDir, "checkpoints"),
  forks: join(stateDir, "forks"),
});

/**
 * The pin a `ram` checkpoint records: the smolvm release and the platform. smolvm checks sizes,
 * platform, CPU contract and network at restore, but not the engine build or the agent, so a
 * RAM state is restored only under the release that saved it.
 */
export const pin = `smolvm ${testedVersion} ${process.platform}-${process.arch}`;

/**
 * A machine's or checkpoint's smolvm name: its name and the first 8 characters of its row's
 * instance.
 */
export const nativeName = (resource: Pick<MachineRef, "name" | "instance">): string =>
  `${resource.name}-${resource.instance.slice(0, 8)}`;

/**
 * How many `machine status` processes an `observe` runs at once, so a list or a RAM budget check
 * on a host with many machines doesn't start them all together. A machine's wait for its turn
 * counts toward its `machineReadWait`, so a list answers in time however many machines wait.
 */
const observeConcurrency = 8;

/** The systemd scope `SMOLVM_VM_USE_SCOPE=1` puts a VM in (S@1.22.2:src/systemd_scope.rs:151-163). */
const scopeName = (native: string): string => `smolvm-vm-${native}.scope`;

/** The disk templates smolvm would otherwise expand into the prefix on first use, racing itself. */
export const templates = ["storage-template.ext4", "overlay-template.ext4"] as const;

/**
 * Linux's `sun_path` holds 108 bytes, one of them the terminating NUL. smolvm keeps a
 * machine's sockets in a directory named by a 16-hex-digit hash of its name, so the longest
 * path, the control socket, depends only on the data root (S@1.22.2:src/agent/manager.rs:286-306,
 * src/agent/fork.rs:289).
 */
const socketPathMax = 107;

export const controlSocket = (dataDir: string): string =>
  join(dataDir, ".cache", "smolvm", "vms", "0".repeat(16), "control.sock");

/** The wrapper script runs under `/usr/bin/env bash`, and smolvm finds `resize2fs` and `busctl`. */
const searchPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The environment of every smolvm call, and so of every VM job. With `SMOLVM_DATA_DIR` set,
 * smolvm moves `HOME` to the data root anyway (S@1.22.2:src/main.rs:132-136); passing it there
 * keeps the original from being read at all. `SMOLVM_AGENT_ROOTFS` is needed for the same
 * reason. `SMOLVM_RESTORE_TMPFS=0` keeps every root restore from leaving
 * `/dev/shm/smolvm-restore` behind, at no cost (the bump-smolvm skill). `NO_COLOR` keeps
 * ANSI colours out of smolvm's log lines, which errors carry: its tracing-subscriber 0.3.23
 * colours them even into a pipe unless `NO_COLOR` is set (tracing-subscriber
 * src/fmt/fmt_layer.rs:739-743). `SMOLVM_BOOT_BINARY` is never set: it arms a parent-death
 * watchdog.
 */
export const environment = (settings: Settings) => ({
  PATH: searchPath,
  HOME: pathsIn(settings.stateDir).dataDir,
  SMOLVM_DATA_DIR: pathsIn(settings.stateDir).dataDir,
  SMOLVM_AGENT_ROOTFS: join(settings.prefix, ".local", "share", "smolvm", "agent-rootfs"),
  SMOLVM_RESTORE_TMPFS: "0",
  SMOLVM_VM_USE_SCOPE: "1",
  SMOLVM_PUBLISH_ADDR: settings.publishAddress,
  SMOLVM_EGRESS_FLOOR: "strict",
  NO_COLOR: "1",
});

/** Every state `machine status --json` reports (S@1.22.2:src/config.rs:36-80). */
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

/**
 * The states whose VMM process is alive and holds its RAM. `stop` ends each of them: smolvm
 * kills an unreachable agent's VMM itself. The others boot again with `start`.
 */
const alive: ReadonlySet<RecordState> = new Set(["running", "pausing", "unreachable", "frozen"]);

/**
 * The states `machine start` refuses: a frozen fork base, and a machine with saved execution,
 * which only smolvm's resume continues (`start_vm_named_with_db`, S@1.22.2:src/cli/vm_common.rs).
 */
const unstartable: ReadonlySet<RecordState> = new Set(["frozen", "pausing", "paused"]);

export const stateOf = (state: RecordState): MachineState =>
  alive.has(state) ? "running" : "stopped";

export const make = (
  settings: Settings,
  uid: number | undefined,
): Effect.Effect<
  Interface,
  HostError,
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
      return yield* new Precondition({
        message: `a smolvm host runs as root, and this one runs as uid ${uid ?? "unknown"}`,
      });
    }

    const socket = controlSocket(paths.dataDir);

    if (Buffer.byteLength(socket) > socketPathMax) {
      return yield* new Precondition({
        message: `smolvm's sockets under ${paths.dataDir} would need ${Buffer.byteLength(socket)} bytes, past Linux's ${socketPathMax}: use a shorter state dir`,
      });
    }

    for (const template of templates) {
      const file = join(settings.prefix, template);

      const present = yield* files(`couldn't check ${file}`, fs.exists(file));

      if (!present) {
        return yield* new Precondition({
          message: `smolvm prefix ${settings.prefix} has no ${template}: expand it at install with zstd -d --sparse ${file}.zst -o ${file}`,
        });
      }
    }

    const reported = (yield* call(["--version"], "--version")).stdout.trim();

    if (reported !== `smolvm ${testedVersion}`) {
      return yield* new Precondition({
        message: `${binary} reports "${reported}", and this host was tested on smolvm ${testedVersion}`,
      });
    }

    /** A machine's state as smolvm records it, or `missing` for a name smolvm doesn't know. */
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

    /** A machine's state, or `missing` for a name smolvm doesn't know. */
    const state = (native: string): Effect.Effect<MachineState, Internal> =>
      Effect.map(status(native), (recorded) =>
        recorded === "missing" ? recorded : stateOf(recorded),
      );

    /**
     * Each machine's state, read `observeConcurrency` at a time; `unknown` when smolvm can't
     * read it, or doesn't answer within `machineReadWait` of the observe's start, so one hung
     * status makes only its own machine `unknown`, within the core's `stateReadWait`.
     */
    const observe = (machines: ReadonlyArray<MachineRef>) =>
      Effect.flatMap(Semaphore.make(observeConcurrency), (turns) =>
        Effect.forEach(
          machines,
          (machine): Effect.Effect<Observed> =>
            turns
              .withPermits(1)(state(nativeName(machine)))
              .pipe(
                timeoutFail(
                  machineReadWait,
                  () =>
                    new Internal({
                      message: `smolvm machine status ${nativeName(machine)} didn't answer within ${Duration.format(machineReadWait)}`,
                    }),
                ),
                Effect.map((observed): Observed => ({ state: observed })),
                Effect.catch((error) =>
                  Effect.as(
                    Effect.logWarning(`couldn't read ${machine.id}'s state: ${error.message}`),
                    { state: "unknown" } satisfies Observed,
                  ),
                ),
              ),
          { concurrency: "unbounded" },
        ),
      );

    /** Every machine starts branchable: store capture needs it. */
    const boot = (native: string) =>
      call(["machine", "start", "--name", native, "--branchable"], `machine start ${native}`);

    /**
     * A fork and a capture copy RAM, which only a running machine has, and read it through its
     * agent, so an unreachable one is no source. Any other state is refused before anything
     * native.
     */
    const copyable = (machine: MachineRef, stopped: string) =>
      Effect.flatMap(status(nativeName(machine)), (recorded) => {
        if (recorded === "running") {
          return Effect.void;
        }

        if (recorded === "missing") {
          return Effect.fail(missing("smolvm", machine));
        }

        const message =
          recorded === "unreachable"
            ? `smolvm reads machine ${machine.id} unreachable: its VM runs, but its agent doesn't answer; start it to boot it again`
            : alive.has(recorded) || unstartable.has(recorded)
              ? `smolvm reads machine ${machine.id} ${recorded}, and copies only a running machine`
              : stopped;

        return Effect.fail(new Refusal({ error: new Precondition({ message }) }));
      });

    /** A checkpoint's directory in the host's store. */
    const checkpointDir = (checkpoint: CheckpointRef) =>
      join(paths.store, `${nativeName(checkpoint)}.checkpoint`);

    /**
     * Captures a running machine's RAM and disks into `store`, with no history: smolvm would
     * otherwise keep 32 generations, and deleting an older checkpoint would free nothing.
     */
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

    /**
     * Removes the machine's VM, coping with whatever an earlier failure left, the one delete path
     * for every machine. It reads status first and touches nothing for a name smolvm doesn't
     * know: a stop of an unknown name leaks an empty `vms/<hash>/`. A running VM is stopped
     * gracefully. A scope still loaded then holds a VMM that `machine delete` would leave
     * running, on the machine's port and outside the RAM budget: one whose stop failed, or one
     * whose boot was cut short, as by a host killed mid-boot, before smolvm recorded its pid, so
     * that smolvm reads it as stopped (seen live; the bump-smolvm skill). It is killed with the
     * signal smolvm's own `kill_scope` uses, and reset once the machine is deleted.
     */
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
            ["machine", "stop", "--name", native],
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

    /**
     * Makes `machine` from a checkpoint, moves the source's port to its own, and boots it.
     * smolvm refuses topology flags at a create from a live checkpoint and keeps its port, so
     * the port is swapped before the first start. A VM made but not moved sits on the source's
     * port, and `machine start` never moves it; whatever fails here leaves the machine unmade,
     * which the core never starts again, so it never publishes there, and delete removes it.
     * The restore cache is off: it survives every smolvm command, and a fork restores each
     * checkpoint once.
     */
    const restoreRam = (from: string, sourcePort: number | undefined, machine: MachineRef) =>
      Effect.gen(function* () {
        const native = nativeName(machine);
        const port = yield* portOf(machine);

        yield* call(
          ["machine", "create", "--name", native, "--from", from, "--restore-cache-entries", "0"],
          `machine create ${native}`,
        );

        // A source deleted before the restore can leave its port to the new machine.
        if (sourcePort !== port) {
          if (sourcePort === undefined) {
            return yield* new Internal({ message: `the checkpoint of ${machine.id} has no port` });
          }

          yield* call(
            [
              "machine",
              "update",
              "--name",
              native,
              "--remove-port",
              `${sourcePort}:22`,
              "-p",
              `${port}:22`,
            ],
            `machine update ${native}`,
          );
        }

        yield* boot(native);
      });

    return {
      name: "smolvm",
      version: testedVersion,
      publishAddress: settings.publishAddress,
      pin,
      // Nothing is in flight at startup, so no fork's store is still needed.
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
      checkpointKind: "ram",
      admit: Effect.fn("Smolvm.admit")((activation) =>
        checkRamBudget(settings.ramBudgetMib, activation, observe),
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
        restoreRam(checkpointDir(checkpoint), checkpoint.port, machine),
      ),
      fork: Effect.fn("Smolvm.fork")((source, machine) => {
        const store = join(paths.forks, nativeName(machine));
        const output = join(store, `${nativeName(machine)}.checkpoint`);

        // Restored machines hold no reference into the store, so it goes whole, however the
        // fork ended.
        return Effect.andThen(
          copyable(
            source,
            `a fork copies a running machine, RAM included, and ${source.id} is stopped: start it first`,
          ),
          Effect.andThen(
            captureRam(source, store, output),
            restoreRam(output, source.port, machine),
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

        // Removing the directory drops the checkpoint's references; the prune frees what no
        // other checkpoint shares, and staging that an interrupted capture left. A store that no
        // capture has written yet has nothing to prune, and smolvm's prune fails on it: it reads
        // `objects/` (S@1.22.2:crates/smolvm-checkpoint/src/store.rs:1317-1319).
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
          const port = yield* portOf(machine);

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
              `${port}:22`,
              "--storage",
              String(machine.diskGib),
            ],
            `machine create ${native}`,
          );

          yield* boot(native);
        }),
      ),
      /**
       * Reads the status first, so a running machine is left as it is. An unreachable one, whose
       * VM runs but whose agent doesn't answer, is booted again: `machine start` kills its VMM
       * first (the bump-smolvm skill).
       */
      start: Effect.fn("Smolvm.start")((machine) =>
        Effect.gen(function* () {
          const native = nativeName(machine);
          const recorded = yield* status(native);

          if (recorded === "running") {
            return;
          }

          if (recorded === "missing") {
            return yield* missing("smolvm", machine);
          }

          if (unstartable.has(recorded)) {
            return yield* new Refusal({
              error: new Precondition({
                message: `smolvm reads machine ${machine.id} ${recorded}, and doesn't start it from there`,
              }),
            });
          }

          yield* boot(native);
        }),
      ),
      /**
       * Reads the state first, and stops only a running machine: a `machine stop` of a name smolvm
       * doesn't know leaks an empty `vms/<hash>/`, as for delete.
       */
      stop: Effect.fn("Smolvm.stop")((machine) =>
        Effect.gen(function* () {
          const native = nativeName(machine);

          if ((yield* state(native)) === "running") {
            yield* call(["machine", "stop", "--name", native], `machine stop ${native}`);
          }
        }),
      ),
      delete: Effect.fn("Smolvm.delete")(removeVm),
      exec: Effect.fn("Smolvm.exec")((machine, { argv, stdin }) => {
        const native = nativeName(machine);

        return exec(
          binary,
          ["machine", "exec", "--name", native, "-i", "--", ...argv],
          stdin,
          `smolvm machine exec ${native}`,
        );
      }),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<SmolvmHost, "stateDir" | "smolvm">,
): Layer.Layer<
  Runtime,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(Runtime, make({ ...config.smolvm, stateDir: config.stateDir }, process.getuid?.()));
