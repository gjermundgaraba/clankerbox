/**
 * The Tart runtime over a scripted Mac: Tart's VMs and launchd's jobs are kept in memory, and
 * each `tart` and `launchctl` call answers as Tart 2.40.1 and launchd do. No VM runs here; the
 * forwarder listens for real on loopback.
 */
import { existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { connect, createServer } from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Exit, Fiber, Layer, Logger, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { type Interface, type MachineRef, Refusal } from "../src/runtime.ts";
import {
  checkpointName,
  diskGb,
  environment,
  jobsDir,
  machineName,
  make,
  plist,
  type Settings,
  stateOf,
  supported,
} from "../src/tart.ts";
import { removeScratch, scratch } from "./scratch.ts";
import { type Call, type Reply, scripted } from "./scripted.ts";

const owned: Array<string> = [];

/** A refusal's error, or the failure that wasn't one. */
const refused = (error: Refusal | HostError) =>
  error instanceof Refusal
    ? [error.error._tag, error.error.message]
    : ["not refused", error.message];

const scopes: Array<Scope.Closeable> = [];

afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
  await removeScratch(owned);
});

const binary = "/opt/tart/2.40.1/tart.app/Contents/MacOS/tart";

const launchctl = "/bin/launchctl";

/**
 * Each test's own loopback port, from this file's range, which no other test file uses: below
 * the ephemeral ports, so no outgoing connection takes one between tests.
 */
let nextPort = 21_200;

const ownPort = () => nextPort++;

/** Whether something accepts connections on loopback `port`. */
const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      resolve(false);
    });
  });

const machineOn = async (name: string): Promise<MachineRef> => ({
  id: `mac_${name}`,
  name,
  instance: `${name.length.toString(16).padStart(2, "0")}23456789abcdef0123456789abcdef`,
  native: undefined,
  cpu: 4,
  ramMib: 8192,
  diskGib: 60,
  port: ownPort(),
});

/**
 * What a test changes: the job's `tart run`, the agent's answer, a guest's shutdown, a delete,
 * a `tart list`.
 */
interface Hooks {
  list?: () => Reply | undefined;
  kickstart?: (vm: string) => void;
  probe?: (vm: string) => Reply;
  shutdown?: (vm: string) => Reply;
  delete?: (vm: string) => Reply | undefined;
}

/**
 * A scripted Mac. `vms` holds Tart's VMs and their states, `jobs` the labels launchd holds, and
 * `programs` the tart each was bootstrapped with, if not the configured one. `kickstart` runs the
 * job's `tart run`; by default the VM then runs and its agent answers.
 */
