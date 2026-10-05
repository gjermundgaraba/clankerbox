/**
 * The Tart runtime: macOS guests through the `tart` CLI of a versioned install, on a macOS host
 * that runs as the operator's user. Each VM runs as `tart run` under its own launchd job in the
 * user's GUI domain, so a host restart leaves VMs running, and the job references only tart. The
 * host's forwarder carries each machine's SSH connections into the guest, on a listener that
 * lives as long as the machine's row.
 *
 * Tart has one VM namespace per Tart home, shared with the operator's own VMs and with any other
 * host process on the Mac, so native names carry the host ID, the kind and the row's instance.
 * A checkpoint is always `disk`: a clone of a stopped machine. A fork clones a stopped machine,
 * and a restore clones a checkpoint.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Capacity, type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, FileSystem, Layer, Option, Schedule, Schema, type Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { cliIn, expect, files, portOf } from "./cli.ts";
import type { Tart, TartHost } from "./config.ts";
import * as Forwarder from "./forwarder.ts";
import { lastLines } from "./guest.ts";
import {
  type CheckpointRef,
  type Interface,
  type MachineRef,
  type MachineState,
  type Observed,
  Refusal,
  Runtime,
} from "./runtime.ts";

/**
 * The oldest Tart this host runs on: from 2.40.1 clone refuses an existing destination, delete's
 * exit codes are reliable, one accept error no longer disables `tart exec`, and `tart list` no
 * longer fails on running VMs. The bump-tart skill re-checks these at a new release.
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
}

/**
 * Softnet, blocking the Mac itself: guests can't reach the host's services (rewrite.md). `tart
 * run` without it falls back to Tart's shared NAT.
 */
const softnet = "--net-softnet-block=@host";

/**
 * Two running macOS VMs per Mac is Apple's limit, the operator's own VMs included. Tart reports
 * Apple's refusal of a third with this text (T:VMStorageHelper.swift:146-147).
 */
const vmLimit = 2;

const limitRefusal = "The number of VMs exceeds the system limit";

/**
 * `tart set --disk-size` only grows a disk, and refuses a smaller size with this text
 * (T:VMDirectory.swift:287-319).
 */
