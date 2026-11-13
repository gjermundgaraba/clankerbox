import { homedir } from "node:os";
import path from "node:path";

import {
  Capacity,
  formatGib,
  formatMib,
  Internal,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type { HostError, Sizing } from "@gjermundgaraba/clankerbox-sdk";
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { lastLines } from "../../guest.ts";
import {
  atLeast,
  CannotStart,
  changes,
  Handle,
  missing,
  Runtime,
  sizedBy,
  timeoutFail,
} from "../../runtime.ts";
import type {
  Held,
  Identity,
  Interface,
  Origin,
  MachineState,
  Observed,
  Sizes,
  Target,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import { allotted, inUse } from "../../usage.ts";
import { cliIn, expect, files, regularFiles } from "../process.ts";
import * as Home from "./home.ts";
import * as Launchd from "./launchd.ts";
import * as Locks from "./locks.ts";
import { names, tartRuns } from "./runs.ts";
import { traits } from "./traits.ts";

export const TartSettings = Schema.Struct({
  binary: Schema.String,
});

export interface Settings {
  readonly binary: string;
  readonly publishAddress: string;
  readonly hostId: string;
  readonly stateDir: string;
  readonly uid: number | undefined;
  readonly tartHome: string | undefined;
}

const softnet = "--net-softnet-block=@host";

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Run.swift#L638
const saved = "snapshot created successfully";

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMStorageHelper.swift#L80
const vmLimit = 2;

const limitRefusal = "The number of VMs exceeds the system limit";

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L287
// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L303
const shrinkRefusal = "should be larger than the current disk size";

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMConfig.swift#L164
// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMConfig.swift#L178
const minimumRefusal = "at minimum (requested";

const bootWait = Duration.minutes(3);

const probePause = Duration.seconds(1);

const startWait = Duration.minutes(1);

const startPause = Duration.millis(100);

const shutdownWait = Duration.minutes(1);

const suspendWait = Duration.minutes(2);

const forcedStopWait = Duration.seconds(10);

const stopPause = Duration.millis(500);

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Network/Softnet.swift#L86
// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Utils.swift#L30
const searchPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export const environment = (settings: Pick<Settings, "tartHome">) => ({
  PATH: searchPath,
  HOME: homedir(),
  TART_HOME: settings.tartHome,
});

export const machineName = (host: string, machine: Identity): Handle =>
  Handle.make(`cbx-${host}-m-${machine.name}-${machine.instance.slice(0, 8)}`);

export const checkpointName = (host: string, checkpoint: Identity): Handle =>
  Handle.make(
    `cbx-${host}-c-${checkpoint.name}-${checkpoint.instance.slice(0, 8)}`
  );

export const jobsDir = (stateDir: string): string =>
  path.join(stateDir, "launchd");

const program = (binary: string, vm: string): readonly string[] => [
  binary,
  "run",
  "--no-graphics",
  softnet,
  "--suspendable",
  vm,
];

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L287
export const diskGb = (diskGib: number): number =>
  Math.ceil((diskGib * 1024 ** 3) / 1e9);

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Get.swift#L36
export const diskGibOf = (gb: number): number =>
  Math.floor((gb * 1e9) / 1024 ** 3);

const xml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const plist = (job: {
  readonly label: string;
  readonly program: readonly string[];
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
        : [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]
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

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Get.swift#L4
const decodeInfo = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      CPU: Schema.Int,
      Memory: Schema.Int,
      Disk: Schema.NullOr(Schema.Int),
    })
  )
);

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Set.swift#L12
// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Set.swift#L41
const maximumFlag = 2 ** 16 - 1;

const sizeFlags = ({ cpu, ramMib, diskGib }: Sizing): readonly string[] => [
  ...(cpu === undefined ? [] : ["--cpu", String(cpu)]),
  ...(ramMib === undefined ? [] : ["--memory", String(ramMib)]),
  ...(diskGib === undefined ? [] : ["--disk-size", String(diskGb(diskGib))]),
];

/** The oldest Tart a mac host starts under; the `bump-tart` skill owns it. */
export const minimumVersion = "2.41.1";

export const supported = atLeast(minimumVersion);

const ended = (job: Launchd.Job | undefined, target: string): string => {
  if (job === undefined) {
    return `ended, and launchd no longer holds ${target}`;
  }

  return job._tag === "exited" && job.lastExit !== undefined
    ? `exited ${job.lastExit}`
    : "ended before launchd recorded its exit";
};

