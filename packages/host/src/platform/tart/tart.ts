import { homedir } from "node:os";
import { join } from "node:path";
import {
  Capacity,
  formatGib,
  type HostError,
  Internal,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, FileSystem, Layer, Option, Schedule, Schema, type Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { lastLines } from "../../guest.ts";
import {
  type CheckpointRef,
  type Held,
  type Interface,
  type MachineRef,
  type MachineState,
  missing,
  type Observed,
  Runtime,
  timeoutFail,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import { CannotStart } from "../../startup.ts";
import { allotted, inUse } from "../../usage.ts";
import { cliIn, expect, files, portOf } from "../process.ts";
import * as Forwarder from "./forwarder.ts";

export const TartSettings = Schema.Struct({
  binary: Schema.String,
});

export const minimumVersion = "2.40.1";

export interface Settings {
  readonly binary: string;
  readonly publishAddress: string;
  readonly hostId: string;
  readonly stateDir: string;
  /** Node has none off POSIX. */
  readonly uid: number | undefined;
  readonly tartHome: string | undefined;
}

const softnet = "--net-softnet-block=@host";

// Source: T@2.40.1:VMStorageHelper.swift:146-147
const vmLimit = 2;

const limitRefusal = "The number of VMs exceeds the system limit";

// Source: T@2.40.1:VMDirectory.swift:287-319
const shrinkRefusal = "should be larger than the current disk size";

const bootWait = Duration.minutes(3);

const probePause = Duration.seconds(1);

const shutdownWait = Duration.minutes(1);

// Source: T@2.40.1:Commands/Stop.swift:51-68
const forcedStopWait = Duration.seconds(10);

const stopPause = Duration.millis(500);

// Source: T@2.40.1:Network/Softnet.swift:86-94, Utils.swift:30-45
const searchPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export const environment = (settings: Pick<Settings, "tartHome">) => ({
  PATH: searchPath,
  HOME: homedir(),
  TART_HOME: settings.tartHome,
});

export const machineName = (host: string, machine: Pick<MachineRef, "name" | "instance">): string =>
  `cbx-${host}-m-${machine.name}-${machine.instance.slice(0, 8)}`;

export const checkpointName = (
  host: string,
  checkpoint: Pick<CheckpointRef, "name" | "instance">,
): string => `cbx-${host}-c-${checkpoint.name}-${checkpoint.instance.slice(0, 8)}`;

export const jobsDir = (stateDir: string): string => join(stateDir, "launchd");

// Source: T@2.40.1:VMDirectory.swift:287-301
export const diskGb = (diskGib: number): number => Math.ceil((diskGib * 1024 ** 3) / 1e9);

const xml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const plist = (job: {
  readonly label: string;
  readonly program: ReadonlyArray<string>;
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

// Source: T@2.40.1:VMDirectory.swift:6-10
const VmState = Schema.Literals(["running", "suspended", "stopped"]);

const decodeList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ Name: Schema.String, State: VmState }))),
);

export const stateOf = (state: typeof VmState.Type): MachineState =>
  state === "running" ? "running" : "stopped";

export const supported = (reported: string): boolean =>
  /^\d+\.\d+\.\d+$/u.test(reported) &&
  reported.localeCompare(minimumVersion, "en", { numeric: true }) >= 0;

const printed = (output: string, key: string): string | undefined =>
  new RegExp(`^\\t${key} = (.+)$`, "mu").exec(output)?.[1];