const scriptedMac = (stateDir: string) => {
  const vms = new Map<string, "running" | "stopped" | "suspended">();
  const jobs = new Set<string>();
  const programs = new Map<string, string>();
  const exited = new Map<string, number>();

  const hooks: Hooks = {};

  const tart = (args: ReadonlyArray<string>): Reply | undefined => {
    const [command = "", ...rest] = args;
    const vm = rest[0] ?? "";

    switch (command) {
      case "--version":
        return { stdout: "2.40.1\n" };
      case "list":
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
              })),
            ),
          }
        );
      case "clone":
        vms.set(rest[1] ?? "", "stopped");

        return undefined;
      case "set": {
        // Every scripted VM's disk is 50 GB, and Tart only grows a disk.
        const at = rest.indexOf("--disk-size");
        const size = at === -1 ? 50 : Number(rest[at + 1]);

        return size < 50
          ? {
              exitCode: 1,
              stderr: `new disk size of ${size} GB should be larger than the current disk size of 50 GB\n`,
            }
          : undefined;
      }

      case "exec":
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
      case "stop": {
        const target = rest[2] ?? "";

        if (vms.get(target) !== "running") {
          return { exitCode: 2 };
        }

        vms.set(target, "stopped");

        return undefined;
      }

      case "delete":
        if (hooks.delete !== undefined) {
          return hooks.delete(vm);
        }

        if (!vms.has(vm)) {
          return { exitCode: 2, stderr: `the specified VM "${vm}" does not exist\n` };
        }

        if (vms.get(vm) === "running") {
          return { exitCode: 1, stderr: `VM "${vm}" is running\n` };
        }

        vms.delete(vm);

        return undefined;
      default:
        return undefined;
    }
  };

  const launchd = (args: ReadonlyArray<string>): Reply | undefined => {
    const [command = "", target = ""] = args;
    const label = target.split("/").at(-1) ?? "";

    switch (command) {
      case "print":
        if (!jobs.has(label)) {
          return { exitCode: 113, stderr: `Could not find service "${label}" in domain\n` };
        }

        return {
          stdout:
            vms.get(label) === "running" || !exited.has(label)
              ? `${target} = {\n\tstate = running\n\tprogram = ${programs.get(label) ?? binary}\n\tlast exit code = (never exited)\n}\n`
              : `${target} = {\n\tstate = not running\n\tprogram = ${programs.get(label) ?? binary}\n\tlast exit code = ${exited.get(label)}\n\tjob state = exited\n}\n`,
        };
      case "bootstrap":
        jobs.add(basename(args[2] ?? "", ".plist"));
        programs.delete(basename(args[2] ?? "", ".plist"));

        return undefined;
      case "kickstart":
        if (hooks.kickstart === undefined) {
          vms.set(label, "running");
        } else {
          hooks.kickstart(label);
        }

        return undefined;
      case "bootout":
        programs.delete(label);

        return jobs.delete(label) ? undefined : { exitCode: 3, stderr: "Boot-out failed: 3\n" };
      default:
        return undefined;
    }
  };

  const spawner = scripted((call: Call) =>
    call.file === binary
      ? tart(call.args)
      : call.file === launchctl
        ? launchd(call.args)
        : undefined,
  );

  const settings: Settings = {
    binary,
    publishAddress: "127.0.0.1",
    hostId: "mac",
    stateDir,
    uid: 501,
    tartHome: "/Users/operator/.tart-test",
  };

  return { vms, jobs, programs, exited, hooks, spawner, settings };
};

type ScriptedMac = ReturnType<typeof scriptedMac>;

/** A scripted Mac with its state dir, and the runtime over it, started and living until the test ends. */
const runtimeOn = async (options?: {
  readonly settings?: Partial<Settings>;
}): Promise<{ readonly mac: ScriptedMac; readonly runtime: Interface }> => {
  const mac = scriptedMac(join(await scratch(owned), "state"));
  const scope = await Effect.runPromise(Scope.make());

  scopes.push(scope);

  const runtime = await Effect.runPromise(
    make({ ...mac.settings, ...options?.settings }).pipe(
      Scope.provide(scope),
      Effect.provide(Layer.merge(NodeServices.layer, mac.spawner.layer)),
    ),
  );

  await Effect.runPromise(runtime.startup([]));

  return { mac, runtime };
};

/**
 * The calls after the version check, as `<program> <args…>`, without the `tart list` reads.
 * Startup makes none.
 */
const calls = (mac: ScriptedMac) =>
  mac.spawner.calls
    .slice(1)
    .map((call) => [call.file === binary ? "tart" : "launchctl", ...call.args].join(" "))
    .filter((line) => !line.startsWith("tart list"));

const vmOf = (machine: MachineRef) => machineName("mac", machine);

test("native names carry the host ID, the kind and the instance, and disk sizes round up to GB", () => {
  const ref = { name: "dev", instance: "0123456789abcdef0123456789abcdef" };

  expect(machineName("mac", ref)).toBe("cbx-mac-m-dev-01234567");
  expect(checkpointName("mac", ref)).toBe("cbx-mac-c-dev-01234567");
  expect([diskGb(1), diskGb(46), diskGb(47), diskGb(50)]).toEqual([2, 50, 51, 54]);
  expect([stateOf("running"), stateOf("suspended"), stateOf("stopped")]).toEqual([
    "running",
    "stopped",
    "stopped",
  ]);
});

