/**
 * The smolvm runtime: Linux guests through the smolvm CLI of a versioned install prefix, on a
 * host that runs as root. smolvm's exit codes are trusted: `machine start` returns once the
 * agent answers, `stop` once the VM is dead, and nothing polls around them. Every call runs
 * with the same environment, the one the spikes ran smolvm in.
 */
import { join } from "node:path";
import { type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Layer, type PlatformError, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { HostConfig } from "./config.ts";
import { lastLines } from "./guest.ts";
import { checkRamBudget } from "./ram-budget.ts";
import {
  type Interface,
  type MachineRef,
  type MachineState,
  type Observed,
  Runtime,
} from "./runtime.ts";

/**
 * The smolvm release this host was tested on. Another release is refused at startup: a bump
 * re-checks smolvm's claims (evidence.md) before this changes.
 */
export const testedVersion = "1.22.2";

/** What the runtime needs from the host config. */
export interface Settings {
  /** The versioned install prefix. */
  readonly prefix: string;
  /** Where guest port 22 is published (`SMOLVM_PUBLISH_ADDR`). */
  readonly publishAddress: string;
  readonly ramBudgetMib: number;
  /** The host's one inventory (`SMOLVM_DATA_DIR`). */
  readonly dataDir: string;
}

/** The inventory lives in the host's state dir, so it is the host's alone. */
const dataDirIn = (stateDir: string): string => join(stateDir, "smolvm");

/** A machine's smolvm name: its name and the first 8 characters of its row's instance. */
export const nativeName = (machine: Pick<MachineRef, "name" | "instance">): string =>
  `${machine.name}-${machine.instance.slice(0, 8)}`;

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
 * `/dev/shm/smolvm-restore` behind, at no cost (rewrite.md, Guest access). `NO_COLOR` keeps
 * ANSI colours out of smolvm's log lines, which errors carry: its tracing-subscriber 0.3.23
 * colours them even into a pipe unless `NO_COLOR` is set (tracing-subscriber
 * src/fmt/fmt_layer.rs:739-743). `SMOLVM_BOOT_BINARY` is never set: it arms a parent-death
 * watchdog.
 */
export const environment = (settings: Settings) => ({
  PATH: searchPath,
  HOME: settings.dataDir,
  SMOLVM_DATA_DIR: settings.dataDir,
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

export const stateOf = (state: RecordState): MachineState =>
  alive.has(state) ? "running" : "stopped";

/**
 * A spawn failure, without the command line: an exec's arguments carry the preparation
 * script, which nothing logs.
 */
const describe = (error: PlatformError.PlatformError): string =>
  `${error.reason._tag}: ${error.reason.method}${error.reason.description === undefined ? "" : `: ${error.reason.description}`}`;

/** A finished CLI call. */
interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const make = (
  settings: Settings,
  uid: number | undefined,
): Effect.Effect<
  Interface,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const binary = join(settings.prefix, "smolvm");
    const env = environment(settings);

    const command = (file: string, args: ReadonlyArray<string>, stdin: ChildProcess.CommandInput) =>
      ChildProcess.make(file, args, { env, extendEnv: false, stdin });

    /** Runs a CLI call to its end; `what` names it in errors. */
    const run = (file: string, args: ReadonlyArray<string>, what: string) =>
      Effect.scoped(
        Effect.flatMap(spawner.spawn(command(file, args, "ignore")), (handle) =>
          Effect.all(
            {
              exitCode: handle.exitCode,
              stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
              stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
            },
            { concurrency: "unbounded" },
          ),
        ),
      ).pipe(Effect.mapError((error) => new Internal({ message: `${what}: ${describe(error)}` })));

    const smolvm = (args: ReadonlyArray<string>, what: string) =>
      run(binary, args, `smolvm ${what}`);

    const failure = (what: string, ran: Ran) =>
      new Internal({ message: `${what} exited ${ran.exitCode}: ${lastLines(ran.stderr)}` });

    const succeeded = (what: string) => (ran: Ran) =>
      ran.exitCode === 0 ? Effect.succeed(ran) : Effect.fail(failure(what, ran));

    const call = (args: ReadonlyArray<string>, what: string) =>
      Effect.flatMap(smolvm(args, what), succeeded(`smolvm ${what}`));

    const systemctl = (args: ReadonlyArray<string>, what: string) =>
      Effect.flatMap(run("systemctl", args, `systemctl ${what}`), succeeded(`systemctl ${what}`));

    if (uid !== 0) {
      return yield* new Precondition({
        message: `a smolvm host runs as root, and this one runs as uid ${uid ?? "unknown"}`,
      });
    }

    const socket = controlSocket(settings.dataDir);

    if (Buffer.byteLength(socket) > socketPathMax) {
      return yield* new Precondition({
        message: `smolvm's sockets under ${settings.dataDir} would need ${Buffer.byteLength(socket)} bytes, past Linux's ${socketPathMax}: use a shorter state dir`,
      });
    }

    for (const template of templates) {
      const file = join(settings.prefix, template);

      const present = yield* fs
        .exists(file)
        .pipe(
          Effect.mapError(
            (error) => new Internal({ message: `couldn't check ${file}: ${describe(error)}` }),
          ),
        );

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

    /** A machine's state, or `missing` for a name smolvm doesn't know. */
    const state = (native: string): Effect.Effect<MachineState, Internal> =>
      Effect.flatMap(
        smolvm(["machine", "status", "--name", native, "--json"], `machine status ${native}`),
        (ran) => {
          if (ran.exitCode === 0) {
            return decodeStatus(ran.stdout).pipe(
              Effect.map(({ state }) => stateOf(state)),
              Effect.mapError(
                (error) =>
                  new Internal({
                    message: `smolvm machine status ${native} answered something unexpected: ${error.message}`,
                  }),
              ),
            );
          }

          return ran.stderr.includes(`machine '${native}' not found`)
            ? Effect.succeed("missing")
            : Effect.fail(failure(`smolvm machine status ${native}`, ran));
        },
      );

    const observe = (machine: MachineRef): Effect.Effect<Observed, HostError> =>
      Effect.map(state(nativeName(machine)), (observed) =>
        observed === "missing" || machine.port === undefined
          ? { state: observed }
          : { state: observed, ssh: { host: settings.publishAddress, port: machine.port } },
      );

    /** Every machine starts branchable: store capture needs it. */
    const boot = (native: string) =>
      call(["machine", "start", "--name", native, "--branchable"], `machine start ${native}`);

    return {
      name: "smolvm",
      version: testedVersion,
      publishAddress: settings.publishAddress,
      startup: Effect.void,
      observe,
      admit: (activation) => checkRamBudget(settings.ramBudgetMib, activation, observe),
      create: (machine, image) =>
        Effect.gen(function* () {
          const native = nativeName(machine);

          if (machine.port === undefined) {
            return yield* new Internal({ message: `machine ${machine.id} has no host port` });
          }

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
      start: (machine) => Effect.asVoid(boot(nativeName(machine))),
      stop: (machine) => {
        const native = nativeName(machine);

        return Effect.asVoid(call(["machine", "stop", "--name", native], `machine stop ${native}`));
      },
      delete: (machine) =>
        Effect.gen(function* () {
          const native = nativeName(machine);
          const scope = scopeName(native);
          const observed = yield* state(native);

          if (observed === "missing") {
            return;
          }

          let killed = false;

          if (observed === "running") {
            const stopped = yield* smolvm(
              ["machine", "stop", "--name", native],
              `machine stop ${native}`,
            );

            if (stopped.exitCode !== 0) {
              yield* Effect.logWarning(
                `delete ${machine.id}: ${failure(`smolvm machine stop ${native}`, stopped).message}; killing ${scope}`,
              );
              yield* systemctl(["kill", "--signal=SIGKILL", scope], `kill ${scope}`);
              killed = true;
            }
          }

          yield* call(
            ["machine", "delete", "--name", native, "--force"],
            `machine delete ${native}`,
          );

          if (killed) {
            yield* Effect.ignore(systemctl(["reset-failed", scope], `reset-failed ${scope}`));
          }
        }),
      exec: (machine, { argv, stdin }) =>
        Effect.gen(function* () {
          const native = nativeName(machine);
          const what = `smolvm machine exec ${native}`;

          const failed = (error: PlatformError.PlatformError) =>
            new Internal({ message: `${what}: ${describe(error)}` });

          const handle = yield* spawner
            .spawn(
              command(
                binary,
                ["machine", "exec", "--name", native, "-i", "--", ...argv],
                stdin === undefined ? "ignore" : Stream.make(stdin),
              ),
            )
            .pipe(Effect.mapError(failed));

          return {
            output: Stream.mapError(handle.all, failed),
            exitCode: Effect.mapError(handle.exitCode, failed),
          };
        }),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostConfig, "stateDir" | "smolvm">,
): Layer.Layer<
  Runtime,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(
    Runtime,
    make({ ...config.smolvm, dataDir: dataDirIn(config.stateDir) }, process.getuid?.()),
  );