export const make = (
  settings: Settings,
): Effect.Effect<
  Interface,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = environment(settings);
    const { command, run, exec } = yield* cliIn(env);
    const jobs = jobsDir(settings.stateDir);

    if (settings.uid === undefined) {
      return yield* new CannotStart({ message: "a Tart host runs on macOS, as a user" });
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
      return yield* new CannotStart({
        message: `${settings.binary} reports version "${reported}", and this host needs Tart ${minimumVersion} or later`,
      });
    }

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

    const countedIn = (vms: ReadonlyMap<string, MachineState>, machines: ReadonlyArray<Held>) => {
      const counted = new Set<string>();

      for (const [vm, observed] of vms) {
        if (observed === "running") {
          counted.add(vm);
        }
      }

      for (const { machine, booting } of machines) {
        if (booting) {
          counted.add(vmOf(machine));
        }
      }

      return counted;
    };

    const observedIn = (
      vms: ReadonlyMap<string, MachineState>,
      machines: ReadonlyArray<MachineRef>,
    ): ReadonlyArray<Observed> =>
      machines.map((machine) => ({ state: vms.get(vmOf(machine)) ?? "missing" }));

    const job = (vm: string) => ({
      target: `${domain}/${vm}`,
      plist: join(jobs, `${vm}.plist`),
      log: join(jobs, `${vm}.log`),
    });

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

    const listen = (machine: MachineRef) =>
      Effect.flatMap(portOf(machine), (port) =>
        forwarder.listen(port, (input) =>
          command(settings.binary, ["exec", "-i", vmOf(machine), "nc", "127.0.0.1", "22"], input),
        ),
      );

    const unlisten = (machine: MachineRef) =>
      machine.port === undefined ? Effect.void : forwarder.close(machine.port);

    const ready = (machine: MachineRef) => {
      const vm = vmOf(machine);
      const { target, log } = job(vm);

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
        timeoutFail(
          bootWait,
          () =>
            new Internal({
              message: `${machine.id}'s guest agent didn't answer tart exec within ${Duration.format(bootWait)} of its start`,
            }),
        ),
        Effect.asVoid,
      );
    };

    const halted = (vm: string, wait: Duration.Duration) =>
      state(vm).pipe(
        Effect.repeat({
          until: (observed) => observed !== "running",
          schedule: Schedule.spaced(stopPause),
        }),
        Effect.timeoutOption(wait),
        Effect.map(Option.isSome),
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

    const boot = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);
        const { target, plist: file, log } = job(vm);

        yield* writeJob(vm);

        const loaded = yield* launchctl(["print", target], `print ${target}`);
        const program = printed(loaded.stdout, "program");

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

        yield* files(`couldn't empty ${log}`, fs.writeFileString(log, "", { mode: 0o600 }));
        yield* Effect.flatMap(launchctl(["kickstart", target], `kickstart ${vm}`), (ran) =>
          expect(ran, `launchctl kickstart ${vm}`),
        );
        yield* ready(machine);
      });

    const stop = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);

        if ((yield* state(vm)) !== "running") {
          return;
        }

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

    const cloneInto = (from: string, machine: MachineRef, sizes: ReadonlyArray<string>) => {
      const vm = vmOf(machine);

      return Effect.gen(function* () {
        yield* listen(machine);
        yield* call(["clone", from, vm], `clone ${from} ${vm}`);

        const set = yield* tart(["set", vm, "--random-serial", ...sizes], `set ${vm}`);

        if (set.exitCode !== 0 && set.stderr.includes(shrinkRefusal)) {
          return yield* new Unsizable({
            message: `machine ${machine.id}'s disk of ${formatGib(machine.diskGib)} is below its base's, and Tart only grows a disk: ${lastLines(set.stderr)}`,
          });
        }

        yield* expect(set, `tart set ${vm}`);
        yield* boot(machine);
      });
    };

    const copiedFrom = "stopped";

    const copyable = (what: string, machine: MachineRef) =>
      Effect.flatMap(state(vmOf(machine)), (observed) => {
        if (observed === copiedFrom) {
          return Effect.void;
        }

        return Effect.fail(
          observed === "missing"
            ? missing("tart", machine)
            : new WrongState({
                message: `a Tart ${what} copies a stopped machine's disk, and ${machine.id} is running: stop it first`,
                machine: machine.id,
                state: observed,
              }),
        );
      });

    return {
      name: "tart",
      version: reported,
      publishAddress: settings.publishAddress,
      pin: undefined,
      checkpointKind: "disk",
      captureFrom: copiedFrom,
      loginUser: "admin",
      startup: Effect.fn("Tart.startup")((machines) =>
        Effect.gen(function* () {
          yield* files(
            `couldn't create ${jobs}`,
            fs.makeDirectory(jobs, { recursive: true, mode: 0o700 }),
          );

          for (const machine of machines) {
            yield* listen(machine).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`startup: no forwarder for ${machine.id}: ${error.message}`),
              ),
            );
          }
        }),
      ),
      observe: Effect.fn("Tart.observe")((machines) =>
        Effect.map(list, (vms) => observedIn(vms, machines)),
      ),
      admit: Effect.fn("Tart.admit")(({ action, machine, machines }) =>
        Effect.gen(function* () {
          const counted = countedIn(yield* list, machines);

          if (counted.size > vmLimit) {
            return yield* new Capacity({
              message: `${action} ${machine.id} would run ${counted.size} macOS VMs on this Mac, and Apple allows ${vmLimit}: ${[...counted].sort().join(", ")}`,
            });
          }
        }),
      ),
      capacity: Effect.fn("Tart.capacity")((machines) =>
        Effect.gen(function* () {
          const vms = yield* list;

          const { running, unread } = yield* inUse(machines, (refs) =>
            Effect.succeed(observedIn(vms, refs)),
          );

          return [
            {
              resource: "runningVms" as const,
              limit: vmLimit,
              used: countedIn(vms, machines).size,
            },
            ...allotted(running, unread),
          ];
        }),
      ),
      create: Effect.fn("Tart.create")((machine, image) =>
        cloneInto(image, machine, [
          "--cpu",
          String(machine.cpu),
          "--memory",
          String(machine.ramMib),
          "--disk-size",
          String(diskGb(machine.diskGib)),
        ]),
      ),
      start: Effect.fn("Tart.start")((machine) =>
        Effect.gen(function* () {
          const observed = yield* state(vmOf(machine));

          if (observed === "missing") {
            return yield* missing("tart", machine);
          }

          yield* listen(machine);

          if (observed === "stopped") {
            yield* boot(machine);
          }
        }),
      ),
      stop: Effect.fn("Tart.stop")(stop),
      delete: Effect.fn("Tart.delete")((machine) =>
        Effect.gen(function* () {
          const vm = vmOf(machine);
          const { target, plist: file, log } = job(vm);

          yield* deleteVm(vm);

          yield* Effect.flatMap(launchctl(["bootout", target], `bootout ${vm}`), (ran) =>
            expect(ran, `launchctl bootout ${vm}`, [0, 3]),
          );

          for (const path of [file, log]) {
            yield* files(`couldn't remove ${path}`, fs.remove(path, { force: true }));
          }

          yield* unlisten(machine);
        }),
      ),
      capture: Effect.fn("Tart.capture")((machine, checkpoint) =>
        Effect.andThen(
          copyable("checkpoint", machine),
          call(
            ["clone", vmOf(machine), checkpointVm(checkpoint)],
            `clone ${checkpointVm(checkpoint)}`,
          ),
        ),
      ),
      restore: Effect.fn("Tart.restore")((checkpoint, machine) =>
        cloneInto(checkpointVm(checkpoint), machine, []),
      ),
      fork: Effect.fn("Tart.fork")((source, machine) =>
        Effect.andThen(copyable("fork", source), cloneInto(vmOf(source), machine, [])),
      ),
      deleteCheckpoint: Effect.fn("Tart.deleteCheckpoint")((checkpoint) =>
        Effect.asVoid(
          call(["delete", checkpointVm(checkpoint)], `delete ${checkpointVm(checkpoint)}`, [0, 2]),
        ),
      ),
      exec: Effect.fn("Tart.exec")((machine, { argv, stdin }) => {
        const vm = vmOf(machine);

        return exec(
          settings.binary,
          ["exec", "-i", vm, "sudo", "-n", "--", ...argv],
          stdin,
          `tart exec ${vm}`,
        );
      }),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id" | "stateDir" | "listen"> & {
    readonly tart: typeof TartSettings.Type;
  },
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(
    Runtime,
    make({
      binary: config.tart.binary,
      publishAddress: config.listen.address,
      hostId: config.id,
      stateDir: config.stateDir,
      uid: process.getuid?.(),
      tartHome: process.env["TART_HOME"],
    }),
  );