test("Tart 2.40.1 or later is required, and an older one is refused at startup", async () => {
  expect(["2.40.1", "2.40.2", "2.41.0", "2.100.0", "10.0.0"].map(supported)).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(["2.40.0", "2.39.9", "2.9.0", "1.99.0"].map(supported)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(["2.40", "2.41.0-rc1", "v2.41.0", "dev", ""].map(supported)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);

  const mac = scriptedMac(join(await scratch(owned), "state"));

  const old = scripted((call) =>
    call.args[0] === "--version" ? { stdout: "2.38.0\n" } : undefined,
  );

  const error = await Effect.runPromise(
    Effect.scoped(make(mac.settings)).pipe(
      Effect.flip,
      Effect.provide(Layer.merge(NodeServices.layer, old.layer)),
    ),
  );

  expect(error._tag).toBe("Precondition");
  expect(error.message).toBe(
    `${binary} reports version "2.38.0", and this host needs Tart 2.40.1 or later`,
  );
});

test("every tart call runs the configured binary in the environment the VM jobs get", async () => {
  const { mac, runtime } = await runtimeOn();

  expect(runtime.version).toBe("2.40.1");
  expect(runtime.pin).toBeUndefined();

  for (const call of mac.spawner.calls) {
    expect(call.file).toBe(binary);
    expect(call.env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: homedir(),
      TART_HOME: "/Users/operator/.tart-test",
    });
  }

  expect(environment({ tartHome: undefined })).toEqual({
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    TART_HOME: undefined,
  });
});

test("create writes the VM's job, clones the base with a new serial and the sizes, then boots it", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);
  const image = "ghcr.io/cirruslabs/macos-tahoe-base@sha256:87f3";

  await Effect.runPromise(runtime.create(machine, image));

  expect(calls(mac)).toEqual([
    `tart clone ${image} ${vm}`,
    `tart set ${vm} --random-serial --cpu 4 --memory 8192 --disk-size 65`,
    `launchctl print gui/501/${vm}`,
    `launchctl bootstrap gui/501 ${join(jobsDir(mac.settings.stateDir), `${vm}.plist`)}`,
    `launchctl kickstart gui/501/${vm}`,
    `tart exec ${vm} true`,
  ]);

  const log = join(jobsDir(mac.settings.stateDir), `${vm}.log`);

  expect(await readFile(join(jobsDir(mac.settings.stateDir), `${vm}.plist`), "utf8")).toBe(
    plist({
      label: vm,
      program: [binary, "run", "--no-graphics", "--net-softnet-block=@host", vm],
      environment: environment(mac.settings),
      log,
    }),
  );
  expect(await accepts(machine.port ?? 0)).toBe(true);
  expect(await Effect.runPromise(runtime.observe([machine]))).toEqual([{ state: "running" }]);
});

test("a job plist names only tart, never restarts, and escapes what it holds", () => {
  expect(
    plist({
      label: "cbx-mac-m-a-01234567",
      program: ["/opt/tart & co/tart", "run", "--no-graphics", "cbx-mac-m-a-01234567"],
      environment: { PATH: "/usr/bin", HOME: "/Users/a<b>", TART_HOME: undefined },
      log: "/state/launchd/cbx-mac-m-a-01234567.log",
    }),
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
    ].join("\n"),
  );
});

test("start kickstarts a job launchd holds, without -k, and waits while the guest agent isn't up", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);
  let probes = 0;

  await Effect.runPromise(runtime.create(machine, "base"));
  mac.vms.set(vm, "stopped");
  mac.hooks.probe = () => {
    probes += 1;

    return probes === 1
      ? { exitCode: 1, stderr: "is the Tart Guest Agent running?\n" }
      : { exitCode: 0 };
  };

  const before = calls(mac).length;

  await Effect.runPromise(runtime.start(machine));

  expect(calls(mac).slice(before)).toEqual([
    `launchctl print gui/501/${vm}`,
    `launchctl kickstart gui/501/${vm}`,
    `tart exec ${vm} true`,
    `launchctl print gui/501/${vm}`,
    `tart exec ${vm} true`,
  ]);
});

test("start of a running VM listens and boots nothing", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");

  mac.vms.set(vmOf(machine), "running");

  const listened = await accepts(machine.port ?? 0);

  await Effect.runPromise(runtime.start(machine));

  expect(listened).toBe(false);
  expect(calls(mac)).toEqual([]);
  expect(await accepts(machine.port ?? 0)).toBe(true);
});

