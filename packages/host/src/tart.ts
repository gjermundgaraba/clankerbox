/**
 * The Tart runtime: macOS guests through the `tart` CLI of a versioned install, on a macOS host
 * that runs as the operator's user. Each VM runs as `tart run` under its own launchd job in the
 * user's GUI domain, so a host restart leaves VMs running, and the job references only tart. The
 * host's forwarder carries each running machine's SSH connections into the guest.
 *
 * Tart has one VM namespace per Tart home, shared with the operator's own VMs and with any other
 * host process on the Mac, so native names carry the host ID, the kind and the row's instance.
 * A checkpoint is always `disk`: a clone of a stopped machine. A fork clones a stopped machine,
 * and a restore clones a checkpoint.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Capacity, type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Predicate,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Tart, TartHost } from "./config.ts";
import * as Forwarder from "./forwarder.ts";
import { lastLines } from "./guest.ts";
import {
  bootingActions,
  type CheckpointRef,
  type Interface,
  type MachineRef,
  type MachineState,
  type Observed,
  Runtime,
} from "./runtime.ts";

/**
 * The oldest Tart this host runs on: from 2.40.1 clone refuses an existing destination, delete's
 * exit codes are reliable, one accept error no longer disables `tart exec`, and `tart list` no
 * longer fails on running VMs (evidence.md, Tart claims).
 */
export const minimumVersion = "2.40.1";

/** What the runtime needs: the host config's Tart settings and the host it runs for. */
export interface Settings extends Tart {
  readonly hostId: string;
  readonly stateDir: string;
  /** The user whose GUI domain (`gui/<uid>`) runs the VM jobs; Node has none off POSIX. */
  readonly uid: number | undefined;
  /** The host's own `TART_HOME`, if it has one. Without one Tart uses `~/.tart`. */
  readonly tartHome: string | undefined;
  /**
   * What `tart run` adds for networking. The host blocks the Mac itself with Softnet; `tart
   * run` without it falls back to Tart's shared NAT.
   */
  readonly network: ReadonlyArray<string>;
}

/** Softnet, blocking the Mac itself: guests can't reach the host's services (rewrite.md). */
export const softnet = ["--net-softnet-block=@host"] as const;

/**
 * Two running macOS VMs per Mac is Apple's limit, the operator's own VMs included. Tart reports
 * Apple's refusal of a third with this text (T:VMStorageHelper.swift:146-147).
 */
const vmLimit = 2;

const limitRefusal = "The number of VMs exceeds the system limit";

/**
 * How long a boot may take until `tart exec` answers. Alone, a stock Cirrus image answered
 * 18.5–32.3 s after `tart run` (P3); two booting together answered after about 61 and 93 s
 * (P11), and two is as many as Apple runs at once.
 */
const bootWait = Duration.minutes(3);

/** The pause between `tart exec` probes while a VM boots. */
const probePause = Duration.seconds(1);

/**
 * How long the guest's own `shutdown -h now` may take before Tart's forced stop. Stock Cirrus
 * guests stopped 2.3–7.8 s after it, and 25.6 s for one whose agent was still coming up, as the
 * exec waits for it (phase 5, native).
 */
const shutdownWait = Duration.minutes(1);

/**
 * How long a VM may take to leave `running` after `tart stop --timeout 0`, which SIGKILLs `tart
 * run` (T:Commands/Stop.swift:80-93); the VM's lock goes with the process.
 */
const forcedStopWait = Duration.seconds(10);

/** The pause between `tart list` reads while a VM stops. */
const stopPause = Duration.millis(500);

/**
 * The search path of every tart call and VM job. Tart finds `softnet` (and `sudo`) on it
 * (T:Network/Softnet.swift:86-94, Utils.swift:30-45), and Homebrew installs Softnet in
 * `/opt/homebrew/bin`.
 */
const searchPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The environment of every tart call and every VM job: the same in both, so the job's `tart run`
 * finds the VM the host made, in the host's Tart home.
 */
export const environment = (settings: Pick<Settings, "tartHome">) => ({
  PATH: searchPath,
  HOME: homedir(),
  TART_HOME: settings.tartHome,
});

/** A machine's VM name, which is also its launchd label. */
export const machineName = (host: string, machine: Pick<MachineRef, "name" | "instance">): string =>
  `cbx-${host}-m-${machine.name}-${machine.instance.slice(0, 8)}`;