const whyUnsaveable = (job: Launchd.Job | undefined): string | undefined => {
  if (job?._tag !== "running") {
    return "a tart run outside its launchd job runs it, whose output the host can't read for Tart's save";
  }

  return job.program.includes("--suspendable")
    ? undefined
    : "an older host booted it without --suspendable, which Tart can't suspend";
};

export const make = (
  settings: Settings
): Effect.Effect<
  Interface,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = Home.make(fs, settings.tartHome);
    const env = environment(settings);
    const { run, exec, dial } = yield* cliIn(env);
    const jobs = jobsDir(settings.stateDir);

    if (settings.uid === undefined) {
      return yield* new CannotStart({
        message: "a Tart host runs on macOS, as a user",
      });
    }

    const domain = `gui/${settings.uid}`;
    const vmOf = (machine: Identity) => machineName(settings.hostId, machine);

    const checkpointVm = (checkpoint: Identity) =>
      checkpointName(settings.hostId, checkpoint);

    const tart = (args: readonly string[], what: string) =>
      run(settings.binary, args, `tart ${what}`);

    const call = (
      args: readonly string[],
      what: string,
      ok?: readonly number[]
    ) =>
      Effect.flatMap(tart(args, what), (ran) =>
        expect(ran, `tart ${what}`, ok)
      );

    const launchctl = (
      args: readonly string[],
      what: string,
      ok?: readonly number[]
    ) =>
      Effect.flatMap(run("/bin/launchctl", args, `launchctl ${what}`), (ran) =>
        expect(ran, `launchctl ${what}`, ok)
      );

    const reported = (yield* call(["--version"], "--version")).stdout.trim();

    if (!supported(reported)) {
      return yield* new CannotStart({
        message: `${settings.binary} reports version "${reported}", and this host needs Tart ${minimumVersion} or later`,
      });
    }

    const job = (vm: string) => ({
      target: `${domain}/${vm}`,
      plist: path.join(jobs, `${vm}.plist`),
      log: path.join(jobs, `${vm}.log`),
    });

    const writeJob = (vm: string) => {
      const { plist: file, log } = job(vm);

      return files(
        `couldn't write ${file}`,
        fs.writeFileString(
          file,
          plist({
            label: vm,
            program: program(settings.binary, vm),
            environment: env,
            log,
          }),
          { mode: 0o600 }
        )
      );
    };

    const logOf = (vm: string) =>
      fs.readFileString(job(vm).log).pipe(Effect.orElseSucceed(() => ""));

    const jobOf = (vm: string) =>
      Effect.gen(function* () {
        const { target } = job(vm);

        const ran = yield* launchctl(
          ["print", target],
          `print ${target}`,
          [0, 113]
        );

        if (ran.exitCode === 113) {
          return undefined;
        }

        return yield* Effect.mapError(
          Effect.fromResult(Launchd.parse(ran.stdout)),
          (unread) =>
            new Internal({
              message: `launchctl print ${target} printed ${unread}: ${lastLines(ran.stdout)}`,
            })
        );
      });

    const lockFiles = (vms: readonly string[]) =>
      Effect.gen(function* () {
        const paths = vms.map((vm) => home.config(vm));
        const what = `${Locks.reader} reading the VMs' locks`;

        const ran = yield* expect(
          yield* run(Locks.reader, Locks.readerArguments(paths), what),
          what
        );

        const read = yield* Effect.mapError(
          Effect.fromResult(Locks.holders(paths, ran.stdout)),
          (why) => new Internal({ message: `${what}: ${why}` })
        );

        return new Map(vms.map((vm, at) => [vm, read[at] ?? 0]));
      });

    const onTheMac = Effect.map(
      Effect.flatMap(
        run("/bin/ps", ["-axo", "pid=,ucomm=,args="], "ps"),
        (ran) => expect(ran, "ps")
      ),
      ({ stdout }) => tartRuns(stdout, settings.binary)
    );

    const runsWith = (vm: string, holder: number) =>
      holder === 0
        ? Effect.map(jobOf(vm), (read) => read?._tag === "running")
        : Effect.succeed(true);

    // https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L52
    const running = (vm: string) =>
      Effect.flatMap(lockFiles([vm]), (held) =>
        runsWith(vm, held.get(vm) ?? 0)
      );

    // https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L65
    const stateWith = (
      vm: string,
      holder: number
    ): Effect.Effect<MachineState, Internal> =>
      Effect.gen(function* () {
        const held = yield* home.look(vm);

        if (held === undefined) {
          return "missing";
        }

        if (yield* runsWith(vm, holder)) {
          return "running";
        }

        return held.saved ? "paused" : "stopped";
      });

    const state = (vm: string) =>
      Effect.flatMap(lockFiles([vm]), (held) =>
        stateWith(vm, held.get(vm) ?? 0)
      );

    const states = (machines: readonly Target[]) =>
      Effect.gen(function* () {
        const held = yield* lockFiles(machines.map(({ handle }) => handle));

        const seen = yield* Effect.forEach(
          machines,
          (machine) =>
            Effect.map(
              stateWith(machine.handle, held.get(machine.handle) ?? 0),
              (read) => [machine.name, read] as const
            ),
          { concurrency: "unbounded" }
        );

        return new Map(seen) satisfies Observed;
      });

    const counted = (machines: readonly Held[]) =>
      Effect.gen(function* () {
        const ours = machines.map((each) => ({
          booting: each._tag === "booting",
          vm: each.machine.handle ?? vmOf(each.machine),
        }));

        const held = yield* lockFiles(ours.map(({ vm }) => vm));
        const onMac = yield* onTheMac;

        return new Set([
          ...ours.flatMap(({ booting, vm }) =>
            booting || (held.get(vm) ?? 0) !== 0 ? [vm] : []
          ),
          ...onMac.map(
            (each) =>
              ours.find(({ vm }) => names(each, vm))?.vm ??
              `tart run pid ${each.pid}`
          ),
        ]);
      });

    const ready = (machine: Target) => {
      const vm = machine.handle;
      const { target } = job(vm);

      const probe = Effect.gen(function* () {
        if ((yield* tart(["exec", vm, "true"], `exec ${vm}`)).exitCode === 0) {
          return true;
        }

        const read = yield* jobOf(vm);

        if (read?._tag === "running") {
          return false;
        }

        const output = yield* logOf(vm);

        if (output.includes(limitRefusal)) {
          return yield* new Capacity({
            message: `Apple's limit of ${vmLimit} running macOS VMs per Mac refused ${machine.name}: ${lastLines(output)}`,
          });
        }

        return yield* new Internal({
          message: `tart run for ${machine.name} ${ended(read, target)}: ${lastLines(output)}`,
        });
      });

      return probe.pipe(
        Effect.repeat({
          until: (answered) => answered,
          schedule: Schedule.spaced(probePause),
        }),
        timeoutFail(
          bootWait,
          () =>
            new Internal({
              message: `${machine.name}'s guest agent didn't answer tart exec within ${Duration.format(bootWait)} of its start`,
            })
        ),
        Effect.asVoid
      );
    };

    const halted = (vm: string, wait: Duration.Duration) =>
      running(vm).pipe(
        Effect.repeat({
          until: (runs) => !runs,
          schedule: Schedule.spaced(stopPause),
        }),
        Effect.timeoutOption(wait),
        Effect.map(Option.isSome)
      );

    const forceStop = (vm: string) =>
      Effect.gen(function* () {
        yield* call(["stop", "--timeout", "0", vm], `stop ${vm}`, [0, 2]);

        if (!(yield* halted(vm, forcedStopWait))) {
          return yield* new Internal({
            message: `${vm} still runs ${Duration.format(forcedStopWait)} after tart stop --timeout 0`,
          });
        }
      });

    const started = (vm: string, since: number) => {
      const socket = path.join(home.directory(vm), "control.sock");

      const look = Effect.gen(function* () {
        const info = yield* Effect.option(fs.stat(socket));

        if (
          Option.isSome(info) &&
          Option.exists(info.value.mtime, (at) => at.getTime() >= since)
        ) {
          return true;
        }

        return (yield* jobOf(vm))?._tag !== "running";
      });

      return look.pipe(
        Effect.repeat({
          until: (done) => done,
          schedule: Schedule.spaced(startPause),
        }),
        Effect.timeoutOption(startWait),
        Effect.asVoid
      );
    };

    // https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Run.swift#L589
    const launch = (machine: Target) =>
      Effect.gen(function* () {
        const vm = machine.handle;
        const { target, plist: file, log } = job(vm);

        yield* files(
          `couldn't empty ${log}`,
          fs.writeFileString(log, "", { mode: 0o600 })
        );
        yield* writeJob(vm);

        const loaded = yield* jobOf(vm);

        const stale =
          loaded?._tag === "exited" &&
          loaded.program.join("\n") !== program(settings.binary, vm).join("\n");

        if (stale) {
          yield* launchctl(["bootout", target], `bootout ${vm}`);
        }

        if (stale || loaded === undefined) {
          yield* launchctl(["bootstrap", domain, file], `bootstrap ${vm}`);
        }

        const since = (yield* Clock.currentTimeMillis) - 1000;

        yield* launchctl(["kickstart", target], `kickstart ${vm}`);
        yield* started(vm, since);
      });

    const boot = (machine: Target) =>
      Effect.andThen(launch(machine), ready(machine));

    const stop = (machine: Target) =>
      Effect.gen(function* () {
        const vm = machine.handle;
        const observed = yield* state(vm);

        if (observed === "paused") {
          yield* call(["stop", vm], `stop ${vm}`);

          return;
        }

        if (observed !== "running") {
          return;
        }

        const shutdown = Effect.andThen(
          Effect.ignore(
            tart(
              ["exec", vm, "sudo", "-n", "/sbin/shutdown", "-h", "now"],
              `exec ${vm}`
            )
          ),
          Effect.never
        );

        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const stopped = yield* Effect.raceFirst(
              halted(vm, shutdownWait),
              shutdown
            );

            if (!stopped) {
              yield* Effect.logWarning(
                `stop ${machine.name}: the guest didn't shut down within ${Duration.format(shutdownWait)}; forcing it off`
              );
              yield* forceStop(vm);
            }
          })
        );
      });

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

    const removed = (vm: string) =>
      Effect.gen(function* () {
        const { target, plist: file, log } = job(vm);

        yield* deleteVm(vm);

        yield* launchctl(["bootout", target], `bootout ${vm}`, [0, 3]);

        for (const leftover of [file, log]) {
          yield* files(
            `couldn't remove ${leftover}`,
            fs.remove(leftover, { force: true })
          );
        }
      });

    const set = (machine: Target, sizes: Sizes, flags: readonly string[]) =>
      Effect.gen(function* () {
        const vm = machine.handle;
        const ran = yield* tart(["set", vm, ...flags], `set ${vm}`);

        if (ran.exitCode !== 0 && ran.stderr.includes(shrinkRefusal)) {
          return yield* new Unsizable({
            message: `machine ${machine.name}'s disk of ${formatGib(sizes.diskGib)} is below the disk Tart holds for it, and Tart only grows a disk: ${lastLines(ran.stderr)}`,
          });
        }

        if (ran.exitCode !== 0 && ran.stderr.includes(minimumRefusal)) {
          return yield* new Unsizable({
            message: `machine ${machine.name}'s ${sizes.cpu} vCPUs and ${formatMib(sizes.ramMib)} are below what its guest takes: ${lastLines(ran.stderr)}`,
          });
        }

        yield* expect(ran, `tart set ${vm}`);
      });

    const cloneInto = (
      from: string,
      machine: Identity & Sizes,
      sizes: readonly string[]
    ) => {
      const made = { ...machine, handle: vmOf(machine) };

      return Effect.gen(function* () {
        yield* call(
          ["clone", from, made.handle],
          `clone ${from} ${made.handle}`
        );
        yield* set(made, machine, ["--random-serial", ...sizes]);
        yield* boot(made).pipe(
          Effect.catchTag("Capacity", (refused) =>
            Effect.andThen(removed(made.handle), Effect.fail(refused))
          )
        );

        return made.handle;
      });
    };

    const copyable = (what: string, machine: Target) =>
      Effect.flatMap(state(machine.handle), (observed) => {
        if (observed === "stopped") {
          return Effect.void;
        }

        return Effect.fail(
          observed === "missing"
            ? missing(traits.runtime, machine)
            : new WrongState({
                message: `a Tart ${what} copies a stopped machine's disk, and ${machine.name} is ${observed}: stop it first`,
                machine: machine.name,
                state: observed,
              })
        );
      });

    const resume = (machine: Target) =>
      boot(machine).pipe(
        Effect.catchTag("Internal", (error) =>
          Effect.fail(
            new Internal({
              message: `${error.message}; macOS resumes a saved state only while the Mac's session is unlocked, so if it is locked, unlock it and start ${machine.name} again: a restore that fails keeps the saved state, and a stop discards it`,
            })
          )
        )
      );

    const suspend = (machine: Target) =>
      Effect.gen(function* () {
        const vm = machine.handle;
        const { log } = job(vm);
        const observed = yield* state(vm);

        if (observed === "paused") {
          return;
        }

        if (observed === "missing") {
          return yield* missing(traits.runtime, machine);
        }

        if (observed !== "running") {
          return yield* new WrongState({
            message: `Tart reads ${machine.name} ${observed}, and suspends only a running machine`,
            machine: machine.name,
            state: observed,
          });
        }

        const unsaveable = whyUnsaveable(yield* jobOf(vm));

        if (unsaveable !== undefined) {
          yield* Effect.logWarning(
            `pause ${machine.name}: ${unsaveable}, so it stops it instead`
          );

          yield* stop(machine);

          return;
        }

        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* call(["suspend", vm], `suspend ${vm}`);

            if (!(yield* halted(vm, suspendWait))) {
              return yield* new Internal({
                message: `${machine.name} still runs ${Duration.format(suspendWait)} after tart suspend`,
              });
            }

            const output = yield* files(
              `couldn't read ${log}`,
              fs.readFileString(log)
            );

            if (!output.includes(saved)) {
              yield* call(["stop", vm], `stop ${vm}`, [0, 2]);

              return yield* new Internal({
                message: `Tart couldn't save ${machine.name}'s state and powered its VM off, as it does when the first save on a Mac runs while its session is locked: ${lastLines(output)}`,
              });
            }
          })
        );
      });

    const made = (machine: Identity & Sizes, origin: Origin) => {
      switch (origin._tag) {
        case "image": {
          return cloneInto(origin.image, machine, sizeFlags(machine));
        }

        case "checkpoint": {
          const { checkpoint } = origin;

          return cloneInto(
            checkpoint.handle,
            machine,
            sizeFlags(changes(checkpoint, machine))
          );
        }

        case "machine": {
          const source = origin.machine;

          return Effect.andThen(
            copyable("fork", source),
            cloneInto(
              source.handle,
              machine,
              sizeFlags(changes(source, machine))
            )
          );
        }
      }
    };

    return {
      version: reported,
      pin: undefined,
      prepares: "with-setup",
      owned: undefined,
      reach: {
        _tag: "relayed",
        address: settings.publishAddress,
        dial: (machine) =>
          dial(settings.binary, [
            "exec",
            "-i",
            machine.handle,
            "nc",
            "127.0.0.1",
            "22",
          ]),
      },
      admission: {
        admit: Effect.fn("Tart.admit")(({ action, machine, machines }) =>
          Effect.gen(function* () {
            const runs = yield* counted(machines);

            if (runs.size > vmLimit) {
              return yield* new Capacity({
                message: `${action} ${machine.name} would run ${runs.size} macOS VMs on this Mac, and Apple allows ${vmLimit}: ${[...runs].toSorted().join(", ")}`,
              });
            }
          })
        ),
      },
      files: {
        checkpointFiles: Effect.fn("Tart.checkpointFiles")((checkpoint) => {
          const dir = home.directory(checkpoint.handle);

          return Effect.map(regularFiles(fs, dir), (found) =>
            found.map((file) => ({ path: file, file: path.join(dir, file) }))
          );
        }),
        held: () => Effect.undefined,
        staging: (checkpoint) =>
          path.join(home.fetching, checkpointVm(checkpoint)),
        install: Effect.fn("Tart.install")((checkpoint, staged) => {
          const handle = checkpointVm(checkpoint);

          return files(
            `couldn't install checkpoint ${checkpoint.name}`,
            Effect.andThen(
              fs.makeDirectory(home.vms, { recursive: true }),
              fs.rename(staged, home.directory(handle))
            )
          ).pipe(Effect.as(handle));
        }),
      },
      traits,
      guest: "macos",
      startup: Effect.andThen(
        files(
          `couldn't create ${jobs}`,
          fs.makeDirectory(jobs, { recursive: true, mode: 0o700 })
        ),
        files(
          `couldn't remove ${home.fetching}`,
          fs.remove(home.fetching, { recursive: true, force: true })
        )
      ),
      find: Effect.fn("Tart.find")(function* (what, ref) {
        const handle = what === "machine" ? vmOf(ref) : checkpointVm(ref);

        if ((yield* home.look(handle)) !== undefined) {
          return handle;
        }

        if (what === "checkpoint") {
          return undefined;
        }

        const { plist: file, log } = job(handle);

        for (const leftover of [file, log]) {
          if (yield* files(`couldn't check ${leftover}`, fs.exists(leftover))) {
            return handle;
          }
        }

        return undefined;
      }),
      observe: Effect.fn("Tart.observe")(states),
      capacity: Effect.fn("Tart.capacity")((machines) =>
        Effect.gen(function* () {
          const used = yield* inUse(machines, states);

          return [
            {
              resource: "runningVms" as const,
              limit: vmLimit,
              used: (yield* counted(machines)).size,
            },
            ...allotted(used.running, used.unread),
          ];
        })
      ),
      make: Effect.fn("Tart.make")((machine, origin) =>
        Effect.map(made(machine, origin), (handle) => ({
          handle,
          sizes: {
            cpu: machine.cpu,
            ramMib: machine.ramMib,
            diskGib: machine.diskGib,
          },
        }))
      ),
      start: Effect.fn("Tart.start")((machine) =>
        Effect.gen(function* () {
          const observed = yield* state(machine.handle);

          if (observed === "missing") {
            return yield* missing(traits.runtime, machine);
          }

          if (observed === "stopped") {
            yield* boot(machine);
          }

          if (observed === "paused") {
            yield* resume(machine);
          }
        })
      ),
      stop: Effect.fn("Tart.stop")(stop),
      pause: Effect.fn("Tart.pause")(suspend),
      delete: Effect.fn("Tart.delete")((machine) => removed(machine.handle)),
      capture: Effect.fn("Tart.capture")((machine, checkpoint) => {
        const handle = checkpointVm(checkpoint);

        return copyable("checkpoint", machine).pipe(
          Effect.andThen(
            call(
              ["clone", machine.handle, handle],
              `clone ${machine.handle} ${handle}`
            )
          ),
          Effect.as(handle)
        );
      }),
      sizable: (machine, _from, to) => {
        if (to.cpu > maximumFlag || diskGb(to.diskGib) > maximumFlag) {
          return Effect.fail(
            new Unsizable({
              message: `tart set takes at most ${maximumFlag} vCPUs and ${maximumFlag} GB of disk, and ${machine.name} would have ${to.cpu} vCPUs and ${diskGb(to.diskGib)} GB`,
            })
          );
        }

        return Effect.void;
      },
      resize: Effect.fn("Tart.resize")((machine, to) =>
        Effect.gen(function* () {
          const flags = sizeFlags(to);

          if (flags.length > 0) {
            yield* set(machine, sizedBy(machine, to), flags);
          }
        })
      ),
      sizes: Effect.fn("Tart.sizes")((machine) => {
        const vm = machine.handle;

        return Effect.flatMap(
          call(["get", vm, "--format", "json"], `get ${vm}`),
          (ran) =>
            decodeInfo(ran.stdout).pipe(
              Effect.map(({ CPU, Memory, Disk }) => ({
                cpu: CPU,
                ramMib: Memory,
                diskGib: Disk === null ? undefined : diskGibOf(Disk),
              })),
              Effect.mapError(
                (error) =>
                  new Internal({
                    message: `tart get ${vm} answered something unexpected: ${error.message}`,
                  })
              )
            )
        );
      }),
      deleteCheckpoint: Effect.fn("Tart.deleteCheckpoint")((checkpoint) =>
        Effect.asVoid(
          call(
            ["delete", checkpoint.handle],
            `delete ${checkpoint.handle}`,
            [0, 2]
          )
        )
      ),
      exec: Effect.fn("Tart.exec")((machine, { argv, stdin, user }) => {
        const vm = machine.handle;
        const as = user === undefined ? [] : ["-u", user, "-H"];

        return exec(
          settings.binary,
          ["exec", "-i", vm, "sudo", "-n", ...as, "--", ...argv],
          stdin,
          `tart exec ${vm}`
        );
      }),
    } satisfies Interface;
  });

export const layer = (
  settings: typeof TartSettings.Type,
  config: Pick<HostSettings, "id" | "stateDir" | "listen">
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(
    Runtime,
    make({
      binary: settings.binary,
      publishAddress: config.listen.address,
      hostId: config.id,
      stateDir: config.stateDir,
      uid: process.getuid?.(),
      tartHome: process.env["TART_HOME"],
    })
  );
