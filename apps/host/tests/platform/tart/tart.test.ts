import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Step } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { runCommand } from "../../../src/guest.ts";
import { PortProbe } from "../../../src/machine-ports.ts";
import * as Operations from "../../../src/operations.ts";
import * as Relay from "../../../src/platform/relay.ts";
import {
  checkpointName,
  diskGb,
  diskGibOf,
  environment,
  jobsDir,
  machineName,
  make,
  plist,
  supported,
} from "../../../src/platform/tart/tart.ts";
import type { Settings } from "../../../src/platform/tart/tart.ts";
import * as Reach from "../../../src/reach.ts";
import { Runtime } from "../../../src/runtime.ts";
import type {
  Activation,
  Bind,
  Held,
  Identity,
  Interface,
  Origin,
  Sized,
  Sizes,
} from "../../../src/runtime.ts";
import { binary, scriptedMac } from "../../scripted-mac.ts";
import type { ScriptedMac } from "../../scripted-mac.ts";
import { scripted } from "../../scripted.ts";
import { admitOn, eventually, suitePorts } from "../../support.ts";

const failure = (error: HostError) => [error._tag, error.message];

const vmFor = (ref: Identity & Sizes): Sized => ({
  ...ref,
  handle: machineName("mac", ref),
});

const checkpointFor = (ref: Identity & Sizes): Sized => ({
  ...ref,
  handle: checkpointName("mac", ref),
});

const machineOn = (name: string) =>
  vmFor({
    name,
    instance: `${name.length.toString(16).padStart(2, "0")}23456789abcdef0123456789abcdef`,
    cpu: 4,
    ramMib: 8192,
    diskGib: 60,
  });

const unbound: Bind = { _tag: "none" };

const fromImage = (image: string): Origin => ({ _tag: "image", image });

const fromCheckpoint = (checkpoint: Sized): Origin => ({
  _tag: "checkpoint",
  checkpoint,
});

const fromMachine = (source: Sized): Origin => ({
  _tag: "machine",
  machine: source,
});

const snapOf = () =>
  checkpointFor({
    name: "snap",
    instance: "fedcba9876543210fedcba9876543210",
    cpu: 4,
    ramMib: 8192,
    diskGib: 60,
  });

const runtimeOn = (options?: {
  readonly settings?: Partial<Settings>;
  readonly binary?: string;
}) =>
  Effect.gen(function* () {
    const mac = scriptedMac(
      path.join(yield* scratch, "state"),
      options?.binary
    );

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
        call.file === mac.settings.binary ? "tart" : path.basename(call.file),
        ...call.args,
      ].join(" ")
    )
    .filter(
      (line) =>
        !line.startsWith("launchctl print") &&
        !line.startsWith("ps ") &&
        !line.startsWith("perl ")
    );