/** A checkpoint's VM name. */
export const checkpointName = (
  host: string,
  checkpoint: Pick<CheckpointRef, "name" | "instance">,
): string => `cbx-${host}-c-${checkpoint.name}-${checkpoint.instance.slice(0, 8)}`;

/**
 * Where the VM jobs' plists and logs live: in the host's state dir, so nothing loads them at
 * login, and a test host's jobs stay apart from production's.
 */
export const jobsDir = (stateDir: string): string => join(stateDir, "launchd");

/** Tart sizes disks in GB (10^9 bytes, T:VMDirectory.swift:287-301); rounded up from GiB. */
export const diskGb = (diskGib: number): number => Math.ceil((diskGib * 1024 ** 3) / 1e9);

const xml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A VM job's plist: `tart run` for the VM, started only by `kickstart` and never restarted by
 * launchd, with its output in `log`.
 */
export const plist = (job: {
  readonly label: string;
  readonly program: ReadonlyArray<string>;
  /** Variables whose value is `undefined` are left out. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly log: string;
}): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xml(job.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...job.program.map((argument) => `    <string>${xml(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(job.environment).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`],
    ),
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <false/>`,
    `  <key>KeepAlive</key>`,
    `  <false/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(job.log)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(job.log)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");

/** Every state `tart list` reports (T:VMDirectory.swift:6-10). */
const VmState = Schema.Literals(["running", "suspended", "stopped"]);

const decodeList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ Name: Schema.String, State: VmState }))),
);

/** `State` derives from the VM's lock, held by its `tart run`; a suspended VM boots again. */
export const stateOf = (state: typeof VmState.Type): MachineState =>
  state === "running" ? "running" : "stopped";

/** Whether `reported` is at least `minimumVersion`, comparing `major.minor.patch`. */
export const supported = (reported: string): boolean => {
  const parts = (version: string) => version.split(".").map(Number);
  const [have, want] = [parts(reported), parts(minimumVersion)];

  for (const [index, wanted] of want.entries()) {
    const part = have[index] ?? Number.NaN;

    if (Number.isNaN(part)) {
      return false;
    }

    if (part !== wanted) {
      return part > wanted;
    }
  }

  return true;
};

/** A top-level `key = value` line of `launchctl print`; nested lines are indented further. */
const printed = (output: string, key: string): string | undefined =>
  new RegExp(`^\\t${key} = (.+)$`, "mu").exec(output)?.[1];