test("after a reboot, start bootstraps the job again from its plist", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);

  await Effect.runPromise(runtime.create(machine, "base"));
  mac.jobs.clear();
  mac.vms.set(vm, "stopped");

  const before = calls(mac).length;

  await Effect.runPromise(runtime.start(machine));

  expect(calls(mac).slice(before)).toEqual([
    `launchctl print gui/501/${vm}`,
    `launchctl bootstrap gui/501 ${join(jobsDir(mac.settings.stateDir), `${vm}.plist`)}`,
    `launchctl kickstart gui/501/${vm}`,
    `tart exec ${vm} true`,
  ]);
});

test("Apple's refusal of a third VM, read from the job's log, is Capacity", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("third");
  const vm = vmOf(machine);
  const log = join(jobsDir(mac.settings.stateDir), `${vm}.log`);

  mac.hooks.kickstart = (label) => {
    mac.exited.set(label, 1);
    writeFileSync(log, "The number of VMs exceeds the system limit (other running VMs: a1, a2)\n");
  };

  const error = await Effect.runPromise(Effect.flip(runtime.create(machine, "base")));

  expect(error._tag).toBe("Capacity");
  expect(error.message).toBe(
    "Apple's limit of 2 running macOS VMs per Mac refused mac_third: The number of VMs exceeds the system limit (other running VMs: a1, a2)",
  );
});

test("a job that exits for another reason fails the boot with its exit code and log", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);
  const log = join(jobsDir(mac.settings.stateDir), `${vm}.log`);

  await writeFile(log, "an earlier boot's output\n");
  mac.hooks.kickstart = (label) => {
    mac.exited.set(label, 1);
    writeFileSync(log, "Softnet failed: softnet not found in PATH\n", { flag: "a" });
  };

  const error = await Effect.runPromise(Effect.flip(runtime.create(machine, "base")));

  expect(error._tag).toBe("Internal");
  expect(error.message).toBe(
    "tart run for mac_dev exited 1: Softnet failed: softnet not found in PATH",
  );
});

test("a boot whose guest agent never answers leaves its VM running, reachable through its listener", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);

  // The create's clone, job file and listener take real time; the clock moves only once the
  // boot waits for the agent, and then until the create ends, however loaded the machine is.
  const probed = Promise.withResolvers<void>();

  mac.hooks.probe = () => {
    probed.resolve();

    return { exitCode: 1, stderr: "is the Tart Guest Agent running?\n" };
  };

  const creating = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.flip(runtime.create(machine, "base")));

    yield* Effect.promise(() => probed.promise);

    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust(Duration.seconds(1));
    }

    return yield* Fiber.join(fiber);
  });

  const error = await Effect.runPromise(creating.pipe(Effect.provide(TestClock.layer())));

  expect(error.message).toBe(
    "mac_dev's guest agent didn't answer tart exec within 3m of its start",
  );
  expect(calls(mac).filter((line) => line.includes("stop"))).toEqual([]);
  expect(mac.vms.get(vm)).toBe("running");
  expect(await accepts(machine.port ?? 0)).toBe(true);
});

test("a create, fork or restore whose forwarder can't listen is refused before anything native", async () => {
  const { mac, runtime } = await runtimeOn();
  const [source, machine] = await Promise.all([machineOn("src"), machineOn("dev")]);
  const taken = createServer();

  const checkpoint = {
    id: "mac_snap",
    name: "snap",
    instance: "fedcba9876543210fedcba9876543210",
    native: undefined,
    kind: "disk" as const,
    port: source.port,
  };

  mac.vms.set(vmOf(source), "stopped");
  await new Promise<void>((resolve) => {
    taken.listen({ host: "127.0.0.1", port: machine.port }, resolve);
  });

  try {
    const errors = await Promise.all(
      [
        runtime.create(machine, "base"),
        runtime.fork(source, machine),
        runtime.restore(checkpoint, machine),
      ].map((making) => Effect.runPromise(Effect.flip(making))),
    );

    for (const error of errors) {
      expect(refused(error)).toEqual([
        "Internal",
        expect.stringMatching(
          new RegExp(`^the forwarder couldn't listen on 127\\.0\\.0\\.1:${machine.port}: `, "u"),
        ),
      ]);
    }

    expect(calls(mac)).toEqual([]);
    expect(existsSync(join(jobsDir(mac.settings.stateDir), `${vmOf(machine)}.plist`))).toBe(false);
  } finally {
    await new Promise((resolve) => {
      taken.close(resolve);
    });
  }
});