const vmOf = (machine: Identity) => machineName("mac", machine);

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it("native names carry the host ID, the kind and the instance, and disk sizes round up to GB", () => {
    const ref = { name: "dev", instance: "0123456789abcdef0123456789abcdef" };

    expect(machineName("mac", ref)).toBe("cbx-mac-m-dev-01234567");
    expect(checkpointName("mac", ref)).toBe("cbx-mac-c-dev-01234567");
    expect([diskGb(1), diskGb(46), diskGb(47), diskGb(50)]).toStrictEqual([
      2, 50, 51, 54,
    ]);
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
        expect(runtime.traits.stop).toBe("discards");

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

        yield* runtime.make(machine, fromImage(image), unbound);

        expect(calls(mac)).toStrictEqual([
          `tart clone ${image} ${vm}`,
          `tart set ${vm} --random-serial --cpu 4 --memory 8192 --disk-size 65`,
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

        yield* runtime.make(machine, fromImage("base"), unbound);
        mac.vms.set(vm, "stopped");
        mac.hooks.probe = () => {
          probes += 1;

          return probes === 1
            ? { exitCode: 1, stderr: "is the Tart Guest Agent running?\n" }
            : { exitCode: 0 };
        };

        const before = calls(mac).length;

        yield* runtime.start(machine, new Set());

        expect(calls(mac).slice(before)).toStrictEqual([
          `launchctl kickstart gui/501/${vm}`,
          `tart exec ${vm} true`,
          `tart exec ${vm} true`,
        ]);
      })
  );

  it.effect("start of a running VM boots nothing", () =>
    Effect.gen(function* () {
      const { mac, runtime } = yield* runtimeOn();
      const machine = machineOn("dev");

      mac.vms.set(vmOf(machine), "running");

      yield* runtime.start(machine, new Set());

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

        const error = yield* Effect.flip(runtime.start(machine, new Set()));

        expect(failure(error)).toStrictEqual([
          "Missing",
          "machine dev is missing from the tart runtime; delete it",
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

        yield* runtime.make(machine, fromImage("base"), unbound);
        mac.jobs.clear();
        mac.vms.set(vm, "stopped");

        const before = calls(mac).length;

        yield* runtime.start(machine, new Set());

        expect(calls(mac).slice(before)).toStrictEqual([
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

        const error = yield* Effect.flip(
          runtime.make(machine, fromImage("base"), unbound)
        );

        expect(error._tag).toBe("Capacity");
        expect(error.message).toBe(
          "Apple's limit of 2 running macOS VMs per Mac refused third: The number of VMs exceeds the system limit (other running VMs: a1, a2)"
        );
      })
  );

  it.effect(
    "a start that meets a hand run begun after its read ends with the machine running under it, its job's run refused by Tart's lock",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
        yield* runtime.stop(machine);
        mac.hooks.print = () => {
          if (!mac.runs.has(vm)) {
            mac.runByHand(vm);
          }

          return undefined;
        };

        yield* runtime.start(machine, new Set());

        expect({
          run: mac.runs.get(vm)?.job,
          jobExit: mac.exited.get(vm),
          log: yield* read(
            path.join(jobsDir(mac.settings.stateDir), `${vm}.log`)
          ),
          state: (yield* runtime.observe([machine])).get(machine.name),
        }).toStrictEqual({
          run: false,
          jobExit: 2,
          log: `VM "${vm}" is already running!\n`,
          state: "running",
        });
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

        const error = yield* Effect.flip(
          runtime.make(machine, fromImage("base"), unbound)
        );

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
            Effect.flip(runtime.make(machine, fromImage("base"), unbound))
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

        const error = yield* Effect.flip(
          runtime.make(machine, fromImage("base"), unbound)
        );

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

        const file = (machine: Identity) =>
          path.join(jobsDir(mac.settings.stateDir), `${vmOf(machine)}.plist`);

        yield* write(
          file(stale),
          "names /opt/tart/2.40.0/tart.app/Contents/MacOS/tart\n"
        );

        for (const machine of [gone, stale]) {
          mac.vms.set(vmOf(machine), "stopped");
          yield* runtime.start(machine, new Set());

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
          yield* runtime.make(machine, fromImage("base"), unbound);
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

          yield* runtime.start(machine, new Set());
          ran.push(calls(mac).slice(before));
        }

        expect(ran).toStrictEqual([
          [
            `launchctl kickstart gui/501/${vmOf(current)}`,
            `tart exec ${vmOf(current)} true`,
          ],
          [
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
              { _tag: "found", machine: a },
              { _tag: "booting", machine: b },
            ],
          })
        );

        expect(refused._tag).toBe("Capacity");
        expect(refused.message).toBe(
          `startMachine b would run 3 macOS VMs on this Mac, and Apple allows 2: ${[vmOf(a), vmOf(b), "tart run pid 5001"].toSorted().join(", ")}`
        );

        mac.vms.delete("operators-own");

        const crowded = yield* Effect.flip(
          admitOn(runtime)({
            action: "startMachine",
            machine: b,
            machines: [
              { _tag: "found", machine: a },
              { _tag: "booting", machine: b },
              { _tag: "booting", machine: c },
            ],
          })
        );

        expect(crowded._tag).toBe("Capacity");

        yield* admitOn(runtime)({
          action: "startMachine",
          machine: b,
          machines: [
            { _tag: "found", machine: a },
            { _tag: "booting", machine: b },
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

        const idle = yield* runtime.capacity([
          { _tag: "found", machine: a },
          { _tag: "found", machine: b },
        ]);

        const booting = yield* runtime.capacity([
          { _tag: "booting", machine: a },
          { _tag: "found", machine: b },
          { _tag: "booting", machine: c },
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
          machines: [{ _tag: "booting", machine: target }],
        });

        mac.vms.set("operators-other", "running");

        const crowded = yield* Effect.flip(
          admitOn(runtime)({
            action: "startMachine",
            machine: target,
            machines: [{ _tag: "booting", machine: target }],
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
        const checkpoint = snapOf();

        mac.vms.set(vmOf(source), "running");

        const fork = yield* Effect.flip(
          runtime.make(copy, fromMachine(source), unbound)
        );

        const capture = yield* Effect.flip(runtime.capture(source, checkpoint));

        mac.vms.set(vmOf(source), "suspended");

        const paused = yield* Effect.flip(
          runtime.make(copy, fromMachine(source), unbound)
        );

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
          [
            "Missing",
            "machine src is missing from the tart runtime; delete it",
          ],
        ]);
        expect(calls(mac)).toStrictEqual([]);
        expect(
          existsSync(
            path.join(jobsDir(mac.settings.stateDir), `${vmOf(copy)}.plist`)
          )
        ).toBe(false);
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

        const forking: Activation = {
          action: "forkMachine",
          machine: copy,
          machines: [
            { _tag: "found", machine: source },
            { _tag: "booting", machine: copy },
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

        const checkpoint = snapOf();
        const snap = checkpointName("mac", checkpoint);

        mac.vms.set(vmOf(source), "stopped");
        yield* runtime.capture(source, checkpoint);
        yield* runtime.make(forked, fromMachine(source), unbound);
        yield* runtime.make(restored, fromCheckpoint(checkpoint), unbound);
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
    "find answers the handle a make gave its instance, none for another instance of its name, and a captured checkpoint's",
    () =>
      Effect.gen(function* () {
        const { runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const later = { ...machine, instance: "76543210".repeat(4) };
        const checkpoint = snapOf();

        const { handle } = yield* runtime.make(
          machine,
          fromImage("base"),
          unbound
        );

        const uncaptured = yield* runtime.find("checkpoint", checkpoint);

        yield* runtime.stop({ ...machine, handle });

        const captured = yield* runtime.capture(
          { ...machine, handle },
          checkpoint
        );

        expect({
          machine: yield* runtime.find("machine", machine),
          later: yield* runtime.find("machine", later),
          uncaptured,
          checkpoint: yield* runtime.find("checkpoint", checkpoint),
          laterCheckpoint: yield* runtime.find("checkpoint", {
            ...checkpoint,
            instance: later.instance,
          }),
        }).toStrictEqual({
          machine: handle,
          later: undefined,
          uncaptured: undefined,
          checkpoint: captured,
          laterCheckpoint: undefined,
        });
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

        const checkpoint = snapOf();

        mac.vms.set(vmOf(source), "stopped");
        mac.vms.set(checkpointName("mac", checkpoint), "stopped");
        yield* runtime.make(forked, fromMachine(source), unbound);
        yield* runtime.make(restored, fromCheckpoint(checkpoint), unbound);

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

        yield* runtime.make(machine, fromImage("base"), unbound);

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

        yield* runtime.stop(stopped);
        yield* runtime.stop(gone);

        expect(calls(mac)).toStrictEqual([]);
      })
  );

  it.effect(
    "a guest that doesn't shut down within a minute is forced off",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
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

        yield* runtime.make(machine, fromImage("base"), unbound);
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

        yield* runtime.make(machine, fromImage("base"), unbound);

        const before = calls(mac).length;

        yield* runtime.delete(machine, new Set());

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

        yield* runtime.delete(machine, new Set());

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

        yield* runtime.make(machine, fromImage("base"), unbound);
        yield* runtime.stop(machine);
        mac.hooks.delete = () => ({
          exitCode: 1,
          stderr: "Error: permission denied\n",
        });

        const before = calls(mac).length;
        const error = yield* Effect.flip(runtime.delete(machine, new Set()));

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
    "a command's arguments and env reach no argument of a tart process, as root or as a user",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");

        for (const user of [{}, { user: "admin" }]) {
          yield* runCommand(runtime, {
            machine,
            argv: ["/bin/echo", "argv-word-91c3"],
            env: { TOKEN: "env-value-5be1" },
            ...user,
          });
        }

        const shown = mac.spawner.calls.filter((call) =>
          call.args.some(
            (argument) =>
              argument.includes("argv-word-91c3") ||
              argument.includes("env-value-5be1")
          )
        );

        expect(shown).toStrictEqual([]);
        expect(mac.spawner.calls.at(-1)?.stdin).toContain("env-value-5be1");
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
              stdin: "the input",
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

  it.effect(
    "observe reads each machine's state from its VM's directory and its job, running no tart",
    () =>
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
          mac.spawner.calls.slice(before).filter(({ file }) => file === binary)
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "pause suspends a VM its job runs suspendable, and waits for Tart to save it",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);

        const before = calls(mac).length;

        yield* runtime.pause(machine);

        expect(calls(mac).slice(before)).toStrictEqual([`tart suspend ${vm}`]);
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

        yield* runtime.make(machine, fromImage("base"), unbound);
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
          `tart exec ${vm} sudo -n /sbin/shutdown -h now`,
        ]);
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "stopped"]])
        );
      })
  );

  it.effect(
    "a launchctl print without the job's state or arguments fails a read, a stop and a pause of a VM whose lock no run holds as Internal, naming what it printed, and signals nothing",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
        mac.vms.set(vm, "stopped");

        const before = calls(mac).length;

        const unreadable = [
          "gui/501/job = {\n\tstate = running\n}\n",
          "gui/501/job = {\n\tprogram = /opt/tart\n\targuments = {\n\t\t/opt/tart\n\t}\n}\n",
        ];

        const failures = [];

        for (const stdout of unreadable) {
          mac.hooks.print = () => ({ stdout });

          failures.push(
            ...[
              yield* Effect.flip(runtime.observe([machine])),
              yield* Effect.flip(runtime.stop(machine)),
              yield* Effect.flip(runtime.pause(machine)),
            ].map(failure)
          );
        }

        expect(failures).toStrictEqual(
          unreadable.flatMap((stdout) =>
            Array.from({ length: 3 }, () => [
              "Internal",
              `launchctl print gui/501/${vm} printed no state or arguments this host reads: ${stdout.trimEnd()}`,
            ])
          )
        );
        expect(calls(mac).slice(before)).toStrictEqual([]);
      })
  );

  it.effect(
    "a suspend whose save fails has tart stop remove what it left of the state, and fails, as Tart powered the VM off",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
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

        yield* runtime.make(machine, fromImage("base"), unbound);
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
            "machine gone is missing from the tart runtime; delete it",
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

      yield* runtime.make(machine, fromImage("base"), unbound);
      yield* runtime.pause(machine);

      const before = calls(mac).length;

      yield* runtime.start(machine, new Set());

      expect(calls(mac).slice(before)).toStrictEqual([
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

        yield* runtime.make(machine, fromImage("base"), unbound);
        yield* runtime.pause(machine);
        mac.hooks.kickstart = (label) => {
          mac.exited.set(label, 1);
          appendFileSync(
            mac.logOf(label),
            'restoring VM state from a snapshot...\nError Domain=VZErrorDomain Code=12 "The virtual machine failed to restore with error “permission denied”."\n'
          );
        };

        const error = yield* Effect.flip(runtime.start(machine, new Set()));

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
    "a read answers while a create's tart set grows the new VM's disk",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [growing, other] = [machineOn("growing"), machineOn("other")];
        const release = yield* Deferred.make<undefined>();
        const setting = yield* Deferred.make<undefined>();

        mac.vms.set(vmOf(other), "running");
        mac.hooks.set = () => {
          Deferred.doneUnsafe(setting, Exit.succeed(undefined));

          return { until: Deferred.await(release) };
        };

        const creating = yield* Effect.forkChild(
          runtime.make(growing, fromImage("base"), unbound)
        );

        yield* Deferred.await(setting);

        const reads = yield* Effect.all([
          runtime.observe([growing, other]),
          runtime.find("machine", growing),
        ]).pipe(Effect.timeoutOption(Duration.seconds(2)));

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(creating);

        expect(reads._tag === "Some" ? reads.value : "hung").toStrictEqual([
          new Map([
            ["growing", "stopped"],
            ["other", "running"],
          ]),
          vmOf(growing),
        ]);
      })
  );

  it.effect(
    "Apple's two-VM count takes every tart run on the Mac, in any Tart home, and nothing else",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [a, b] = [machineOn("a"), machineOn("b")];

        mac.vms.set(vmOf(a), "running");
        mac.vms.set(vmOf(b), "stopped");
        mac.elsewhere.add({
          name: "tart",
          args: "/Applications/Tart App/tart.app/Contents/MacOS/tart run --no-graphics operators-vm",
        });

        const held: readonly Held[] = [
          { _tag: "found", machine: a },
          { _tag: "found", machine: b },
        ];

        const used = yield* runtime.capacity(held);

        const refused = yield* admitOn(runtime)({
          action: "startMachine",
          machine: b,
          machines: [
            { _tag: "found", machine: a },
            { _tag: "booting", machine: b },
          ],
        }).pipe(
          Effect.match({ onFailure: failure, onSuccess: () => "admitted" })
        );

        mac.elsewhere.clear();

        yield* admitOn(runtime)({
          action: "startMachine",
          machine: b,
          machines: [
            { _tag: "found", machine: a },
            { _tag: "booting", machine: b },
          ],
        });

        expect(used[0]).toStrictEqual({
          resource: "runningVms",
          limit: 2,
          used: 2,
        });
        expect(refused).toStrictEqual([
          "Capacity",
          `startMachine b would run 3 macOS VMs on this Mac, and Apple allows 2: ${[vmOf(a), vmOf(b), "tart run pid 6000"].toSorted().join(", ")}`,
        ]);
      })
  );

  it.effect(
    "a VM a tart run outside its job runs reads running, however that run's executable is named: a start boots nothing, a capture or fork is refused, capacity counts it, and a stop shuts it down and waits for that run to end",
    () =>
      Effect.gen(function* () {
        for (const executable of [
          "tart",
          "/usr/local/bin/tart-2.41.1",
          "/opt/tart builds/tart",
        ]) {
          const { mac, runtime } = yield* runtimeOn();
          const [machine, copy] = [machineOn("dev"), machineOn("copy")];
          const vm = vmOf(machine);

          yield* runtime.make(machine, fromImage("base"), unbound);
          yield* runtime.stop(machine);
          mac.runByHand(vm, [executable, "run", "--no-graphics", vm]);

          const before = calls(mac).length;
          const observed = yield* runtime.observe([machine]);

          yield* runtime.start(machine, new Set());

          const refused = [
            yield* Effect.flip(runtime.capture(machine, snapOf())),
            yield* Effect.flip(
              runtime.make(copy, fromMachine(machine), unbound)
            ),
          ].map(failure);

          const used = yield* runtime.capacity([{ _tag: "found", machine }]);

          yield* runtime.stop(machine);

          expect([executable, observed]).toStrictEqual([
            executable,
            new Map([[machine.name, "running"]]),
          ]);
          expect(refused).toStrictEqual([
            [
              "WrongState",
              "a Tart checkpoint copies a stopped machine's disk, and dev is running: stop it first",
            ],
            [
              "WrongState",
              "a Tart fork copies a stopped machine's disk, and dev is running: stop it first",
            ],
          ]);
          expect(used[0]).toStrictEqual({
            resource: "runningVms",
            limit: 2,
            used: 1,
          });
          expect(calls(mac).slice(before)).toStrictEqual([
            `tart exec ${vm} sudo -n /sbin/shutdown -h now`,
          ]);
          expect(yield* runtime.observe([machine])).toStrictEqual(
            new Map([[machine.name, "stopped"]])
          );
        }
      })
  );

  it.effect(
    "a lock read that fails, or answers short, fails a read, a start, a stop, a pause, a capture and a fork as Internal, and signals or copies nothing",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [machine, copy] = [machineOn("dev"), machineOn("copy")];
        const vm = vmOf(machine);

        const config = path.join(
          mac.settings.tartHome ?? "",
          "vms",
          vm,
          "config.json"
        );

        yield* runtime.make(machine, fromImage("base"), unbound);

        const before = calls(mac).length;

        const answers = [
          {
            reply: { exitCode: 255, stderr: "perl: not found\n" },
            message:
              "/usr/bin/perl reading the VMs' locks exited 255: perl: not found",
          },
          {
            reply: { stdout: `5001\t${config}\n` },
            message:
              "/usr/bin/perl reading the VMs' locks: it answered 1 lines for 1 paths, with no end",
          },
          {
            reply: { stdout: `error Permission denied\t${config}\nend\n` },
            message: `/usr/bin/perl reading the VMs' locks: ${config}: error Permission denied`,
          },
        ];

        for (const { reply, message } of answers) {
          mac.hooks.locks = () => reply;

          expect(
            [
              yield* Effect.flip(runtime.observe([machine])),
              yield* Effect.flip(runtime.start(machine, new Set())),
              yield* Effect.flip(runtime.stop(machine)),
              yield* Effect.flip(runtime.pause(machine)),
              yield* Effect.flip(runtime.capture(machine, snapOf())),
              yield* Effect.flip(
                runtime.make(copy, fromMachine(machine), unbound)
              ),
            ].map(failure)
          ).toStrictEqual(
            Array.from({ length: 6 }, () => ["Internal", message])
          );
        }

        expect(calls(mac).slice(before)).toStrictEqual([]);
      })
  );

  it.effect(
    "a ps that fails fails capacity and a boot's admission as Internal",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");

        mac.hooks.ps = () => ({ exitCode: 1, stderr: "ps: fault\n" });

        expect(
          [
            yield* Effect.flip(runtime.capacity([{ _tag: "found", machine }])),
            yield* Effect.flip(
              runtime.admission?.admit({
                action: "createMachine",
                machine,
                machines: [{ _tag: "booting", machine }],
              }) ?? Effect.void
            ),
          ].map(failure)
        ).toStrictEqual(
          Array.from({ length: 2 }, () => [
            "Internal",
            "ps exited 1: ps: fault",
          ])
        );
      })
  );

  it.effect(
    "a VM whose directory is gone reads missing, though its job still runs",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
        rmSync(path.join(mac.settings.tartHome ?? "", "vms", vm), {
          recursive: true,
        });

        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "missing"]])
        );
      })
  );

  it.effect(
    "capacity counts a tart run of another home's VM whose name holds this host's VM's apart from it",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
        mac.elsewhere.add({
          name: "tart",
          args: `/opt/other/tart run --no-graphics ${vm}-copy`,
        });

        const [runs] = yield* runtime.capacity([{ _tag: "found", machine }]);

        expect(runs).toStrictEqual({
          resource: "runningVms",
          limit: 2,
          used: 2,
        });
      })
  );

  it.effect(
    "a VM whose job launchd is starting reads running before its tart run begins",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");

        yield* runtime.make(machine, fromImage("base"), unbound);
        yield* runtime.stop(machine);
        mac.starting.add(vmOf(machine));

        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "running"]])
        );
      })
  );

  it.effect(
    "delete of a VM a tart run outside its job runs forces that run off, then removes the VM",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
        yield* runtime.stop(machine);
        mac.runByHand(vm);

        const before = calls(mac).length;

        yield* runtime.delete(machine, new Set());

        expect(calls(mac).slice(before)).toStrictEqual([
          `tart delete ${vm}`,
          `tart stop --timeout 0 ${vm}`,
          `tart delete ${vm}`,
          `launchctl bootout gui/501/${vm}`,
        ]);
        expect([mac.vms.has(vm), mac.runs.has(vm)]).toStrictEqual([
          false,
          false,
        ]);
      })
  );

  it.effect(
    "pause of a VM a tart run outside its job runs stops it instead, as the host can't read that run's output for Tart's save",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
        yield* runtime.stop(machine);
        mac.runByHand(vm, ["tart", "run", "--suspendable", vm]);

        const before = calls(mac).length;

        yield* runtime.pause(machine);

        expect(calls(mac).slice(before)).toStrictEqual([
          `tart exec ${vm} sudo -n /sbin/shutdown -h now`,
        ]);
        expect(yield* runtime.observe([machine])).toStrictEqual(
          new Map([[machine.name, "stopped"]])
        );
      })
  );

  it.effect(
    "a forced stop waits for the tart run to end after tart stop returns, and fails, deleting nothing, when it never ends",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const [lingering, stuck] = [machineOn("lingering"), machineOn("stuck")];

        yield* runtime.make(lingering, fromImage("base"), unbound);
        yield* runtime.make(stuck, fromImage("base"), unbound);
        mac.hooks.stop = () => ({ exitCode: 0 });

        const deleting = (machine: Sized, ends: boolean) =>
          Effect.gen(function* () {
            const before = calls(mac).length;

            const fiber = yield* Effect.forkChild(
              Effect.exit(runtime.delete(machine, new Set()))
            );

            yield* TestClock.adjust(Duration.seconds(5));
            yield* Effect.yieldNow;

            const waited = fiber.pollUnsafe() === undefined;

            if (ends) {
              mac.vms.set(vmOf(machine), "stopped");
            }

            while (fiber.pollUnsafe() === undefined) {
              yield* TestClock.adjust(Duration.millis(500));
            }

            const exit = yield* Fiber.join(fiber);

            return {
              waited,
              failed: Exit.isFailure(exit)
                ? exit.cause
                    .toString()
                    .includes(
                      `${vmOf(machine)} still runs 10s after tart stop --timeout 0`
                    )
                : false,
              calls: calls(mac).slice(before),
              held: mac.vms.has(vmOf(machine)),
            };
          });

        const ended = yield* deleting(lingering, true).pipe(
          Effect.provide(TestClock.layer())
        );

        const never = yield* deleting(stuck, false).pipe(
          Effect.provide(TestClock.layer())
        );

        expect([ended, never]).toStrictEqual([
          {
            waited: true,
            failed: false,
            calls: [
              `tart delete ${vmOf(lingering)}`,
              `tart stop --timeout 0 ${vmOf(lingering)}`,
              `tart delete ${vmOf(lingering)}`,
              `launchctl bootout gui/501/${vmOf(lingering)}`,
            ],
            held: false,
          },
          {
            waited: true,
            failed: true,
            calls: [
              `tart delete ${vmOf(stuck)}`,
              `tart stop --timeout 0 ${vmOf(stuck)}`,
            ],
            held: true,
          },
        ]);
      })
  );

  it.effect(
    "capacity and admission count the host's own VMs by the binary it runs, whatever its file is named",
    () =>
      Effect.gen(function* () {
        const { runtime } = yield* runtimeOn({
          binary: "/opt/tart/2.41.1/bin/tart-2.41.1",
        });

        const [a, b, c] = [machineOn("a"), machineOn("b"), machineOn("c")];

        yield* runtime.make(a, fromImage("base"), unbound);
        yield* runtime.make(b, fromImage("base"), unbound);

        const held: readonly Held[] = [
          { _tag: "found", machine: a },
          { _tag: "found", machine: b },
        ];

        const used = yield* runtime.capacity(held);

        const refused = yield* Effect.flip(
          admitOn(runtime)({
            action: "createMachine",
            machine: c,
            machines: [...held, { _tag: "booting", machine: c }],
          })
        );

        expect(used[0]).toStrictEqual({
          resource: "runningVms",
          limit: 2,
          used: 2,
        });
        expect(failure(refused)).toStrictEqual([
          "Capacity",
          `createMachine c would run 3 macOS VMs on this Mac, and Apple allows 2: ${[vmOf(a), vmOf(b), vmOf(c)].toSorted().join(", ")}`,
        ]);
      })
  );

  it.effect(
    "stop of a paused VM discards its saved state with tart stop, booting nothing",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        yield* runtime.make(machine, fromImage("base"), unbound);
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

const operationsOn = (runtime: Interface) =>
  Layer.build(
    Operations.layer({ id: "mac", bases: new Map([["macos", "base"]]) }).pipe(
      Layer.provide(Reach.layer(suitePorts.tart)),
      Layer.provideMerge(Layer.succeed(Runtime, runtime)),
      Layer.provide(
        Layer.merge(
          Layer.succeed(PortProbe, { free: () => Effect.succeed(true) }),
          Relay.layer
        )
      )
    )
  ).pipe(Effect.map(Context.get(Operations.Operations)));

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "find answers a machine's handle while the Tart home holds its VM or its job's plist or log is left, and nothing once all are gone",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        const plistFile = path.join(
          jobsDir(mac.settings.stateDir),
          `${vm}.plist`
        );

        const found = runtime.find("machine", machine);

        yield* runtime.make(machine, fromImage("base"), unbound);

        const listed = yield* found;

        mac.vms.delete(vm);

        const jobLeft = yield* found;

        rmSync(plistFile);

        const logLeft = yield* found;

        yield* runtime.delete(machine, new Set());

        expect([listed, jobLeft, logLeft]).toStrictEqual([vm, vm, vm]);
        expect(yield* found).toBeUndefined();
        expect([mac.jobs.has(vm), existsSync(mac.logOf(vm))]).toStrictEqual([
          false,
          false,
        ]);
      })
  );

  it.effect(
    "a make whose admission fails Internal clones nothing and fails with that error, and its undo finds nothing and is done",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const operations = yield* operationsOn(runtime);
        const machine = machineOn("dev");
        const identity = { name: machine.name, instance: machine.instance };

        mac.hooks.ps = () => ({ exitCode: 1, stderr: "ps: fault\n" });

        const ended = (id: string, sequence: number, step: Step) =>
          Effect.andThen(
            operations.run({
              id,
              boot: operations.boot,
              scope: { resource: "machine", name: "dev" },
              sequence,
              step,
            }),
            eventually(
              operations.wait(id),
              ({ status }) => status !== "running"
            )
          );

        const made = yield* ended("make", 1, {
          _tag: "make",
          machine: { ...identity, cpu: 4, ramMib: 8192, diskGib: 60 },
          source: { _tag: "base", base: "macos" },
          taken: [],
          machines: [],
        });

        const undone = yield* ended("undo", 2, {
          _tag: "remove",
          machine: identity,
          keep: [],
        });

        expect([
          made.status,
          made.outcome.handle,
          made.error === undefined ? undefined : failure(made.error),
        ]).toStrictEqual([
          "failed",
          undefined,
          ["Internal", "ps exited 1: ps: fault"],
        ]);
        expect(undone.status).toBe("done");
        expect(calls(mac)).toStrictEqual([]);
      })
  );

  it.effect(
    "the undo of a make that failed in Tart, sent again with no handle after its host died past tart delete, removes the VM's job, plist and log",
    () =>
      Effect.gen(function* () {
        const { mac, runtime } = yield* runtimeOn();
        const operations = yield* operationsOn(runtime);
        const machine = machineOn("dev");
        const vm = vmOf(machine);

        const plistFile = path.join(
          jobsDir(mac.settings.stateDir),
          `${vm}.plist`
        );

        const identity = { name: machine.name, instance: machine.instance };

        mac.hooks.kickstart = (label) => {
          mac.exited.set(label, 1);
        };

        const ended = (id: string, sequence: number, step: Step) =>
          Effect.andThen(
            operations.run({
              id,
              boot: operations.boot,
              scope: { resource: "machine", name: "dev" },
              sequence,
              step,
            }),
            eventually(
              operations.wait(id),
              ({ status }) => status !== "running"
            )
          );

        const made = yield* ended("make", 1, {
          _tag: "make",
          machine: { ...identity, cpu: 4, ramMib: 8192, diskGib: 60 },
          source: { _tag: "base", base: "macos" },
          taken: [],
          machines: [],
        });

        const left = [mac.jobs.has(vm), existsSync(plistFile)];

        mac.vms.delete(vm);

        const undone = yield* ended("undo", 2, {
          _tag: "remove",
          machine: identity,
          keep: [],
        });

        expect([made.status, made.outcome.handle, left]).toStrictEqual([
          "failed",
          undefined,
          [true, true],
        ]);
        expect(undone.status).toBe("done");
        expect([
          mac.jobs.has(vm),
          existsSync(plistFile),
          existsSync(mac.logOf(vm)),
        ]).toStrictEqual([false, false, false]);
      })
  );
});