const shrinkRefusal = "should be larger than the current disk size";

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
 * run` right after its SIGINT (T:Commands/Stop.swift:51-68); the VM's lock goes with the
 * process.
 */
const forcedStopWait = Duration.seconds(10);

/** The pause between `tart list` reads while a VM stops. */
const stopPause = Duration.millis(500);

/**
 * The search path of every tart call and VM job. Tart finds `softnet` (and `sudo`) on it
 * (T:Network/Softnet.swift:86-94, Utils.swift:30-45): the operator installs Softnet, SUID root,
 * in `/usr/local/bin`, and Homebrew in `/opt/homebrew/bin`.
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

/** Whether `reported` is a `major.minor.patch` release at least `minimumVersion`. */
export const supported = (reported: string): boolean =>
  /^\d+\.\d+\.\d+$/u.test(reported) &&
  reported.localeCompare(minimumVersion, "en", { numeric: true }) >= 0;

/** A top-level `key = value` line of `launchctl print`; nested lines are indented further. */
const printed = (output: string, key: string): string | undefined =>
  new RegExp(`^\\t${key} = (.+)$`, "mu").exec(output)?.[1];

export const make = (
  settings: Settings,
): Effect.Effect<
  Interface,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = environment(settings);
    const { command, run, exec } = yield* cliIn(env);
    const jobs = jobsDir(settings.stateDir);

    if (settings.uid === undefined) {
      return yield* new Precondition({ message: "a Tart host runs on macOS, as a user" });
    }

    const domain = `gui/${settings.uid}`;
    const forwarder = yield* Forwarder.make(settings.publishAddress);
    const vmOf = (machine: MachineRef) => machineName(settings.hostId, machine);
    const checkpointVm = (checkpoint: CheckpointRef) => checkpointName(settings.hostId, checkpoint);

    const tart = (args: ReadonlyArray<string>, what: string) =>
      run(settings.binary, args, `tart ${what}`);

    const call = (args: ReadonlyArray<string>, what: string, ok?: ReadonlyArray<number>) =>
      Effect.flatMap(tart(args, what), (ran) => expect(ran, `tart ${what}`, ok));

    const launchctl = (args: ReadonlyArray<string>, what: string) =>
      run("/bin/launchctl", args, `launchctl ${what}`);

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

    /**
     * Writes the machine's VM job, at every boot, so its plist names the configured tart; `boot`
     * reloads a job launchd holds that names another.
     */
    const writeJob = (vm: string) => {
      const { plist: file, log } = job(vm);

      return files(
        `couldn't write ${file}`,
        fs.writeFileString(
          file,
          plist({
            label: vm,
            program: [settings.binary, "run", "--no-graphics", softnet, vm],
            environment: env,
            log,
          }),
          { mode: 0o600 },
        ),
      );
    };

    /**
     * Listens for the machine's SSH connections, from its create, or the host's startup, until
     * its delete, whatever its state; each connection runs `nc` in the guest, and on a stopped
     * machine closes at once. A start listens again if startup couldn't.
     */
    const listen = (machine: MachineRef) =>
      Effect.flatMap(portOf(machine), (port) =>
        forwarder.listen(port, (input) =>
          command(settings.binary, ["exec", "-i", vmOf(machine), "nc", "127.0.0.1", "22"], input),
        ),
      );

    const unlisten = (machine: MachineRef) =>
      machine.port === undefined ? Effect.void : forwarder.close(machine.port);

    /**
     * Waits until the VM's guest agent answers `tart exec`. Before `tart run` holds the VM, an
     * exec fails at once; while the guest boots, it blocks, and fails after about 30 s if the
     * agent isn't up yet (P11), so it is tried again until `bootWait` passes. A job that exits
     * instead failed the boot: its log says why, and Apple's refusal of a third VM is `Capacity`.
     */
    const ready = (machine: MachineRef) => {
      const vm = vmOf(machine);
      const { target, log } = job(vm);

      /** Whether the agent answered; false while the guest boots. */
      const probe = Effect.gen(function* () {
        if ((yield* tart(["exec", vm, "true"], `exec ${vm}`)).exitCode === 0) {
          return true;
        }

        const printedJob = yield* Effect.flatMap(
          launchctl(["print", target], `print ${target}`),
          (ran) => expect(ran, `launchctl print ${target}`),
        );

        if (printed(printedJob.stdout, "state") !== "not running") {
          return false;
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
        Effect.repeat({
          until: (answered) => answered,
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
      );
    };

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
     * Boots the machine's VM through its job, written again first: bootstrapped if launchd
     * doesn't hold it (as after a reboot), or booted out and bootstrapped again if it holds a
     * job that doesn't run and names another tart, then kickstarted without `-k`, which never
     * touches a running VM. `kickstart` returns before Tart has started the VM, so `ready` waits
     * for the guest agent. A boot that fails from there leaves the VM as it is, reachable
     * through its listener; a `start` of a made machine that runs prepares it again.
     */
    const boot = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);
        const { target, plist: file, log } = job(vm);

        yield* writeJob(vm);

        const loaded = yield* launchctl(["print", target], `print ${target}`);
        const program = printed(loaded.stdout, "program");

        // A job launchd holds runs the program it was bootstrapped with, not the plist's.
        const stale =
          loaded.exitCode === 0 &&
          printed(loaded.stdout, "state") === "not running" &&
          program !== undefined &&
          program !== settings.binary;

        if (stale) {
          yield* Effect.flatMap(launchctl(["bootout", target], `bootout ${vm}`), (ran) =>
            expect(ran, `launchctl bootout ${vm}`),
          );
        }

        if (stale || loaded.exitCode === 113) {
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

    /**
     * Clones `from` into the machine's VM with a new serial, and boots it. The machine's listener
     * opens first, so a port it can't listen on is refused before anything native. A `diskGib`
     * below the base's disk is the caller's to fix, so Tart's refusal of it is `Precondition`.
     */
    const cloneInto = (from: string, machine: MachineRef, sizes: ReadonlyArray<string>) => {
      const vm = vmOf(machine);

      return Effect.gen(function* () {
        yield* Effect.mapError(listen(machine), (error) => new Refusal({ error }));
        yield* call(["clone", from, vm], `clone ${from} ${vm}`);

        const set = yield* tart(["set", vm, "--random-serial", ...sizes], `set ${vm}`);

        if (set.exitCode !== 0 && set.stderr.includes(shrinkRefusal)) {
          return yield* new Precondition({
            message: `machine ${machine.id}'s disk of ${machine.diskGib} GiB is below its base's, and Tart only grows a disk: ${lastLines(set.stderr)}`,
          });
        }

        yield* expect(set, `tart set ${vm}`);
        yield* boot(machine);
      });
    };

    /**
     * A fork and a capture copy a stopped machine's disk: Tart's clone doesn't require one. Any
     * other state is refused before anything native.
     */
    const copyable = (what: string, machine: MachineRef) =>
      Effect.flatMap(state(vmOf(machine)), (observed) => {
        if (observed === "stopped") {
          return Effect.void;
        }

        return Effect.fail(
          new Refusal({
            error: new Precondition({
              message:
                observed === "missing"
                  ? `machine ${machine.id} is missing from the tart runtime; delete it`
                  : `a Tart ${what} copies a stopped machine's disk, and ${machine.id} is running: stop it first`,
            }),
          }),
        );
      });

    return {
      name: "tart",
      version: reported,
      publishAddress: settings.publishAddress,
      pin: undefined,
      checkpointKind: "disk",
      startup: (machines) =>
        Effect.gen(function* () {
          yield* files(
            `couldn't create ${jobs}`,
            fs.makeDirectory(jobs, { recursive: true, mode: 0o700 }),
          );

          // A port something else holds leaves only its machine unreachable: the host serves
          // the rest, its delete still works, and its start listens again before it boots.
          for (const machine of machines) {
            yield* listen(machine).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`startup: no forwarder for ${machine.id}: ${error.message}`),
              ),
            );
          }
        }),
      observe: (machines) =>
        Effect.map(list, (vms) =>
          machines.map((machine): Observed => {
            const observed = vms.get(vmOf(machine)) ?? "missing";

            return observed === "missing" || machine.port === undefined
              ? { state: observed }
              : { state: observed, ssh: { host: settings.publishAddress, port: machine.port } };
          }),
        ),
      /**
       * The Mac must have room: every running VM in the Tart home counts, the operator's
       * included, and so does every machine an action is booting, the target too, since its VM
       * runs only once its job has started. The operator's Linux VMs count too, which Apple
       * doesn't limit, so the count is conservative; Apple's own refusal is the real guard.
       */
      admit: ({ action, machine, machines }) =>
        Effect.gen(function* () {
          // Not `observe`, which answers only for the host's machines: every VM here counts.
          const vms = yield* list;
          const counted = new Set<string>();

          for (const [vm, observed] of vms) {
            if (observed === "running") {
              counted.add(vm);
            }
          }

          for (const { machine: held, booting } of machines) {
            if (booting) {
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
      start: (machine) => Effect.andThen(listen(machine), boot(machine)),
      stop,
      delete: (machine) =>
        Effect.gen(function* () {
          const vm = vmOf(machine);
          const { target, plist: file, log } = job(vm);

          yield* deleteVm(vm);

          // Exit 3 is a job launchd doesn't hold.
          yield* Effect.flatMap(launchctl(["bootout", target], `bootout ${vm}`), (ran) =>
            expect(ran, `launchctl bootout ${vm}`, [0, 3]),
          );

          for (const path of [file, log]) {
            yield* files(`couldn't remove ${path}`, fs.remove(path, { force: true }));
          }

          // Last, so a delete that fails leaves the machine reachable.
          yield* unlisten(machine);
        }),
      capture: (machine, checkpoint) =>
        Effect.andThen(
          copyable("checkpoint", machine),
          call(
            ["clone", vmOf(machine), checkpointVm(checkpoint)],
            `clone ${checkpointVm(checkpoint)}`,
          ),
        ),
      restore: (checkpoint, machine) => cloneInto(checkpointVm(checkpoint), machine, []),
      fork: (source, machine) =>
        Effect.andThen(copyable("fork", source), cloneInto(vmOf(source), machine, [])),
      deleteCheckpoint: (checkpoint) =>
        Effect.asVoid(
          call(["delete", checkpointVm(checkpoint)], `delete ${checkpointVm(checkpoint)}`, [0, 2]),
        ),
      exec: (machine, { argv, stdin }) => {
        const vm = vmOf(machine);

        return exec(
          settings.binary,
          ["exec", "-i", vm, "sudo", "-n", "--", ...argv],
          stdin,
          `tart exec ${vm}`,
        );
      },
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
    }),
  );
