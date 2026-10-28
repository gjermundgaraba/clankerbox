import { homedir } from "node:os";
import path from "node:path";

import {
  Capacity,
  formatGib,
  formatMib,
  Internal,
  requirements,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type { HostError, Sizing } from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import type { Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { lastLines } from "../../guest.ts";
import {
  changes,
  missing,
  Runtime,
  sizedBy,
  timeoutFail,
} from "../../runtime.ts";
import type {
  CheckpointRef,
  Held,
  Interface,
  MachineRef,
  MachineState,
  Observed,
  Sizes,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import { CannotStart } from "../../startup.ts";
import { allotted, inUse } from "../../usage.ts";
import { cliIn, expect, files } from "../process.ts";
import * as Forwarder from "./forwarder.ts";

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

export const machineName = (
  host: string,
  machine: Pick<MachineRef, "name" | "instance">
): string => `cbx-${host}-m-${machine.name}-${machine.instance.slice(0, 8)}`;

export const checkpointName = (
  host: string,
  checkpoint: Pick<CheckpointRef, "name" | "instance">
): string =>
  `cbx-${host}-c-${checkpoint.name}-${checkpoint.instance.slice(0, 8)}`;

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

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L6
const VmState = Schema.Literals(["running", "suspended", "stopped"]);

const decodeList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ Name: Schema.String, State: VmState }))
  )
);

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

export const stateOf = (state: typeof VmState.Type): MachineState =>
  state === "suspended" ? "paused" : state;

export const supported = (reported: string): boolean =>
  /^\d+\.\d+\.\d+$/u.test(reported) &&
  reported.localeCompare(requirements.tart.minimumVersion, "en", {
    numeric: true,
  }) >= 0;

const printed = (output: string, key: string): string | undefined =>
  new RegExp(`^\\t${key} = (.+)$`, "mu").exec(output)?.[1];

const printedArguments = (output: string): readonly string[] | undefined =>
  /^\targuments = \{\n(?<lines>(?:\t\t.*\n)*)\t\}$/mu
    .exec(output)
    ?.groups?.["lines"]?.split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(2));

