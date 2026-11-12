import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import {
  checkpointName,
  diskGb,
  diskGibOf,
  environment,
  jobsDir,
  machineName,
  make,
  plist,
  stateOf,
  supported,
} from "../../../src/platform/tart/tart.ts";
import type { Settings } from "../../../src/platform/tart/tart.ts";
import type { Interface, MachineRef } from "../../../src/runtime.ts";
import { scripted } from "../../scripted.ts";
import type { Call, Reply } from "../../scripted.ts";
import { admitOn } from "../../support.ts";

const failure = (error: HostError) => [error._tag, error.message];

const binary = "/opt/tart/2.41.1/tart.app/Contents/MacOS/tart";

const launchctl = "/bin/launchctl";

let nextPort = 21_200;

const ownPort = () => {
  const port = nextPort;
  nextPort += 1;

  return port;
};

const machineOn = (name: string): MachineRef => ({
  name,
  instance: `${name.length.toString(16).padStart(2, "0")}23456789abcdef0123456789abcdef`,
  cpu: 4,
  ramMib: 8192,
  diskGib: 60,
  port: ownPort(),
});

interface Hooks {
  list?: () => Reply | undefined;
  kickstart?: (vm: string) => void;
  probe?: (vm: string) => Reply;
  shutdown?: (vm: string) => Reply;
  delete?: (vm: string) => Reply | undefined;
  suspend?: (vm: string) => void;
  print?: (vm: string) => Reply | undefined;
  get?: (vm: string) => Reply;
}

const programIn = (plistText: string) =>
  [
    ...(
      /<key>ProgramArguments<\/key>\s*<array>(?<program>[\s\S]*?)<\/array>/u.exec(
        plistText
      )?.groups?.["program"] ?? ""
    ).matchAll(/<string>(?<text>.*?)<\/string>/gu),
  ].map(({ groups }) =>
    (groups?.["text"] ?? "")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
  );

const scriptedMac = (stateDir: string) => {
  const vms = new Map<string, "running" | "stopped" | "suspended">();
  const jobs = new Set<string>();
  const programs = new Map<string, readonly string[]>();
  const exited = new Map<string, number>();

  const hooks: Hooks = {};
  const tartHome = path.join(path.dirname(stateDir), "tart");

  const logOf = (vm: string) => path.join(jobsDir(stateDir), `${vm}.log`);

  const startVm = (vm: string) => {
    const dir = path.join(tartHome, "vms", vm);

    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "control.sock"), "");
    vms.set(vm, "running");
  };

  const tart = (args: readonly string[]): Reply | undefined => {
    const [command = "", ...rest] = args;
    const vm = rest[0] ?? "";

    switch (command) {
      case "--version": {
        return { stdout: "2.41.1\n" };
      }

      case "list": {
        return (
          hooks.list?.() ?? {
            stdout: JSON.stringify(
              [...vms].map(([Name, State]) => ({
                Source: "local",
                Name,
                Disk: 50,
                Size: 31,
                Accessed: "2026-10-04T12:00:00Z",
                Running: State === "running",
                State,
              }))
            ),
          }
        );
      }

      case "clone": {
        vms.set(rest[1] ?? "", "stopped");

        return undefined;
      }

      case "set": {
        const at = rest.indexOf("--disk-size");
        const size = at === -1 ? 50 : Number(rest[at + 1]);
        const cpu = Number(rest[rest.indexOf("--cpu") + 1]);

        if (cpu === 1) {
          return {
            exitCode: 1,
            stderr:
              "Error: VM should have 2 CPU cores at minimum (requested 1)\n",
          };
        }

        return size < 50
          ? {
              exitCode: 1,
              stderr: `new disk size of ${size} GB should be larger than the current disk size of 50 GB\n`,
            }
          : undefined;
      }

      case "get": {
        return (
          hooks.get?.(vm) ?? {
            stdout: JSON.stringify({ CPU: 4, Memory: 8192, Disk: 65 }),
          }
        );
      }

      case "exec": {
        if (vm === "-i") {
          return { exitCode: 0, stdout: "ran\n" };
        }

        if (vms.get(vm) !== "running") {
          return { exitCode: 2, stderr: `Error: VM "${vm}" is not running\n` };
        }

        if (rest.includes("/sbin/shutdown")) {
          if (hooks.shutdown !== undefined) {
            return hooks.shutdown(vm);
          }

          vms.set(vm, "stopped");

          return undefined;
        }

        return hooks.probe?.(vm);
      }

      case "stop": {
        const target = rest.at(-1) ?? "";

        if (vms.get(target) === "suspended" && !rest.includes("--timeout")) {
          vms.set(target, "stopped");

          return undefined;
        }

        if (vms.get(target) !== "running") {
          return { exitCode: 2 };
        }

        vms.set(target, "stopped");

        return undefined;
      }

      case "suspend": {
        if (vms.get(vm) !== "running") {
          return { exitCode: 2, stderr: `VM "${vm}" is not running\n` };
        }

        if (hooks.suspend === undefined) {
          appendFileSync(
            logOf(vm),
            "pausing VM to take a snapshot...\ncreating a snapshot...\nsnapshot created successfully! shutting down the VM...\n"
          );
          vms.set(vm, "suspended");
        } else {
          hooks.suspend(vm);
        }

        exited.set(vm, 0);

        return undefined;
      }

      case "delete": {
        if (hooks.delete !== undefined) {
          return hooks.delete(vm);
        }

        if (!vms.has(vm)) {
          return {
            exitCode: 2,
            stderr: `the specified VM "${vm}" does not exist\n`,
          };
        }

        if (vms.get(vm) === "running") {
          return { exitCode: 1, stderr: `VM "${vm}" is running\n` };
        }

        vms.delete(vm);

        return undefined;
      }

      default: {
        return undefined;
      }
    }
  };

  const launchd = (args: readonly string[]): Reply | undefined => {
    const [command = "", target = ""] = args;
    const label = target.split("/").at(-1) ?? "";

    switch (command) {
      case "print": {
        if (hooks.print?.(label) !== undefined) {
          return hooks.print(label);
        }

        if (!jobs.has(label)) {
          return {
            exitCode: 113,
            stderr: `Could not find service "${label}" in domain\n`,
          };
        }

        {
          const argv = programs.get(label) ?? [];
          const shown = `\tprogram = ${argv[0] ?? ""}\n\targuments = {\n${argv.map((arg) => `\t\t${arg}\n`).join("")}\t}\n`;

          return {
            stdout:
              vms.get(label) === "running" || !exited.has(label)
                ? `${target} = {\n\tstate = running\n${shown}\tlast exit code = (never exited)\n}\n`
                : `${target} = {\n\tstate = not running\n${shown}\tlast exit code = ${exited.get(label)}\n\tjob state = exited\n}\n`,
          };
        }
      }

      case "bootstrap": {
        const file = args[2] ?? "";

        jobs.add(path.basename(file, ".plist"));
        programs.set(
          path.basename(file, ".plist"),
          programIn(readFileSync(file, "utf-8"))
        );

        return undefined;
      }

      case "kickstart": {
        if (hooks.kickstart === undefined) {
          startVm(label);
        } else {
          hooks.kickstart(label);
        }

        return undefined;
      }

      case "bootout": {
        programs.delete(label);

        return jobs.delete(label)
          ? undefined
          : { exitCode: 3, stderr: "Boot-out failed: 3\n" };
      }

      default: {
        return undefined;
      }
    }
  };

  const spawner = scripted((call: Call): Reply | undefined => {
    switch (call.file) {
      case binary: {
        return tart(call.args);
      }

      case launchctl: {
        return launchd(call.args);
      }

      default: {
        return undefined;
      }
    }
  });

  const settings: Settings = {
    binary,
    publishAddress: "127.0.0.1",
    hostId: "mac",
    stateDir,
    uid: 501,
    tartHome,
  };

  return {
    vms,
    jobs,
    programs,
    exited,
    hooks,
    spawner,
    settings,
    logOf,
    startVm,
  };
};