test("a diskGib below the base's disk is Precondition at tart set, after the clone, and nothing boots", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = { ...(await machineOn("small")), diskGib: 20 };
  const vm = vmOf(machine);

  const error = await Effect.runPromise(Effect.flip(runtime.create(machine, "base")));

  expect([error._tag, error.message]).toEqual([
    "Precondition",
    "machine mac_small's disk of 20 GiB is below its base's, and Tart only grows a disk: new disk size of 22 GB should be larger than the current disk size of 50 GB",
  ]);
  expect(calls(mac)).toEqual([
    `tart clone base ${vm}`,
    `tart set ${vm} --random-serial --cpu 4 --memory 8192 --disk-size 22`,
  ]);
  expect(mac.vms.get(vm)).toBe("stopped");
});

test("start writes the job again, so a job file that's gone or names an older tart is replaced", async () => {
  const { mac, runtime } = await runtimeOn();
  const [gone, stale] = await Promise.all([machineOn("gone"), machineOn("stale")]);

  const file = (machine: MachineRef) =>
    join(jobsDir(mac.settings.stateDir), `${vmOf(machine)}.plist`);

  await writeFile(file(stale), "names /opt/tart/2.40.0/tart.app/Contents/MacOS/tart\n");

  for (const machine of [gone, stale]) {
    mac.vms.set(vmOf(machine), "stopped");
    await Effect.runPromise(runtime.start(machine));

    expect(await readFile(file(machine), "utf8")).toBe(
      plist({
        label: vmOf(machine),
        program: [binary, "run", "--no-graphics", "--net-softnet-block=@host", vmOf(machine)],
        environment: environment(mac.settings),
        log: join(jobsDir(mac.settings.stateDir), `${vmOf(machine)}.log`),
      }),
    );
    expect(mac.vms.get(vmOf(machine))).toBe("running");
  }
});