/** A boot whose guest agent doesn't answer yet. */
class Booting extends Data.TaggedError("Booting")<{}> {}

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
): Effect.Effect<
  Interface,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const env = environment(settings);
    const jobs = jobsDir(settings.stateDir);

    if (settings.uid === undefined) {
      return yield* new Precondition({ message: "a Tart host runs on macOS, as a user" });
    }

    const domain = `gui/${settings.uid}`;
    const forwarder = yield* Forwarder.make(settings.publishAddress);
    const vmOf = (machine: MachineRef) => machineName(settings.hostId, machine);
    const checkpointVm = (checkpoint: CheckpointRef) => checkpointName(settings.hostId, checkpoint);

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

    const failure = (what: string, ran: Ran) =>
      new Internal({ message: `${what} exited ${ran.exitCode}: ${lastLines(ran.stderr)}` });

    /** A call that succeeds with one of the exit codes `ok`. */
    const expect = (ran: Ran, what: string, ok: ReadonlyArray<number> = [0]) =>
      ok.includes(ran.exitCode) ? Effect.succeed(ran) : Effect.fail(failure(what, ran));

    const tart = (args: ReadonlyArray<string>, what: string) =>
      run(settings.binary, args, `tart ${what}`);

    const call = (args: ReadonlyArray<string>, what: string, ok?: ReadonlyArray<number>) =>
      Effect.flatMap(tart(args, what), (ran) => expect(ran, `tart ${what}`, ok));

    const launchctl = (args: ReadonlyArray<string>, what: string) =>
      run("/bin/launchctl", args, `launchctl ${what}`);

    /** A file system call of the runtime's own; `what` names it in errors. */
    const files = <A>(what: string, effect: Effect.Effect<A, PlatformError.PlatformError>) =>
      Effect.mapError(effect, (error) => new Internal({ message: `${what}: ${describe(error)}` }));

    const reported = (yield* call(["--version"], "--version")).stdout.trim();

    if (!supported(reported)) {
      return yield* new Precondition({
        message: `${settings.binary} reports version "${reported}", and this host needs Tart ${minimumVersion} or later`,
      });
    }

    /** Every VM in the Tart home, by name, with its state. */
    const list = Effect.flatMap(
      call(["list", "--source", "local", "--format", "json"], "list"),
      (ran) =>
        decodeList(ran.stdout).pipe(
          Effect.map((vms) => new Map(vms.map((vm) => [vm.Name, stateOf(vm.State)]))),
          Effect.mapError(
            (error) =>
              new Internal({
                message: `tart list answered something unexpected: ${error.message}`,
              }),
          ),
        ),
    );

    const state = (vm: string) => Effect.map(list, (vms) => vms.get(vm) ?? "missing");

    const job = (vm: string) => ({
      target: `${domain}/${vm}`,
      plist: join(jobs, `${vm}.plist`),
      log: join(jobs, `${vm}.log`),
    });

    /** Writes the machine's VM job once, at create; nothing rewrites it. */
    const writeJob = (vm: string) => {
      const { plist: file, log } = job(vm);

      return files(
        `couldn't write ${file}`,
        fs.writeFileString(
          file,
          plist({
            label: vm,
            program: [settings.binary, "run", "--no-graphics", ...settings.network, vm],
            environment: env,
            log,
          }),
          { mode: 0o600 },
        ),
      );
    };

    const portOf = (machine: MachineRef) =>
      machine.port === undefined
        ? Effect.fail(new Internal({ message: `machine ${machine.id} has no host port` }))
        : Effect.succeed(machine.port);

    /** Listens for the machine's SSH connections; each one runs `nc` in the guest. */
    const listen = (machine: MachineRef) =>
      Effect.flatMap(portOf(machine), (port) =>
        forwarder.listen(port, (input) =>
          ChildProcess.make(
            settings.binary,
            ["exec", "-i", vmOf(machine), "nc", "127.0.0.1", "22"],
            { env, extendEnv: false, stdin: input },
          ),
        ),
      );

    const unlisten = (machine: MachineRef) =>
      machine.port === undefined ? Effect.void : forwarder.close(machine.port);

    /**
     * Waits until the VM's guest agent answers `tart exec`. Before `tart run` holds the VM, an
     * exec fails at once; while the guest boots, it blocks, and fails after about 30 s if the
     * agent isn't up yet (P11), so it is tried again. A job that exits instead failed the boot:
     * its log says why, and Apple's refusal of a third VM is `Capacity`.
     */
    const ready = (machine: MachineRef) => {
      const vm = vmOf(machine);
      const { target, log } = job(vm);

      const probe = Effect.gen(function* () {
        if ((yield* tart(["exec", vm, "true"], `exec ${vm}`)).exitCode === 0) {
          return;
        }

        const printedJob = yield* Effect.flatMap(
          launchctl(["print", target], `print ${target}`),
          (ran) => expect(ran, `launchctl print ${target}`),
        );

        if (printed(printedJob.stdout, "state") !== "not running") {
          return yield* new Booting();
        }

        const output = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""));

        if (output.includes(limitRefusal)) {
          return yield* new Capacity({
            message: `Apple's limit of ${vmLimit} running macOS VMs per Mac refused ${machine.id}: ${lastLines(output)}`,
          });
        }

        return yield* new Internal({
          message: `tart run for ${machine.id} exited ${printed(printedJob.stdout, "last exit code") ?? "early"}: ${lastLines(output)}`,
        });
      });

      return probe.pipe(
        Effect.retry({
          while: Predicate.isTagged("Booting"),
          schedule: Schedule.spaced(probePause),
        }),
        Effect.timeoutOption(bootWait),
        Effect.flatMap((answered) =>
          Option.isSome(answered)
            ? Effect.void
            : Effect.fail(
                new Internal({
                  message: `${machine.id}'s guest agent didn't answer tart exec within ${Duration.format(bootWait)} of its start`,
                }),
              ),
        ),
        Effect.catchTag("Booting", () =>
          Effect.fail(new Internal({ message: `${machine.id} is still booting` })),
        ),
      );
    };

    /**
     * Boots the machine's VM through its job: bootstrapped if launchd doesn't hold it (as after a
     * reboot), then kickstarted without `-k`, which never touches a running VM. `kickstart`
     * returns before Tart has started the VM, so `ready` waits for the guest agent.
     */
    const boot = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);
        const { target, plist: file, log } = job(vm);
        const loaded = yield* launchctl(["print", target], `print ${target}`);

        if (loaded.exitCode === 113) {
          if (!(yield* files(`couldn't check ${file}`, fs.exists(file)))) {
            return yield* new Internal({
              message: `machine ${machine.id} has no VM job at ${file}; delete it`,
            });
          }

          yield* Effect.flatMap(launchctl(["bootstrap", domain, file], `bootstrap ${vm}`), (ran) =>
            expect(ran, `launchctl bootstrap ${vm}`),
          );
        } else {
          yield* expect(loaded, `launchctl print ${target}`);
        }

        // The log then holds only this boot's output, which a failed boot's error carries.
        yield* files(`couldn't empty ${log}`, fs.writeFileString(log, "", { mode: 0o600 }));
        yield* Effect.flatMap(launchctl(["kickstart", target], `kickstart ${vm}`), (ran) =>
          expect(ran, `launchctl kickstart ${vm}`),
        );
        yield* ready(machine);
        yield* listen(machine);
      });

    /** Waits until the VM no longer runs; false when `wait` passes first. */
    const halted = (vm: string, wait: Duration.Duration) =>
      state(vm).pipe(
        Effect.repeat({
          until: (observed) => observed !== "running",
          schedule: Schedule.spaced(stopPause),
        }),
        Effect.timeoutOption(wait),
        Effect.map(Option.isSome),
      );

    /**
     * Tart's forced stop: SIGINT, then SIGKILL of `tart run` at once. Exit 2 is a VM that
     * doesn't run.
     */
    const forceStop = (vm: string) =>
      Effect.gen(function* () {
        yield* call(["stop", "--timeout", "0", vm], `stop ${vm}`, [0, 2]);

        if (!(yield* halted(vm, forcedStopWait))) {
          return yield* new Internal({
            message: `${vm} still runs ${Duration.format(forcedStopWait)} after tart stop --timeout 0`,
          });
        }
      });

    /**
     * The guest's own `shutdown -h now`, which flushes its disks, then Tart's forced stop if the
     * guest hasn't stopped within `shutdownWait`. The exec may die with the guest, so only the
     * VM's state counts.
     */
    const stop = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);

        const shutdown = Effect.andThen(
          Effect.ignore(
            tart(["exec", vm, "sudo", "-n", "/sbin/shutdown", "-h", "now"], `exec ${vm}`),
          ),
          Effect.never,
        );

        const stopped = yield* Effect.raceFirst(halted(vm, shutdownWait), shutdown);

        if (!stopped) {
          yield* Effect.logWarning(
            `stop ${machine.id}: the guest didn't shut down within ${Duration.format(shutdownWait)}; forcing it off`,
          );
          yield* forceStop(vm);
        }

        yield* unlisten(machine);
      });

    /**
     * Deletes a VM. Exit 2 is a VM that doesn't exist; a running VM exits 1 (from Tart 2.40.0),
     * and is forced off, then deleted.
     */
    const deleteVm = (vm: string) =>
      Effect.gen(function* () {
        const first = yield* tart(["delete", vm], `delete ${vm}`);

        if (first.exitCode === 1) {
          yield* forceStop(vm);
          yield* call(["delete", vm], `delete ${vm}`, [0, 2]);
        } else {
          yield* expect(first, `tart delete ${vm}`, [0, 2]);
        }
      });

    /** Clones `from` into the machine's VM with a new serial, and its job. */
    const cloneInto = (from: string, machine: MachineRef, sizes: ReadonlyArray<string>) => {
      const vm = vmOf(machine);

      return Effect.gen(function* () {
        yield* writeJob(vm);
        yield* call(["clone", from, vm], `clone ${from} ${vm}`);
        yield* call(["set", vm, "--random-serial", ...sizes], `set ${vm}`);
        yield* boot(machine);
      });
    };

    /** A fork and a capture copy a stopped machine's disk: Tart's clone doesn't require one. */
    const copyable = (what: string, machine: MachineRef, observed: MachineState) => {
      if (observed === "missing") {
        return Effect.fail(
          new Precondition({
            message: `machine ${machine.id} is missing from the tart runtime; delete it`,
          }),
        );
      }

      return observed === "stopped"
        ? Effect.void
        : Effect.fail(
            new Precondition({
              message: `a Tart ${what} copies a stopped machine's disk, and ${machine.id} is running: stop it first`,
            }),
          );
    };

    return {
      name: "tart",
      version: reported,
      publishAddress: settings.publishAddress,
      pin: undefined,
      startup: (machines) =>
        Effect.gen(function* () {
          yield* files(
            `couldn't create ${jobs}`,
            fs.makeDirectory(jobs, { recursive: true, mode: 0o700 }),
          );

          const vms = yield* list;

          for (const machine of machines) {
            if (vms.get(vmOf(machine)) === "running") {
              yield* listen(machine).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`startup: no forwarder for ${machine.id}: ${error.message}`),
                ),
              );
            }
          }
        }),
      observe: (machine): Effect.Effect<Observed, HostError> =>
        Effect.map(state(vmOf(machine)), (observed) =>
          observed !== "running" || machine.port === undefined
            ? { state: observed }
            : { state: observed, ssh: { host: settings.publishAddress, port: machine.port } },
        ),
      /**
       * A fork's source must be stopped, and the Mac must have room: every running VM in the
       * Tart home counts, the operator's included, and so does every machine a booting action
       * holds, the target too, since its VM runs only once its job has started.
       */
      admit: ({ action, machine, machines, source }) =>
        Effect.gen(function* () {
          const vms = yield* list;

          if (source !== undefined) {
            yield* copyable("fork", source, vms.get(vmOf(source)) ?? "missing");
          }

          const counted = new Set<string>();

          for (const [vm, observed] of vms) {
            if (observed === "running") {
              counted.add(vm);
            }
          }

          // A fork holds its source too, which stays stopped.
          for (const { machine: held, holder } of machines) {
            if (holder !== undefined && bootingActions.has(holder) && held.id !== source?.id) {
              counted.add(vmOf(held));
            }
          }

          if (counted.size > vmLimit) {
            return yield* new Capacity({
              message: `${action} ${machine.id} would run ${counted.size} macOS VMs on this Mac, and Apple allows ${vmLimit}: ${[...counted].sort().join(", ")}`,
            });
          }
        }),
      create: (machine, image) =>
        cloneInto(image, machine, [
          "--cpu",
          String(machine.cpu),
          "--memory",
          String(machine.ramMib),
          "--disk-size",
          String(diskGb(machine.diskGib)),
        ]),
      start: boot,
      stop,
      delete: (machine) =>
        Effect.gen(function* () {
          const vm = vmOf(machine);
          const { target, plist: file, log } = job(vm);

          yield* unlisten(machine);
          yield* deleteVm(vm);

          // Exit 3 is a job launchd doesn't hold.
          yield* Effect.flatMap(launchctl(["bootout", target], `bootout ${vm}`), (ran) =>
            expect(ran, `launchctl bootout ${vm}`, [0, 3]),
          );

          for (const path of [file, log]) {
            yield* files(`couldn't remove ${path}`, fs.remove(path, { force: true }));
          }
        }),
      captureKind: (machine) =>
        Effect.flatMap(state(vmOf(machine)), (observed) =>
          Effect.as(copyable("checkpoint", machine, observed), "disk" as const),
        ),
      capture: (machine, checkpoint) =>
        Effect.asVoid(
          call(
            ["clone", vmOf(machine), checkpointVm(checkpoint)],
            `clone ${checkpointVm(checkpoint)}`,
          ),
        ),
      restore: (checkpoint, machine) => cloneInto(checkpointVm(checkpoint), machine, []),
      fork: (source, machine) => cloneInto(vmOf(source), machine, []),
      deleteCheckpoint: (checkpoint) =>
        Effect.asVoid(
          call(["delete", checkpointVm(checkpoint)], `delete ${checkpointVm(checkpoint)}`, [0, 2]),
        ),
      exec: (machine, { argv, stdin }) =>
        Effect.gen(function* () {
          const vm = vmOf(machine);
          const what = `tart exec ${vm}`;

          const failed = (error: PlatformError.PlatformError) =>
            new Internal({ message: `${what}: ${describe(error)}` });

          const handle = yield* spawner
            .spawn(
              command(
                settings.binary,
                ["exec", "-i", vm, "sudo", "-n", "--", ...argv],
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
  config: Pick<TartHost, "id" | "stateDir" | "tart">,
): Layer.Layer<
  Runtime,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(
    Runtime,
    make({
      ...config.tart,
      hostId: config.id,
      stateDir: config.stateDir,
      uid: process.getuid?.(),
      tartHome: process.env["TART_HOME"],
      network: softnet,
    }),
  );