type ScriptedMac = ReturnType<typeof scriptedMac>;

const runtimeOn = (options?: { readonly settings?: Partial<Settings> }) =>
  Effect.gen(function* () {
    const mac = scriptedMac(path.join(yield* scratch, "state"));

    const runtime: Interface = yield* make({
      ...mac.settings,
      ...options?.settings,
    }).pipe(Effect.provide(mac.spawner.layer));

    yield* runtime.startup;

    return { mac, runtime };
  });

const calls = (mac: ScriptedMac) =>
  mac.spawner.calls
    .slice(1)
    .map((call) =>
      [
        call.file === binary ? "tart" : path.basename(call.file),
        ...call.args,
      ].join(" ")
    )
    .filter((line) => !line.startsWith("tart list"));

const vmOf = (machine: MachineRef) => machineName("mac", machine);

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it("native names carry the host ID, the kind and the instance, and disk sizes round up to GB", () => {
    const ref = { name: "dev", instance: "0123456789abcdef0123456789abcdef" };

    expect(machineName("mac", ref)).toBe("cbx-mac-m-dev-01234567");
    expect(checkpointName("mac", ref)).toBe("cbx-mac-c-dev-01234567");
    expect([diskGb(1), diskGb(46), diskGb(47), diskGb(50)]).toStrictEqual([
      2, 50, 51, 54,
    ]);
    expect([
      stateOf("running"),
      stateOf("suspended"),
      stateOf("stopped"),
    ]).toStrictEqual(["running", "paused", "stopped"]);
  });

  it.effect(
    "Tart 2.41.1 or later is required, and an older one is refused at startup",
    () =>
      Effect.gen(function* () {
        expect(
          ["2.41.1", "2.41.2", "2.42.0", "2.100.0", "10.0.0"].map(supported)
        ).toStrictEqual([true, true, true, true, true]);
        expect(
          ["2.41.0", "2.40.1", "2.39.9", "2.9.0", "1.99.0"].map(supported)
        ).toStrictEqual([false, false, false, false, false]);
        expect(
          ["2.41", "2.41.1-rc1", "v2.41.1", "dev", ""].map(supported)
        ).toStrictEqual([false, false, false, false, false]);

        const mac = scriptedMac(path.join(yield* scratch, "state"));

        const old = scripted((call) =>
          call.args[0] === "--version" ? { stdout: "2.38.0\n" } : undefined
        );

        const error = yield* Effect.scoped(make(mac.settings)).pipe(
          Effect.flip,
          Effect.provide(Layer.merge(NodeServices.layer, old.layer))
        );

        expect(error._tag).toBe("CannotStart");
        expect(error.message).toBe(
          `${binary} reports version "2.38.0", and this host needs Tart 2.41.1 or later`
        );
      })
  );

  it.effect(
    "every tart call runs the configured binary in the environment the VM jobs get",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();

        expect(runtime.version).toBe("2.41.1");
        expect(runtime.pin).toBeUndefined();
        expect(runtime.admission?.stopBoots).toBe(false);

        for (const call of mac.spawner.calls) {
          expect(call.file).toBe(binary);
          expect(call.env).toStrictEqual({
            PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: homedir(),
            TART_HOME: mac.settings.tartHome,
          });
        }

        expect(environment({ tartHome: undefined })).toStrictEqual({
          PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: homedir(),
          TART_HOME: undefined,
        });
      })
  );

  it.effect(
    "create writes the VM's job, clones the base with a new serial and the sizes, then boots it",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);
        const image = "ghcr.io/cirruslabs/macos-golden-gate-xcode@sha256:d764";

        yield* runtime.create(machine, image);

        expect(calls(mac)).toStrictEqual([
          `tart clone ${image} ${vm}`,
          `tart set ${vm} --random-serial --cpu 4 --memory 8192 --disk-size 65`,
          `launchctl print gui/501/${vm}`,
          `launchctl bootstrap gui/501 ${path.join(jobsDir(mac.settings.stateDir), `${vm}.plist`)}`,
          `launchctl kickstart gui/501/${vm}`,
          `tart exec ${vm} true`,
        ]);

        const log = path.join(jobsDir(mac.settings.stateDir), `${vm}.log`);

        expect(
          yield* read(path.join(jobsDir(mac.settings.stateDir), `${vm}.plist`))
        ).toBe(
          plist({
            label: vm,
            program: [
              binary,
              "run",
              "--no-graphics",
              "--net-softnet-block=@host",
              "--suspendable",
              vm,
            ],
            environment: environment(mac.settings),
            log,
          })
        );
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "running"]])
        );
      })
  );

  it("a job plist names only tart, never restarts, and escapes what it holds", () => {
    expect(
      plist({
        label: "cbx-mac-m-a-01234567",
        program: [
          "/opt/tart & co/tart",
          "run",
          "--no-graphics",
          "cbx-mac-m-a-01234567",
        ],
        environment: {
          PATH: "/usr/bin",
          HOME: "/Users/a<b>",
          TART_HOME: undefined,
        },
        log: "/state/launchd/cbx-mac-m-a-01234567.log",
      })
    ).toBe(
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
        `<plist version="1.0">`,
        `<dict>`,
        `  <key>Label</key>`,
        `  <string>cbx-mac-m-a-01234567</string>`,
        `  <key>ProgramArguments</key>`,
        `  <array>`,
        `    <string>/opt/tart &amp; co/tart</string>`,
        `    <string>run</string>`,
        `    <string>--no-graphics</string>`,
        `    <string>cbx-mac-m-a-01234567</string>`,
        `  </array>`,
        `  <key>EnvironmentVariables</key>`,
        `  <dict>`,
        `    <key>PATH</key>`,
        `    <string>/usr/bin</string>`,
        `    <key>HOME</key>`,
        `    <string>/Users/a&lt;b&gt;</string>`,
        `  </dict>`,
        `  <key>RunAtLoad</key>`,
        `  <false/>`,
        `  <key>KeepAlive</key>`,
        `  <false/>`,
        `  <key>StandardOutPath</key>`,
        `  <string>/state/launchd/cbx-mac-m-a-01234567.log</string>`,
        `  <key>StandardErrorPath</key>`,
        `  <string>/state/launchd/cbx-mac-m-a-01234567.log</string>`,
        `</dict>`,
        `</plist>`,
        ``,
      ].join("\n")
    );
  });

  it.effect(
    "start kickstarts a job launchd holds, without -k, and waits while the guest agent isn't up",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);
        let probes = 0;

        yield* runtime.create(machine, "base");
        mac.vms.set(vm, "stopped");
        mac.hooks.probe = () => {
          probes += 1;

          return probes === 1
            ? { exitCode: 1, stderr: "is the Tart Guest Agent running?\n" }
            : { exitCode: 0 };
        };

        const before = calls(mac).length;

        yield* runtime.start(machine);

        expect(calls(mac).slice(before)).toStrictEqual([
          `launchctl print gui/501/${vm}`,
          `launchctl kickstart gui/501/${vm}`,
          `tart exec ${vm} true`,
          `launchctl print gui/501/${vm}`,
          `tart exec ${vm} true`,
        ]);
      })
  );

  it.effect("start of a running VM boots nothing", () =>
    Effect.gen(function* () {
      const { mac, runtime } = yield* runtimeOn();
      const machine = machineOn("dev");

      mac.vms.set(vmOf(machine), "running");

      yield* runtime.start(machine);

      expect(calls(mac)).toStrictEqual([]);
    })
  );

  it.effect(
    "start of a VM Tart no longer has is refused before anything is written: no job, no log",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);
        const dir = jobsDir(mac.settings.stateDir);

        const error = yield* Effect.flip(runtime.start(machine));

        expect(failure(error)).toStrictEqual([
          "Missing",
          "machine dev is missing from the mac runtime; delete it",
        ]);
        expect(calls(mac)).toStrictEqual([]);
        expect([
          existsSync(path.join(dir, `${vm}.plist`)),
          existsSync(path.join(dir, `${vm}.log`)),
        ]).toStrictEqual([false, false]);
      })
  );

  it.effect(
    "after a reboot, start bootstraps the job again from its plist",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        mac.jobs.clear();
        mac.vms.set(vm, "stopped");

        const before = calls(mac).length;

        yield* runtime.start(machine);

        expect(calls(mac).slice(before)).toStrictEqual([
          `launchctl print gui/501/${vm}`,
          `launchctl bootstrap gui/501 ${path.join(jobsDir(mac.settings.stateDir), `${vm}.plist`)}`,
          `launchctl kickstart gui/501/${vm}`,
          `tart exec ${vm} true`,
        ]);
      })
  );

  it.effect(
    "Apple's refusal of a third VM, read from the job's log, is Capacity",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("third");
        const vm = vmOf(machine);
        const log = path.join(jobsDir(mac.settings.stateDir), `${vm}.log`);

        mac.hooks.kickstart = (label) => {
          mac.exited.set(label, 1);
          writeFileSync(
            log,
            "The number of VMs exceeds the system limit (other running VMs: a1, a2)\n"
          );
        };

        const error = yield* Effect.flip(runtime.create(machine, "base"));

        expect(error._tag).toBe("Capacity");
        expect(error.message).toBe(
          "Apple's limit of 2 running macOS VMs per Mac refused third: The number of VMs exceeds the system limit (other running VMs: a1, a2)"
        );
      })
  );

  it.effect(
    "a job that exits for another reason fails the boot with its exit code and log",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);
        const log = path.join(jobsDir(mac.settings.stateDir), `${vm}.log`);

        yield* write(log, "an earlier boot's output\n");
        mac.hooks.kickstart = (label) => {
          mac.exited.set(label, 1);
          writeFileSync(log, "Softnet failed: softnet not found in PATH\n", {
            flag: "a",
          });
        };

        const error = yield* Effect.flip(runtime.create(machine, "base"));

        expect(error._tag).toBe("Internal");
        expect(error.message).toBe(
          "tart run for dev exited 1: Softnet failed: softnet not found in PATH"
        );
      })
  );

  it.effect(
    "a boot whose guest agent never answers leaves its VM running",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        const probed = Promise.withResolvers<undefined>();

        mac.hooks.probe = () => {
          probed.resolve(undefined);

          return { exitCode: 1, stderr: "is the Tart Guest Agent running?\n" };
        };

        const creating = Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.flip(runtime.create(machine, "base"))
          );

          yield* Effect.promise(async () => {
            await probed.promise;
          });

          while (fiber.pollUnsafe() === undefined) {
            yield* TestClock.adjust(Duration.seconds(1));
          }

          return yield* Fiber.join(fiber);
        });

        const error = yield* creating.pipe(Effect.provide(TestClock.layer()));

        expect(error.message).toBe(
          "dev's guest agent didn't answer tart exec within 3m of its start"
        );
        expect(
          calls(mac).filter((line) => line.includes("stop"))
        ).toStrictEqual([]);
        expect(mac.vms.get(vm)).toBe("running");
      })
  );

  it.effect(
    "a diskGib below the base's disk is Unsizable at tart set, after the clone, and nothing boots",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = { ...machineOn("small"), diskGib: 20 };
        const vm = vmOf(machine);

        const error = yield* Effect.flip(runtime.create(machine, "base"));

        expect([error._tag, error.message]).toStrictEqual([
          "Unsizable",
          "machine small's disk of 20G is below the disk Tart holds for it, and Tart only grows a disk: new disk size of 22 GB should be larger than the current disk size of 50 GB",
        ]);
        expect(calls(mac)).toStrictEqual([
          `tart clone base ${vm}`,
          `tart set ${vm} --random-serial --cpu 4 --memory 8192 --disk-size 22`,
        ]);
        expect(mac.vms.get(vm)).toBe("stopped");
      })
  );

  it.effect(
    "start writes the job again, so a job file that's gone or names an older tart is replaced",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [gone, stale] = [machineOn("gone"), machineOn("stale")];

        const file = (machine: MachineRef) =>
          path.join(jobsDir(mac.settings.stateDir), `${vmOf(machine)}.plist`);

        yield* write(
          file(stale),
          "names /opt/tart/2.40.0/tart.app/Contents/MacOS/tart\n"
        );

        for (const machine of [gone, stale]) {
          mac.vms.set(vmOf(machine), "stopped");
          yield* runtime.start(machine);

          expect(yield* read(file(machine))).toBe(
            plist({
              label: vmOf(machine),
              program: [
                binary,
                "run",
                "--no-graphics",
                "--net-softnet-block=@host",
                "--suspendable",
                vmOf(machine),
              ],
              environment: environment(mac.settings),
              log: path.join(
                jobsDir(mac.settings.stateDir),
                `${vmOf(machine)}.log`
              ),
            })
          );
          expect(mac.vms.get(vmOf(machine))).toBe("running");
        }
      })
  );

  it.effect(
    "start reloads a stopped job launchd holds that runs other arguments, and only kickstarts one that runs this host's",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [current, older] = [machineOn("current"), machineOn("older")];

        const plistOf = (vm: string) =>
          path.join(jobsDir(mac.settings.stateDir), `${vm}.plist`);

        for (const machine of [current, older]) {
          yield* runtime.create(machine, "base");
          yield* runtime.stop(machine);
          mac.exited.set(vmOf(machine), 0);
        }

        mac.programs.set(vmOf(older), [
          binary,
          "run",
          "--no-graphics",
          "--net-softnet-block=@host",
          vmOf(older),
        ]);

        const ran = [];

        for (const machine of [current, older]) {
          const before = calls(mac).length;

          yield* runtime.start(machine);
          ran.push(calls(mac).slice(before));
        }

        expect(ran).toStrictEqual([
          [
            `launchctl print gui/501/${vmOf(current)}`,
            `launchctl kickstart gui/501/${vmOf(current)}`,
            `tart exec ${vmOf(current)} true`,
          ],
          [
            `launchctl print gui/501/${vmOf(older)}`,
            `launchctl bootout gui/501/${vmOf(older)}`,
            `launchctl bootstrap gui/501 ${plistOf(vmOf(older))}`,
            `launchctl kickstart gui/501/${vmOf(older)}`,
            `tart exec ${vmOf(older)} true`,
          ],
        ]);
        expect(mac.programs.get(vmOf(older))).toStrictEqual([
          binary,
          "run",
          "--no-graphics",
          "--net-softnet-block=@host",
          "--suspendable",
          vmOf(older),
        ]);
      })
  );

  it.effect(
    "the two-VM count takes every running VM, the operator's too, and machines actions are booting",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [a, b, c] = [machineOn("a"), machineOn("b"), machineOn("c")];

        mac.vms.set("operators-own", "running");
        mac.vms.set(vmOf(a), "running");
        mac.vms.set(vmOf(b), "stopped");

        const refused = yield* Effect.flip(
          admitOn(runtime)({
            action: "startMachine",
            machine: b,
            machines: [
              { machine: a, booting: false },
              { machine: b, booting: true },
            ],
          })
        );

        expect(refused._tag).toBe("Capacity");
        expect(refused.message).toBe(
          `startMachine b would run 3 macOS VMs on this Mac, and Apple allows 2: ${[vmOf(a), vmOf(b), "operators-own"].toSorted().join(", ")}`
        );

        mac.vms.delete("operators-own");

        const crowded = yield* Effect.flip(
          admitOn(runtime)({
            action: "startMachine",
            machine: b,
            machines: [
              { machine: a, booting: false },
              { machine: b, booting: true },
              { machine: c, booting: true },
            ],
          })
        );

        expect(crowded._tag).toBe("Capacity");

        yield* admitOn(runtime)({
          action: "startMachine",
          machine: b,
          machines: [
            { machine: a, booting: false },
            { machine: b, booting: true },
          ],
        });
      })
  );

  it.effect(
    "capacity is Apple's two VMs and the VMs admit counts, every running one, the operator's too, and machines being booted, each once; and the cpu and RAM of the host's own",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [a, b, c] = [machineOn("a"), machineOn("b"), machineOn("c")];

        mac.vms.set("operators-own", "running");
        mac.vms.set("operators-stopped", "stopped");
        mac.vms.set(vmOf(a), "running");
        mac.vms.set(vmOf(b), "stopped");

        const before = mac.spawner.calls.length;

        const idle = yield* runtime.capacity([
          { machine: a, booting: false },
          { machine: b, booting: false },
        ]);

        const lists = mac.spawner.calls.slice(before).map(({ args }) => args);

        const booting = yield* runtime.capacity([
          { machine: a, booting: true },
          { machine: b, booting: false },
          { machine: c, booting: true },
        ]);

        expect(lists).toStrictEqual([
          ["list", "--source", "local", "--format", "json"],
        ]);
        expect(idle).toStrictEqual([
          { resource: "runningVms", limit: 2, used: 2 },
          { resource: "cpu", used: 4 },
          { resource: "ramMib", used: 8192 },
        ]);
        expect(booting).toStrictEqual([
          { resource: "runningVms", limit: 2, used: 3 },
          { resource: "cpu", used: 8 },
          { resource: "ramMib", used: 16_384 },
        ]);
      })
  );

  it.effect(
    "the two-VM count takes a running target once: a start of a running machine adds nothing",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const target = machineOn("dev");

        mac.vms.set("operators-own", "running");
        mac.vms.set(vmOf(target), "running");

        yield* admitOn(runtime)({
          action: "startMachine",
          machine: target,
          machines: [{ machine: target, booting: true }],
        });

        mac.vms.set("operators-other", "running");

        const crowded = yield* Effect.flip(
          admitOn(runtime)({
            action: "startMachine",
            machine: target,
            machines: [{ machine: target, booting: true }],
          })
        );

        expect(crowded._tag).toBe("Capacity");
      })
  );

  it.effect(
    "a fork's source and a capture's machine must be stopped: anything else is refused before a clone",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [source, copy] = [machineOn("src"), machineOn("copy")];

        const checkpoint = {
          name: "snap",
          instance: "fedcba9876543210fedcba9876543210",
          port: source.port,
          cpu: 4,
          ramMib: 8192,
          diskGib: 60,
        };

        mac.vms.set(vmOf(source), "running");

        const fork = yield* Effect.flip(runtime.fork(source, copy));
        const capture = yield* Effect.flip(runtime.capture(source, checkpoint));

        mac.vms.set(vmOf(source), "suspended");

        const paused = yield* Effect.flip(runtime.fork(source, copy));

        mac.vms.delete(vmOf(source));

        const missing = yield* Effect.flip(runtime.capture(source, checkpoint));

        expect([fork, capture, paused, missing].map(failure)).toStrictEqual([
          [
            "WrongState",
            "a Tart fork copies a stopped machine's disk, and src is running: stop it first",
          ],
          [
            "WrongState",
            "a Tart checkpoint copies a stopped machine's disk, and src is running: stop it first",
          ],
          [
            "WrongState",
            "a Tart fork copies a stopped machine's disk, and src is paused: stop it first",
          ],
          ["Missing", "machine src is missing from the mac runtime; delete it"],
        ]);
        expect(calls(mac)).toStrictEqual([]);
        expect(
          existsSync(
            path.join(jobsDir(mac.settings.stateDir), `${vmOf(copy)}.plist`)
          )
        ).toBe(false);
      })
  );

  it.effect(
    "a create's tart set waits for a tart list under way, and so does a resize's, as the list opens every VM's disk",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        const listHeld = () =>
          Effect.gen(function* () {
            const release = yield* Deferred.make<undefined>();
            const listed = yield* Deferred.make<undefined>();

            mac.hooks.list = () => {
              delete mac.hooks.list;
              Deferred.doneUnsafe(listed, Exit.succeed(undefined));

              return { stdout: "[]", until: Deferred.await(release) };
            };

            const reading = yield* Effect.forkChild(runtime.observe([machine]));

            yield* Deferred.await(listed);

            return {
              reading,
              release: Deferred.succeed(release, undefined),
            };
          });

        const settingWhileListed = (work: Effect.Effect<unknown, HostError>) =>
          Effect.gen(function* () {
            const { reading, release } = yield* listHeld();
            const before = calls(mac).length;
            const working = yield* Effect.forkChild(work);

            yield* Effect.sleep(Duration.millis(300));

            const during = calls(mac)
              .slice(before)
              .filter((line) => line.startsWith("tart set"));

            yield* release;
            yield* Fiber.join(reading);
            yield* Fiber.join(working);

            return during;
          });

        const created = yield* settingWhileListed(
          runtime.create(machine, "base")
        );

        yield* runtime.stop(machine);

        const resized = yield* settingWhileListed(
          runtime.resize(machine, { diskGib: 100 }, false)
        );

        expect(created).toStrictEqual([]);
        expect(resized).toStrictEqual([]);
        expect(
          calls(mac).filter((line) => line.startsWith("tart set"))
        ).toStrictEqual([
          `tart set ${vm} --random-serial --cpu 4 --memory 8192 --disk-size ${diskGb(60)}`,
          `tart set ${vm} --disk-size ${diskGb(100)}`,
        ]);
      })
  );

  it.effect(
    "a tart list and a tart get wait while a VM boots, until its run has started it or exited",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);
        const kicked = yield* Deferred.make<undefined>();

        mac.hooks.kickstart = (label) => {
          mac.vms.set(label, "running");
          Deferred.doneUnsafe(kicked, Exit.succeed(undefined));
        };

        const creating = yield* Effect.forkChild(
          runtime.create(machine, "base")
        );

        yield* Deferred.await(kicked);

        const listsBefore = mac.spawner.calls.length;

        const reading = yield* Effect.forkChild(
          Effect.all([runtime.observe([machine]), runtime.sizes(machine)], {
            concurrency: "unbounded",
          })
        );

        yield* Effect.sleep(Duration.millis(300));

        const during = mac.spawner.calls
          .slice(listsBefore)
          .map(({ args }) => args[0])
          .filter((command) => command === "list" || command === "get");

        mac.startVm(vm);

        const [observed] = yield* Fiber.join(reading);

        yield* Fiber.join(creating);

        mac.hooks.kickstart = (label) => {
          mac.exited.set(label, 1);
        };

        mac.vms.set(vm, "stopped");

        const failed = yield* Effect.flip(runtime.start(machine));
        const afterExit = yield* runtime.observe([machine]);

        expect(during).toStrictEqual([]);
        expect(observed).toStrictEqual(new Map([["dev", "running"]]));
        expect(failed._tag).toBe("Internal");
        expect(afterExit).toStrictEqual(new Map([["dev", "stopped"]]));
      })
  );

  it("a disk's size in GB, as tart get reads it, gives back the GiB a create or resize asked for", () => {
    const sizes = Array.from({ length: 4096 }, (_, at) => at + 1);

    expect(sizes.filter((gib) => diskGibOf(diskGb(gib)) !== gib)).toStrictEqual(
      []
    );
  });

  it.effect(
    "a resize sets the vCPUs, memory and disk it is asked, and a size below Tart's least is Unsizable",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        mac.vms.set(vm, "stopped");

        yield* runtime.resize(machine, { cpu: 2, ramMib: 4096 }, false);
        yield* runtime.resize(machine, { diskGib: 100 }, false);
        yield* runtime.resize(machine, {}, false);

        const least = yield* Effect.flip(
          runtime.resize(machine, { cpu: 1 }, false)
        );

        expect(calls(mac)).toStrictEqual([
          `tart set ${vm} --cpu 2 --memory 4096`,
          `tart set ${vm} --disk-size 108`,
          `tart set ${vm} --cpu 1`,
        ]);
        expect(failure(least)).toStrictEqual([
          "Unsizable",
          "machine dev's 1 vCPUs and 8G are below what its guest takes: Error: VM should have 2 CPU cores at minimum (requested 1)",
        ]);
      })
  );

  it.effect(
    "vCPUs or a disk past what tart set parses are Unsizable before anything native",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");

        const refused = [
          yield* Effect.flip(
            runtime.sizable(
              machine,
              machine,
              { ...machine, cpu: 65_536 },
              false
            )
          ),
          yield* Effect.flip(
            runtime.sizable(
              machine,
              machine,
              { ...machine, diskGib: 61_035 },
              false
            )
          ),
        ];

        yield* runtime.sizable(
          machine,
          machine,
          { ...machine, cpu: 65_535, diskGib: 61_034 },
          false
        );

        expect(refused.map(failure)).toStrictEqual([
          [
            "Unsizable",
            "tart set takes at most 65535 vCPUs and 65535 GB of disk, and dev would have 65536 vCPUs and 65 GB",
          ],
          [
            "Unsizable",
            "tart set takes at most 65535 vCPUs and 65535 GB of disk, and dev would have 4 vCPUs and 65536 GB",
          ],
        ]);
        expect(calls(mac)).toStrictEqual([]);
      })
  );

  it.effect(
    "sizes reads tart get, its disk in GiB, leaving the disk out where Tart can't tell it",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        let disk: number | null = diskGb(100);

        mac.hooks.get = () => ({
          stdout: JSON.stringify({ CPU: 2, Memory: 4096, Disk: disk }),
        });

        const known = yield* runtime.sizes(machine);

        disk = null;

        const unread = yield* runtime.sizes(machine);

        mac.hooks.get = () => ({
          exitCode: 1,
          stderr: "Error: VM not found\n",
        });

        const failed = yield* Effect.flip(runtime.sizes(machine));

        expect(known).toStrictEqual({ cpu: 2, ramMib: 4096, diskGib: 100 });
        expect(unread).toStrictEqual({
          cpu: 2,
          ramMib: 4096,
          diskGib: undefined,
        });
        expect(failed._tag).toBe("Internal");
        expect(calls(mac)[0]).toBe(`tart get ${vmOf(machine)} --format json`);
      })
  );

  it.effect(
    "a fork counts only the copy as booting, not its stopped source",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [source, copy] = [machineOn("src"), machineOn("copy")];

        const forking = {
          action: "forkMachine" as const,
          machine: copy,
          machines: [
            { machine: source, booting: false },
            { machine: copy, booting: true },
          ],
        };

        mac.vms.set(vmOf(source), "stopped");
        mac.vms.set("operators-own", "running");
        yield* admitOn(runtime)(forking);

        mac.vms.set("operators-other", "running");

        expect((yield* Effect.flip(admitOn(runtime)(forking)))._tag).toBe(
          "Capacity"
        );
      })
  );

  it.effect(
    "capture clones the machine to the checkpoint's name; fork and restore clone into the new machine",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();

        const [source, forked, restored] = [
          machineOn("src"),
          machineOn("forked"),
          machineOn("restored"),
        ];

        const checkpoint = {
          name: "snap",
          instance: "fedcba9876543210fedcba9876543210",
          port: source.port,
          cpu: 4,
          ramMib: 8192,
          diskGib: 60,
        };

        const snap = checkpointName("mac", checkpoint);

        mac.vms.set(vmOf(source), "stopped");
        yield* runtime.capture(source, checkpoint);
        yield* runtime.fork(source, forked);
        yield* runtime.restore(checkpoint, restored);
        yield* runtime.deleteCheckpoint(checkpoint);
        yield* runtime.deleteCheckpoint(checkpoint);

        expect(
          calls(mac).filter((line) => line.startsWith("tart"))
        ).toStrictEqual([
          `tart clone ${vmOf(source)} ${snap}`,
          `tart clone ${vmOf(source)} ${vmOf(forked)}`,
          `tart set ${vmOf(forked)} --random-serial`,
          `tart exec ${vmOf(forked)} true`,
          `tart clone ${snap} ${vmOf(restored)}`,
          `tart set ${vmOf(restored)} --random-serial`,
          `tart exec ${vmOf(restored)} true`,
          `tart delete ${snap}`,
          `tart delete ${snap}`,
        ]);
        expect(mac.vms.has(snap)).toBe(false);
      })
  );

  it.effect(
    "a fork or restore sets the copy's sizes that differ from its source's",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const source = machineOn("src");

        const forked = {
          ...machineOn("forked"),
          cpu: 6,
          ramMib: 16_384,
          diskGib: 100,
        };

        const restored = { ...machineOn("restored"), cpu: 2, ramMib: 4096 };

        const checkpoint = {
          name: "snap",
          instance: "fedcba9876543210fedcba9876543210",
          port: source.port,
          cpu: 4,
          ramMib: 8192,
          diskGib: 60,
        };

        mac.vms.set(vmOf(source), "stopped");
        mac.vms.set(checkpointName("mac", checkpoint), "stopped");
        yield* runtime.fork(source, forked);
        yield* runtime.restore(checkpoint, restored);

        expect(
          calls(mac).filter((line) => line.startsWith("tart set"))
        ).toStrictEqual([
          `tart set ${vmOf(forked)} --random-serial --cpu 6 --memory 16384 --disk-size 108`,
          `tart set ${vmOf(restored)} --random-serial --cpu 2 --memory 4096`,
        ]);
      })
  );

  it.effect(
    "stop shuts the guest down from inside and waits for its VM to stop",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");

        const before = calls(mac).length;

        yield* runtime.stop(machine);

        expect(calls(mac).slice(before)).toStrictEqual([
          `tart exec ${vm} sudo -n /sbin/shutdown -h now`,
        ]);
        expect(mac.vms.get(vm)).toBe("stopped");
      })
  );

  it.effect(
    "stop of a stopped VM, or one Tart no longer has, reads its state and does nothing",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [stopped, gone] = [machineOn("down"), machineOn("gone")];

        mac.vms.set(vmOf(stopped), "stopped");

        const before = mac.spawner.calls.length;

        yield* runtime.stop(stopped);
        yield* runtime.stop(gone);

        expect(
          mac.spawner.calls.slice(before).map(({ args }) => args[0])
        ).toStrictEqual(["list", "list"]);
      })
  );

  it.effect(
    "a guest that doesn't shut down within a minute is forced off",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        mac.hooks.shutdown = () => ({ exitCode: 0, stdout: "Shutdown NOW!\n" });

        const stopping = Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(runtime.stop(machine));

          while (fiber.pollUnsafe() === undefined) {
            yield* TestClock.adjust(Duration.millis(500));
          }

          return yield* Fiber.join(fiber);
        });

        yield* stopping.pipe(Effect.provide(TestClock.layer()));

        expect(
          calls(mac)
            .filter((line) => !line.startsWith("launchctl"))
            .slice(-2)
        ).toStrictEqual([
          `tart exec ${vm} sudo -n /sbin/shutdown -h now`,
          `tart stop --timeout 0 ${vm}`,
        ]);
        expect(mac.vms.get(vm)).toBe("stopped");
      })
  );

  it.effect(
    "a stop cut short once it told the guest to shut down still waits for its VM to stop",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);
        const shutdown = `tart exec ${vm} sudo -n /sbin/shutdown -h now`;

        yield* runtime.create(machine, "base");
        mac.hooks.shutdown = () => ({ exitCode: 0, stdout: "Shutdown NOW!\n" });

        const cutShort = Effect.gen(function* () {
          const stopping = yield* Effect.forkChild(runtime.stop(machine));

          while (!calls(mac).includes(shutdown)) {
            yield* Effect.yieldNow;
          }

          const interrupting = yield* Effect.forkChild(
            Fiber.interrupt(stopping)
          );

          yield* TestClock.adjust(Duration.seconds(5));
          yield* Effect.yieldNow;

          const whileHalting = interrupting.pollUnsafe();

          mac.vms.set(vm, "stopped");

          while (interrupting.pollUnsafe() === undefined) {
            yield* TestClock.adjust(Duration.millis(500));
          }

          return whileHalting;
        });

        expect(
          yield* cutShort.pipe(Effect.provide(TestClock.layer()))
        ).toBeUndefined();
        expect(calls(mac)).not.toContain(`tart stop --timeout 0 ${vm}`);
      })
  );

  it.effect(
    "delete forces a running VM off, then removes it, its job, plist and log",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);
        const dir = jobsDir(mac.settings.stateDir);

        yield* runtime.create(machine, "base");

        const before = calls(mac).length;

        yield* runtime.delete(machine);

        expect(calls(mac).slice(before)).toStrictEqual([
          `tart delete ${vm}`,
          `tart stop --timeout 0 ${vm}`,
          `tart delete ${vm}`,
          `launchctl bootout gui/501/${vm}`,
        ]);
        expect([mac.vms.has(vm), mac.jobs.has(vm)]).toStrictEqual([
          false,
          false,
        ]);
        expect([
          existsSync(path.join(dir, `${vm}.plist`)),
          existsSync(path.join(dir, `${vm}.log`)),
        ]).toStrictEqual([false, false]);
      })
  );

  it.effect(
    "delete after a crash before the clone finds nothing native, and succeeds",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.delete(machine);

        expect(calls(mac)).toStrictEqual([
          `tart delete ${vm}`,
          `launchctl bootout gui/501/${vm}`,
        ]);
      })
  );

  it.effect(
    "delete fails, keeping the job, when Tart can't delete the VM",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        yield* runtime.stop(machine);
        mac.hooks.delete = () => ({
          exitCode: 1,
          stderr: "Error: permission denied\n",
        });

        const before = calls(mac).length;
        const error = yield* Effect.flip(runtime.delete(machine));

        expect(error._tag).toBe("Internal");
        expect(error.message).toBe(
          `tart delete ${vm} exited 1: Error: permission denied`
        );
        expect(calls(mac).slice(before)).toStrictEqual([
          `tart delete ${vm}`,
          `tart stop --timeout 0 ${vm}`,
          `tart delete ${vm}`,
        ]);
        expect(mac.jobs.has(vm)).toBe(true);
      })
  );

  it.effect(
    "exec runs the command as root through sudo -n, with its stdin",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");

        const [output, exitCode] = yield* Effect.scoped(
          Effect.flatMap(
            runtime.exec(machine, {
              argv: ["/bin/sh", "-c", "cat >/dev/null"],
              stdin: new TextEncoder().encode("the input"),
            }),
            (execution) =>
              Effect.all([
                Stream.mkString(Stream.decodeText(execution.output)),
                execution.exitCode,
              ])
          )
        );

        expect([output, exitCode]).toStrictEqual(["ran\n", 0]);
        expect(mac.spawner.calls.at(-1)).toMatchObject({
          file: binary,
          args: [
            "exec",
            "-i",
            vmOf(machine),
            "sudo",
            "-n",
            "--",
            "/bin/sh",
            "-c",
            "cat >/dev/null",
          ],
          stdin: "the input",
        });
      })
  );

  it.effect(
    "exec runs the command as the user it names through sudo -n -u, with its HOME",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");

        yield* Effect.scoped(
          Effect.flatMap(
            runtime.exec(machine, { argv: ["true"], user: "admin" }),
            (execution) => execution.exitCode
          )
        );

        expect(mac.spawner.calls.at(-1)?.args).toStrictEqual([
          "exec",
          "-i",
          vmOf(machine),
          "sudo",
          "-n",
          "-u",
          "admin",
          "-H",
          "--",
          "true",
        ]);
      })
  );

  it.effect(
    "startup removes what a fetch staged and never installed, and leaves the VMs",
    () =>
      Effect.gen(function* () {
        const tartHome = yield* scratch;

        const staged = path.join(
          tartHome,
          "cbx-fetching",
          "cbx-mac-c-web-01234567"
        );

        const kept = path.join(tartHome, "vms", "cbx-mac-c-dev-01234567");

        yield* mkdir(staged);
        yield* write(path.join(staged, "disk.img"), "half a disk");
        yield* mkdir(kept);
        yield* write(path.join(kept, "disk.img"), "a whole disk");

        yield* runtimeOn({ settings: { tartHome } });

        expect(existsSync(path.join(tartHome, "cbx-fetching"))).toBe(false);
        expect(yield* read(path.join(kept, "disk.img"))).toBe("a whole disk");
      })
  );

  it.effect("startup makes the jobs dir", () =>
    Effect.gen(function* () {
      const { mac, runtime } = yield* runtimeOn();

      yield* runtime.startup;

      expect(existsSync(jobsDir(mac.settings.stateDir))).toBe(true);
    })
  );

  it.effect("observe reads every machine's state with one tart list", () =>
    Effect.gen(function* () {
      const { mac, runtime } = yield* runtimeOn();

      const [up, paused, gone] = [
        machineOn("up"),
        machineOn("paused"),
        machineOn("gone"),
      ];

      mac.vms.set(vmOf(up), "running");
      mac.vms.set(vmOf(paused), "suspended");

      const before = mac.spawner.calls.length;
      const observed = yield* runtime.observe([up, paused, gone]);

      expect(observed).toStrictEqual(
        new Map([
          [up.name, "running"],
          [paused.name, "paused"],
          [gone.name, "missing"],
        ])
      );
      expect(
        mac.spawner.calls.slice(before).map(({ args }) => args)
      ).toStrictEqual([["list", "--source", "local", "--format", "json"]]);
    })
  );

  it.effect(
    "pause suspends a VM its job runs suspendable, and waits for Tart to save it",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");

        const before = calls(mac).length;

        yield* runtime.pause(machine);

        expect(calls(mac).slice(before)).toStrictEqual([
          `launchctl print gui/501/${vm}`,
          `tart suspend ${vm}`,
        ]);
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "paused"]])
        );
      })
  );

  it.effect(
    "pause shuts down a VM whose job an older host loaded without --suspendable, which Tart would power off",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        mac.programs.set(vm, [
          binary,
          "run",
          "--no-graphics",
          "--net-softnet-block=@host",
          vm,
        ]);

        const before = calls(mac).length;

        yield* runtime.pause(machine);

        expect(calls(mac).slice(before)).toStrictEqual([
          `launchctl print gui/501/${vm}`,
          `tart exec ${vm} sudo -n /sbin/shutdown -h now`,
        ]);
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "stopped"]])
        );
      })
  );

  it.effect(
    "pause refuses, signalling nothing, when launchctl print's arguments can't be read",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        mac.hooks.print = () => ({
          stdout: "gui/501/job = {\n\tstate = running\n}\n",
        });

        const error = yield* Effect.flip(runtime.pause(machine));

        expect(failure(error)[0]).toBe("Internal");
        expect(failure(error)[1]).toContain(
          "couldn't read the arguments in launchctl print"
        );
        expect(calls(mac)).not.toContain(`tart suspend ${vm}`);
      })
  );

  it.effect(
    "a suspend whose save fails has tart stop remove what it left of the state, and fails, as Tart powered the VM off",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        mac.hooks.suspend = (label) => {
          appendFileSync(
            mac.logOf(label),
            "creating a snapshot...\nFailed to suspend the VM: The virtual machine failed to save with error “permission denied”.\n"
          );
          mac.vms.set(label, "suspended");
        };

        const error = yield* Effect.flip(runtime.pause(machine));

        expect(failure(error)).toStrictEqual([
          "Internal",
          "Tart couldn't save dev's state and powered its VM off, as it does when the first save on a Mac runs while its session is locked: creating a snapshot...\nFailed to suspend the VM: The virtual machine failed to save with error “permission denied”.",
        ]);
        expect(calls(mac).slice(-2)).toStrictEqual([
          `tart suspend ${vm}`,
          `tart stop ${vm}`,
        ]);
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "stopped"]])
        );
      })
  );

  it.effect(
    "a suspend whose job log can't be read fails, and keeps what Tart saved",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        mac.hooks.suspend = (label) => {
          rmSync(mac.logOf(label));
          mac.vms.set(label, "suspended");
        };

        const error = yield* Effect.flip(runtime.pause(machine));

        expect(failure(error)[0]).toBe("Internal");
        expect(failure(error)[1]).toContain(`couldn't read ${mac.logOf(vm)}`);
        expect(calls(mac).slice(-1)).toStrictEqual([`tart suspend ${vm}`]);
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "paused"]])
        );
      })
  );

  it.effect(
    "pause of a paused VM does nothing; of a stopped one or one Tart lacks, it refuses",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();

        const [paused, stopped, gone] = [
          machineOn("paused"),
          machineOn("stopped"),
          machineOn("gone"),
        ];

        mac.vms.set(vmOf(paused), "suspended");
        mac.vms.set(vmOf(stopped), "stopped");

        yield* runtime.pause(paused);

        const errors = [
          yield* Effect.flip(runtime.pause(stopped)),
          yield* Effect.flip(runtime.pause(gone)),
        ];

        expect(errors.map(failure)).toStrictEqual([
          [
            "WrongState",
            "Tart reads stopped stopped, and suspends only a running machine",
          ],
          [
            "Missing",
            "machine gone is missing from the mac runtime; delete it",
          ],
        ]);
        expect(calls(mac)).toStrictEqual([]);
      })
  );

  it.effect("start of a paused VM boots its job, which resumes it", () =>
    Effect.gen(function* () {
      const { mac, runtime } = yield* runtimeOn();
      const machine = machineOn("dev");
      const vm = vmOf(machine);

      yield* runtime.create(machine, "base");
      yield* runtime.pause(machine);

      const before = calls(mac).length;

      yield* runtime.start(machine);

      expect(calls(mac).slice(before)).toStrictEqual([
        `launchctl print gui/501/${vm}`,
        `launchctl kickstart gui/501/${vm}`,
        `tart exec ${vm} true`,
      ]);
      expect(yield* runtime.observe([machine])).toStrictEqual(
        new Map([[machine.name, "running"]])
      );
    })
  );

  it.effect(
    "a resume that fails says a locked session refuses it, and the VM stays paused",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");

        yield* runtime.create(machine, "base");
        yield* runtime.pause(machine);
        mac.hooks.kickstart = (label) => {
          mac.exited.set(label, 1);
          appendFileSync(
            mac.logOf(label),
            'restoring VM state from a snapshot...\nError Domain=VZErrorDomain Code=12 "The virtual machine failed to restore with error “permission denied”."\n'
          );
        };

        const error = yield* Effect.flip(runtime.start(machine));

        expect(failure(error)[0]).toBe("Internal");
        expect(failure(error)[1]).toContain(
          "macOS resumes a saved state only while the Mac's session is unlocked, so if it is locked, unlock it and start dev again: a restore that fails keeps the saved state, and a stop discards it"
        );
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "paused"]])
        );
      })
  );

  it.effect(
    "stop of a paused VM discards its saved state with tart stop, booting nothing",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.create(machine, "base");
        yield* runtime.pause(machine);

        const before = calls(mac).length;

        yield* runtime.stop(machine);

        expect(calls(mac).slice(before)).toStrictEqual([`tart stop ${vm}`]);
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "stopped"]])
        );
      })
  );
});