test("start reloads a stopped job launchd holds that names an older tart, and only kickstarts one that names this tart", async () => {
  const { mac, runtime } = await runtimeOn();
  const [current, older] = await Promise.all([machineOn("current"), machineOn("older")]);
  const plistOf = (vm: string) => join(jobsDir(mac.settings.stateDir), `${vm}.plist`);

  for (const machine of [current, older]) {
    await Effect.runPromise(runtime.create(machine, "base"));
    await Effect.runPromise(runtime.stop(machine));
    mac.exited.set(vmOf(machine), 0);
  }

  mac.programs.set(vmOf(older), "/opt/tart/2.40.0/tart.app/Contents/MacOS/tart");

  const ran = [];

  for (const machine of [current, older]) {
    const before = calls(mac).length;

    await Effect.runPromise(runtime.start(machine));
    ran.push(calls(mac).slice(before));
  }

  expect(ran).toEqual([
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
  expect(mac.programs.has(vmOf(older))).toBe(false);
});

test("the two-VM count takes every running VM, the operator's too, and machines actions are booting", async () => {
  const { mac, runtime } = await runtimeOn();
  const [a, b, c] = await Promise.all([machineOn("a"), machineOn("b"), machineOn("c")]);

  mac.vms.set("operators-own", "running");
  mac.vms.set(vmOf(a), "running");
  mac.vms.set(vmOf(b), "stopped");

  const refused = await Effect.runPromise(
    Effect.flip(
      runtime.admit({
        action: "start",
        machine: b,
        machines: [
          { machine: a, booting: false },
          { machine: b, booting: true },
        ],
      }),
    ),
  );

  expect(refused._tag).toBe("Capacity");
  expect(refused.message).toBe(
    `start mac_b would run 3 macOS VMs on this Mac, and Apple allows 2: ${[vmOf(a), vmOf(b), "operators-own"].sort().join(", ")}`,
  );

  // A machine an action is booting counts before its VM exists.
  mac.vms.delete("operators-own");

  const crowded = await Effect.runPromise(
    Effect.flip(
      runtime.admit({
        action: "start",
        machine: b,
        machines: [
          { machine: a, booting: false },
          { machine: b, booting: true },
          { machine: c, booting: true },
        ],
      }),
    ),
  );

  expect(crowded._tag).toBe("Capacity");

  await Effect.runPromise(
    runtime.admit({
      action: "start",
      machine: b,
      machines: [
        { machine: a, booting: false },
        { machine: b, booting: true },
      ],
    }),
  );
});

test("a fork's source and a capture's machine must be stopped: anything else is refused before a clone", async () => {
  const { mac, runtime } = await runtimeOn();
  const [source, copy] = await Promise.all([machineOn("src"), machineOn("copy")]);

  const checkpoint = {
    id: "mac_snap",
    name: "snap",
    instance: "fedcba9876543210fedcba9876543210",
    native: undefined,
    kind: "disk" as const,
    port: source.port,
  };

  mac.vms.set(vmOf(source), "running");

  const fork = await Effect.runPromise(Effect.flip(runtime.fork(source, copy)));
  const capture = await Effect.runPromise(Effect.flip(runtime.capture(source, checkpoint)));

  mac.vms.delete(vmOf(source));

  const missing = await Effect.runPromise(Effect.flip(runtime.capture(source, checkpoint)));

  expect(runtime.checkpointKind).toBe("disk");
  expect([fork, capture, missing].map(refused)).toEqual([
    [
      "Precondition",
      "a Tart fork copies a stopped machine's disk, and mac_src is running: stop it first",
    ],
    [
      "Precondition",
      "a Tart checkpoint copies a stopped machine's disk, and mac_src is running: stop it first",
    ],
    ["Precondition", "machine mac_src is missing from the tart runtime; delete it"],
  ]);
  expect(calls(mac)).toEqual([]);
  expect(existsSync(join(jobsDir(mac.settings.stateDir), `${vmOf(copy)}.plist`))).toBe(false);
  expect(await accepts(copy.port ?? 0)).toBe(false);
});

test("a fork counts only the copy as booting, not its stopped source", async () => {
  const { mac, runtime } = await runtimeOn();
  const [source, copy] = await Promise.all([machineOn("src"), machineOn("copy")]);

  const forking = {
    action: "fork" as const,
    machine: copy,
    machines: [
      { machine: source, booting: false },
      { machine: copy, booting: true },
    ],
  };

  mac.vms.set(vmOf(source), "stopped");
  mac.vms.set("operators-own", "running");
  await Effect.runPromise(runtime.admit(forking));

  mac.vms.set("operators-other", "running");

  expect((await Effect.runPromise(Effect.flip(runtime.admit(forking))))._tag).toBe("Capacity");
});

test("capture clones the machine to the checkpoint's name; fork and restore clone into the new machine", async () => {
  const { mac, runtime } = await runtimeOn();

  const [source, forked, restored] = await Promise.all([
    machineOn("src"),
    machineOn("forked"),
    machineOn("restored"),
  ]);

  const checkpoint = {
    id: "mac_snap",
    name: "snap",
    instance: "fedcba9876543210fedcba9876543210",
    native: undefined,
    kind: "disk" as const,
    port: source.port,
  };

  const snap = checkpointName("mac", checkpoint);

  mac.vms.set(vmOf(source), "stopped");
  await Effect.runPromise(runtime.capture(source, checkpoint));
  await Effect.runPromise(runtime.fork(source, forked));
  await Effect.runPromise(runtime.restore(checkpoint, restored));
  await Effect.runPromise(runtime.deleteCheckpoint(checkpoint));
  await Effect.runPromise(runtime.deleteCheckpoint(checkpoint));

  expect(calls(mac).filter((line) => line.startsWith("tart"))).toEqual([
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
});

test("stop shuts the guest down from inside and waits for its VM to stop; its listener stays", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);

  await Effect.runPromise(runtime.create(machine, "base"));

  const before = calls(mac).length;

  await Effect.runPromise(runtime.stop(machine));

  expect(calls(mac).slice(before)).toEqual([`tart exec ${vm} sudo -n /sbin/shutdown -h now`]);
  expect(mac.vms.get(vm)).toBe("stopped");
  expect(await accepts(machine.port ?? 0)).toBe(true);
});

test("a guest that doesn't shut down within a minute is forced off", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);

  await Effect.runPromise(runtime.create(machine, "base"));
  mac.hooks.shutdown = () => ({ exitCode: 0, stdout: "Shutdown NOW!\n" });

  const stopping = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(runtime.stop(machine));

    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust(Duration.millis(500));
    }

    return yield* Fiber.join(fiber);
  });

  await Effect.runPromise(stopping.pipe(Effect.provide(TestClock.layer())));

  expect(
    calls(mac)
      .filter((line) => !line.startsWith("launchctl"))
      .slice(-2),
  ).toEqual([`tart exec ${vm} sudo -n /sbin/shutdown -h now`, `tart stop --timeout 0 ${vm}`]);
  expect(mac.vms.get(vm)).toBe("stopped");
});