export const make = (
  settings: Settings
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
      return yield* new CannotStart({
        message: "a Tart host runs on macOS, as a user",
      });
    }

    const domain = `gui/${settings.uid}`;
    const forwarder = yield* Forwarder.make(settings.publishAddress);
    const vmOf = (machine: MachineRef) => machineName(settings.hostId, machine);

    const checkpointVm = (checkpoint: CheckpointRef) =>
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

    const launchctl = (args: readonly string[], what: string) =>
      run("/bin/launchctl", args, `launchctl ${what}`);

    const reported = (yield* call(["--version"], "--version")).stdout.trim();

    if (!supported(reported)) {
      return yield* new CannotStart({
        message: `${settings.binary} reports version "${reported}", and this host needs Tart ${requirements.tart.minimumVersion} or later`,
      });
    }

    const list = Effect.flatMap(
      call(["list", "--source", "local", "--format", "json"], "list"),
      (ran) =>
        decodeList(ran.stdout).pipe(
          Effect.map(
            (vms) => new Map(vms.map((vm) => [vm.Name, stateOf(vm.State)]))
          ),
          Effect.mapError(
            (error) =>
              new Internal({
                message: `tart list answered something unexpected: ${error.message}`,
              })
          )
        )
    );

    const state = (vm: string) =>
      Effect.map(list, (vms) => vms.get(vm) ?? "missing");

    const countedIn = (
      vms: ReadonlyMap<string, MachineState>,
      machines: readonly Held[]
    ) => {
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
      machines: readonly MachineRef[]
    ): Observed =>
      new Map(
        machines.map((machine) => [
          machine.id,
          vms.get(vmOf(machine)) ?? "missing",
        ])
      );

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

    const listen = (machine: MachineRef) =>
      forwarder.listen(machine.port, (input) =>
        command(
          settings.binary,
          ["exec", "-i", vmOf(machine), "nc", "127.0.0.1", "22"],
          input
        )
      );

    const unlisten = (machine: MachineRef) => forwarder.close(machine.port);

    const ready = (machine: MachineRef) => {
      const vm = vmOf(machine);
      const { target } = job(vm);

      const probe = Effect.gen(function* () {
        if ((yield* tart(["exec", vm, "true"], `exec ${vm}`)).exitCode === 0) {
          return true;
        }

        const printedJob = yield* Effect.flatMap(
          launchctl(["print", target], `print ${target}`),
          (ran) => expect(ran, `launchctl print ${target}`)
        );

        if (printed(printedJob.stdout, "state") !== "not running") {
          return false;
        }

        const output = yield* logOf(vm);

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
            })
        ),
        Effect.asVoid
      );
    };

    const halted = (vm: string, wait: Duration.Duration) =>
      state(vm).pipe(
        Effect.repeat({
          until: (observed) => observed !== "running",
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

    const boot = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);
        const { target, plist: file, log } = job(vm);

        yield* files(
          `couldn't empty ${log}`,
          fs.writeFileString(log, "", { mode: 0o600 })
        );
        yield* writeJob(vm);

        const loaded = yield* launchctl(["print", target], `print ${target}`);

        const stale =
          loaded.exitCode === 0 &&
          printed(loaded.stdout, "state") === "not running" &&
          printedArguments(loaded.stdout)?.join("\n") !==
            program(settings.binary, vm).join("\n");

        if (stale) {
          yield* Effect.flatMap(
            launchctl(["bootout", target], `bootout ${vm}`),
            (ran) => expect(ran, `launchctl bootout ${vm}`)
          );
        }

        yield* stale || loaded.exitCode === 113
          ? Effect.flatMap(
              launchctl(["bootstrap", domain, file], `bootstrap ${vm}`),
              (ran) => expect(ran, `launchctl bootstrap ${vm}`)
            )
          : expect(loaded, `launchctl print ${target}`);

        yield* Effect.flatMap(
          launchctl(["kickstart", target], `kickstart ${vm}`),
          (ran) => expect(ran, `launchctl kickstart ${vm}`)
        );
        yield* ready(machine);
      });

    const stop = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);
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

        const stopped = yield* Effect.raceFirst(
          halted(vm, shutdownWait),
          shutdown
        );

        if (!stopped) {
          yield* Effect.logWarning(
            `stop ${machine.id}: the guest didn't shut down within ${Duration.format(shutdownWait)}; forcing it off`
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

    const set = (machine: MachineRef, sizes: Sizes, flags: readonly string[]) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);
        const ran = yield* tart(["set", vm, ...flags], `set ${vm}`);

        if (ran.exitCode !== 0 && ran.stderr.includes(shrinkRefusal)) {
          return yield* new Unsizable({
            message: `machine ${machine.id}'s disk of ${formatGib(sizes.diskGib)} is below the disk Tart holds for it, and Tart only grows a disk: ${lastLines(ran.stderr)}`,
          });
        }

        if (ran.exitCode !== 0 && ran.stderr.includes(minimumRefusal)) {
          return yield* new Unsizable({
            message: `machine ${machine.id}'s ${sizes.cpu} vCPUs and ${formatMib(sizes.ramMib)} are below what its guest takes: ${lastLines(ran.stderr)}`,
          });
        }

        yield* expect(ran, `tart set ${vm}`);
      });

    const cloneInto = (
      from: string,
      machine: MachineRef,
      sizes: readonly string[]
    ) => {
      const vm = vmOf(machine);

      return Effect.gen(function* () {
        yield* listen(machine);
        yield* call(["clone", from, vm], `clone ${from} ${vm}`);
        yield* set(machine, machine, ["--random-serial", ...sizes]);
        yield* boot(machine);
      });
    };

    const copyable = (what: string, machine: MachineRef) =>
      Effect.flatMap(state(vmOf(machine)), (observed) => {
        if (observed === "stopped") {
          return Effect.void;
        }

        return Effect.fail(
          observed === "missing"
            ? missing("mac", machine)
            : new WrongState({
                message: `a Tart ${what} copies a stopped machine's disk, and ${machine.id} is ${observed}: stop it first`,
                machine: machine.id,
                state: observed,
              })
        );
      });

    const resume = (machine: MachineRef) =>
      boot(machine).pipe(
        Effect.catchTag("Internal", (error) =>
          Effect.fail(
            new Internal({
              message: `${error.message}; macOS resumes a saved state only while the Mac's session is unlocked, so if it is locked, unlock it and start ${machine.id} again: a restore that fails keeps the saved state, and a stop discards it`,
            })
          )
        )
      );

    const suspend = (machine: MachineRef) =>
      Effect.gen(function* () {
        const vm = vmOf(machine);
        const { target, log } = job(vm);
        const observed = yield* state(vm);

        if (observed === "paused") {
          return;
        }

        if (observed === "missing") {
          return yield* missing("mac", machine);
        }

        if (observed !== "running") {
          return yield* new WrongState({
            message: `Tart reads ${machine.id} ${observed}, and suspends only a running machine`,
            machine: machine.id,
            state: observed,
          });
        }

        const loaded = yield* Effect.flatMap(
          launchctl(["print", target], `print ${target}`),
          (ran) => expect(ran, `launchctl print ${target}`)
        );

        const loadedArguments = printedArguments(loaded.stdout);

        if (loadedArguments === undefined) {
          return yield* new Internal({
            message: `couldn't read the arguments in launchctl print ${target}, so the pause can't tell whether Tart can suspend ${machine.id}`,
          });
        }

        if (!loadedArguments.includes("--suspendable")) {
          yield* Effect.logWarning(
            `pause ${machine.id}: an older host booted it without --suspendable, which Tart can't suspend, so it stops it instead`
          );

          yield* stop(machine);

          return;
        }

        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* call(["suspend", vm], `suspend ${vm}`);

            if (!(yield* halted(vm, suspendWait))) {
              return yield* new Internal({
                message: `${machine.id} still runs ${Duration.format(suspendWait)} after tart suspend`,
              });
            }

            const output = yield* files(
              `couldn't read ${log}`,
              fs.readFileString(log)
            );

            if (!output.includes(saved)) {
              yield* call(["stop", vm], `stop ${vm}`, [0, 2]);

              return yield* new Internal({
                message: `Tart couldn't save ${machine.id}'s state and powered its VM off, as it does when the first save on a Mac runs while its session is locked: ${lastLines(output)}`,
              });
            }
          })
        );
      });

    return {
      version: reported,
      publishAddress: settings.publishAddress,
      pin: undefined,
      stopResumes: false,
      growsLive: false,
      startup: Effect.fn("Tart.startup")((machines) =>
        Effect.gen(function* () {
          yield* files(
            `couldn't create ${jobs}`,
            fs.makeDirectory(jobs, { recursive: true, mode: 0o700 })
          );

          for (const machine of machines) {
            yield* listen(machine).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `startup: no forwarder for ${machine.id}: ${error.message}`
                )
              )
            );
          }
        })
      ),
      observe: Effect.fn("Tart.observe")((machines) =>
        Effect.map(list, (vms) => observedIn(vms, machines))
      ),
      admit: Effect.fn("Tart.admit")(({ action, machine, machines }) =>
        Effect.gen(function* () {
          const counted = countedIn(yield* list, machines);

          if (counted.size > vmLimit) {
            return yield* new Capacity({
              message: `${action} ${machine.id} would run ${counted.size} macOS VMs on this Mac, and Apple allows ${vmLimit}: ${[...counted].toSorted().join(", ")}`,
            });
          }
        })
      ),
      capacity: Effect.fn("Tart.capacity")((machines) =>
        Effect.gen(function* () {
          const vms = yield* list;

          const { running, unread } = yield* inUse(machines, (refs) =>
            Effect.succeed(observedIn(vms, refs))
          );

          return [
            {
              resource: "runningVms" as const,
              limit: vmLimit,
              used: countedIn(vms, machines).size,
            },
            ...allotted(running, unread),
          ];
        })
      ),
      create: Effect.fn("Tart.create")((machine, image) =>
        cloneInto(image, machine, sizeFlags(machine))
      ),
      start: Effect.fn("Tart.start")((machine) =>
        Effect.gen(function* () {
          const observed = yield* state(vmOf(machine));

          if (observed === "missing") {
            return yield* missing("mac", machine);
          }

          yield* listen(machine);

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
      delete: Effect.fn("Tart.delete")((machine) =>
        Effect.gen(function* () {
          const vm = vmOf(machine);
          const { target, plist: file, log } = job(vm);

          yield* deleteVm(vm);

          yield* Effect.flatMap(
            launchctl(["bootout", target], `bootout ${vm}`),
            (ran) => expect(ran, `launchctl bootout ${vm}`, [0, 3])
          );

          for (const leftover of [file, log]) {
            yield* files(
              `couldn't remove ${leftover}`,
              fs.remove(leftover, { force: true })
            );
          }

          yield* unlisten(machine);
        })
      ),
      capture: Effect.fn("Tart.capture")((machine, checkpoint) =>
        Effect.andThen(
          copyable("checkpoint", machine),
          call(
            ["clone", vmOf(machine), checkpointVm(checkpoint)],
            `clone ${checkpointVm(checkpoint)}`
          )
        )
      ),
      restore: Effect.fn("Tart.restore")((checkpoint, machine) =>
        cloneInto(
          checkpointVm(checkpoint),
          machine,
          sizeFlags(changes(checkpoint, machine))
        )
      ),
      fork: Effect.fn("Tart.fork")((source, machine) =>
        Effect.andThen(
          copyable("fork", source),
          cloneInto(vmOf(source), machine, sizeFlags(changes(source, machine)))
        )
      ),
      sizable: (machine, _from, to) => {
        if (to.cpu > maximumFlag || diskGb(to.diskGib) > maximumFlag) {
          return Effect.fail(
            new Unsizable({
              message: `tart set takes at most ${maximumFlag} vCPUs and ${maximumFlag} GB of disk, and ${machine.id} would have ${to.cpu} vCPUs and ${diskGb(to.diskGib)} GB`,
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
        const vm = vmOf(machine);

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
            ["delete", checkpointVm(checkpoint)],
            `delete ${checkpointVm(checkpoint)}`,
            [0, 2]
          )
        )
      ),
      exec: Effect.fn("Tart.exec")((machine, { argv, stdin, user }) => {
        const vm = vmOf(machine);
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
  config: Pick<HostSettings, "id" | "stateDir" | "listen"> & {
    readonly mac: typeof TartSettings.Type;
  }
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Layer.effect(
    Runtime,
    make({
      binary: config.mac.binary,
      publishAddress: config.listen.address,
      hostId: config.id,
      stateDir: config.stateDir,
      uid: process.getuid?.(),
      tartHome: process.env["TART_HOME"],
    })
  );