test("delete forces a running VM off, then removes it, its job, plist and log", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);
  const dir = jobsDir(mac.settings.stateDir);

  await Effect.runPromise(runtime.create(machine, "base"));

  const before = calls(mac).length;

  await Effect.runPromise(runtime.delete(machine));

  expect(calls(mac).slice(before)).toEqual([
    `tart delete ${vm}`,
    `tart stop --timeout 0 ${vm}`,
    `tart delete ${vm}`,
    `launchctl bootout gui/501/${vm}`,
  ]);
  expect([mac.vms.has(vm), mac.jobs.has(vm)]).toEqual([false, false]);
  expect([existsSync(join(dir, `${vm}.plist`)), existsSync(join(dir, `${vm}.log`))]).toEqual([
    false,
    false,
  ]);
  expect(await accepts(machine.port ?? 0)).toBe(false);
});

test("delete after a crash before the clone finds nothing native, and succeeds", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);

  await Effect.runPromise(runtime.delete(machine));

  expect(calls(mac)).toEqual([`tart delete ${vm}`, `launchctl bootout gui/501/${vm}`]);
});

test("delete fails, keeping the job and the listener, when Tart can't delete the VM", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);

  await Effect.runPromise(runtime.create(machine, "base"));
  await Effect.runPromise(runtime.stop(machine));
  mac.hooks.delete = () => ({ exitCode: 1, stderr: "Error: permission denied\n" });

  const before = calls(mac).length;
  const error = await Effect.runPromise(Effect.flip(runtime.delete(machine)));

  // Exit 1 is a running VM from Tart 2.40.0, so delete forces it off first; a VM that doesn't
  // run exits 2 there, and the second delete's error is the reply.
  expect(error._tag).toBe("Internal");
  expect(error.message).toBe(`tart delete ${vm} exited 1: Error: permission denied`);
  expect(calls(mac).slice(before)).toEqual([
    `tart delete ${vm}`,
    `tart stop --timeout 0 ${vm}`,
    `tart delete ${vm}`,
  ]);
  expect(mac.jobs.has(vm)).toBe(true);
  expect(await accepts(machine.port ?? 0)).toBe(true);
});

test("exec runs the command as root through sudo -n, with its stdin", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");

  const [output, exitCode] = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        runtime.exec(machine, {
          argv: ["/bin/sh", "-c", "cat >/dev/null"],
          stdin: new TextEncoder().encode("the input"),
        }),
        (execution) =>
          Effect.all([Stream.mkString(Stream.decodeText(execution.output)), execution.exitCode]),
      ),
    ),
  );

  expect([output, exitCode]).toEqual(["ran\n", 0]);
  expect(mac.spawner.calls.at(-1)).toMatchObject({
    file: binary,
    args: ["exec", "-i", vmOf(machine), "sudo", "-n", "--", "/bin/sh", "-c", "cat >/dev/null"],
    stdin: "the input",
  });
});

test("startup makes the jobs dir and listens again for every machine, running or not", async () => {
  const { mac, runtime } = await runtimeOn();
  const [up, down] = await Promise.all([machineOn("up"), machineOn("down")]);

  mac.vms.set(vmOf(up), "running");
  mac.vms.set(vmOf(down), "stopped");
  await Effect.runPromise(runtime.startup([up, down]));

  expect(existsSync(jobsDir(mac.settings.stateDir))).toBe(true);
  expect([await accepts(up.port ?? 0), await accepts(down.port ?? 0)]).toEqual([true, true]);
});

test("a port startup can't listen on is logged and the rest served, and start listens again before it boots", async () => {
  const { mac, runtime } = await runtimeOn();
  const [blocked, other] = await Promise.all([machineOn("dev"), machineOn("other")]);
  const vm = vmOf(blocked);
  const taken = createServer();
  const logged: Array<unknown> = [];
  const listenError = `the forwarder couldn't listen on 127\\.0\\.0\\.1:${blocked.port}: `;

  mac.vms.set(vm, "stopped");
  await new Promise<void>((resolve) => {
    taken.listen({ host: "127.0.0.1", port: blocked.port }, resolve);
  });

  try {
    await Effect.runPromise(
      runtime
        .startup([blocked, other])
        .pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))]))),
    );

    expect(logged).toEqual([
      [
        expect.stringMatching(
          new RegExp(`^startup: no forwarder for mac_dev: ${listenError}`, "u"),
        ),
      ],
    ]);
    expect(await accepts(other.port ?? 0)).toBe(true);

    const before = calls(mac).length;
    const error = await Effect.runPromise(Effect.flip(runtime.start(blocked)));

    expect([error._tag, error.message]).toEqual([
      "Internal",
      expect.stringMatching(new RegExp(`^${listenError}`, "u")),
    ]);
    expect(calls(mac).slice(before)).toEqual([]);
    expect(mac.vms.get(vm)).toBe("stopped");
  } finally {
    await new Promise((resolve) => {
      taken.close(resolve);
    });
  }

  await Effect.runPromise(runtime.start(blocked));
  expect(mac.vms.get(vm)).toBe("running");
  expect(await accepts(blocked.port ?? 0)).toBe(true);
});

test("delete works for a machine whose port startup couldn't listen on", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");
  const vm = vmOf(machine);
  const taken = createServer();

  mac.vms.set(vm, "stopped");
  await new Promise<void>((resolve) => {
    taken.listen({ host: "127.0.0.1", port: machine.port }, resolve);
  });

  try {
    await Effect.runPromise(runtime.startup([machine]).pipe(Effect.provide(Logger.layer([]))));
    await Effect.runPromise(runtime.delete(machine));

    expect(calls(mac)).toEqual([`tart delete ${vm}`, `launchctl bootout gui/501/${vm}`]);
    expect(mac.vms.has(vm)).toBe(false);
  } finally {
    await new Promise((resolve) => {
      taken.close(resolve);
    });
  }
});

test("observe fails when tart list doesn't answer within 8 s, so the core reads every machine unknown", async () => {
  const { mac, runtime } = await runtimeOn();
  const machine = await machineOn("dev");

  mac.hooks.list = () => ({ hangs: true });

  const observing = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.flip(runtime.observe([machine])));
    let waited = Duration.zero;

    while (fiber.pollUnsafe() === undefined) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
      yield* TestClock.adjust(Duration.seconds(1));
      waited = Duration.sum(waited, Duration.seconds(1));
    }

    return [yield* Fiber.join(fiber), waited] as const;
  });

  const [error, waited] = await Effect.runPromise(
    observing.pipe(Effect.provide(TestClock.layer())),
  );

  expect(error.message).toBe("tart list didn't answer within 8s");
  expect(Duration.format(waited)).toBe("8s");
});

test("observe reads every machine's state with one tart list", async () => {
  const { mac, runtime } = await runtimeOn();

  const [up, down, gone] = await Promise.all([
    machineOn("up"),
    machineOn("down"),
    machineOn("gone"),
  ]);

  mac.vms.set(vmOf(up), "running");
  mac.vms.set(vmOf(down), "suspended");

  const before = mac.spawner.calls.length;
  const observed = await Effect.runPromise(runtime.observe([up, down, gone]));

  expect(observed).toEqual([{ state: "running" }, { state: "stopped" }, { state: "missing" }]);
  expect(mac.spawner.calls.slice(before).map(({ args }) => args)).toEqual([
    ["list", "--source", "local", "--format", "json"],
  ]);
});
