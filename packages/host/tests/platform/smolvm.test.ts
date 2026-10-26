import { mkdirSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type HostError, Internal, requirements } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Fiber, FileSystem, Layer, Logger, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { it, layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { type CheckpointRef, type MachineRef, type MachineState } from "../../src/runtime.ts";
import {
  controlSocket,
  environment,
  machineReadWait,
  make,
  nativeName,
  observeEach,
  pathsIn,
  pin,
  type Settings,
  stateOf,
  templates,
  ramBudget,
} from "../../src/platform/smolvm.ts";
import { mkdir, readDirectory, scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";
import { type Call, type Reply, scripted as scriptedSpawner } from "../scripted.ts";

const failure = (error: HostError) => [error._tag, error.message];

const encoder = new TextEncoder();

const scripted = (reply: (call: Call) => Reply | undefined) =>
  scriptedSpawner(
    (call) =>
      reply(call) ??
      (call.args[0] === "--version"
        ? { stdout: `smolvm ${requirements.smolvm.testedVersion}\n` }
        : undefined),
  );

const prepared = (expanded: ReadonlyArray<string> = templates) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* scratch;
    const prefix = join(dir, "smolvm", requirements.smolvm.testedVersion);
    const stateDir = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "cbx-" });

    yield* mkdir(prefix);

    for (const template of expanded) {
      yield* write(join(prefix, template), "");
    }

    const settings: Settings = {
      prefix,
      publishAddress: "100.95.240.37",
      ramBudgetMib: 4096,
      stateDir,
    };

    return settings;
  });

const runtimeOf = (settings: Settings, spawner: ReturnType<typeof scripted>, uid = 0) =>
  make(settings, uid).pipe(Effect.provide(Layer.merge(NodeServices.layer, spawner.layer)));

const startupError = (settings: Settings, spawner: ReturnType<typeof scripted>, uid = 0) =>
  make(settings, uid).pipe(
    Effect.flip,
    Effect.provide(Layer.merge(NodeServices.layer, spawner.layer)),
  );

const machine: MachineRef = {
  id: "linux_dev",
  name: "dev",
  instance: "0123456789abcdef0123456789abcdef",
  cpu: 2,
  ramMib: 2048,
  diskGib: 20,
  port: 10_000,
};

const smolvmArgs = (calls: ReadonlyArray<Call>) =>
  calls
    .slice(1)
    .map((call) => (call.file.endsWith("/smolvm") ? call.args : [call.file, ...call.args]));

const status = (state: string): Reply => ({
  stdout: JSON.stringify({
    name: "dev-01234567",
    state,
    cpus: 2,
    ports: 1,
    ...(state === "running" && {
      published_ports: [{ host: 10_000, guest: 22, guest_listening: "listening" }],
    }),
  }),
});

const unknown: Reply = {
  exitCode: 1,
  stderr: "Error: config operation failed: machine status: machine 'dev-01234567' not found\n",
};

layer(NodeServices.layer)((it) => {
  it("a native name is the machine's name and its instance's first 8 characters", () => {
    expect(nativeName(machine)).toBe("dev-01234567");
  });

  it.effect("the RAM budget defaults to physical RAM less 2 GiB, and a set one is kept", () =>
    Effect.gen(function* () {
      expect(yield* ramBudget(undefined)).toBe(Math.floor(totalmem() / 1024 / 1024) - 2048);
      expect(yield* ramBudget(1_000_000)).toBe(1_000_000);
    }),
  );

  it.effect(
    "every smolvm call runs the prefix's wrapper in one fixed environment, and nothing else",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => undefined);

        const runtime = yield* runtimeOf(settings, spawner);

        expect(runtime.version).toBe(requirements.smolvm.testedVersion);
        expect(spawner.calls).toEqual([
          {
            file: join(settings.prefix, "smolvm"),
            args: ["--version"],
            env: {
              PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              HOME: join(settings.stateDir, "smolvm"),
              SMOLVM_DATA_DIR: join(settings.stateDir, "smolvm"),
              SMOLVM_AGENT_ROOTFS: join(settings.prefix, ".local/share/smolvm/agent-rootfs"),
              SMOLVM_RESTORE_TMPFS: "0",
              SMOLVM_VM_USE_SCOPE: "1",
              SMOLVM_OOM_VICTIM_ORDER: "0",
              SMOLVM_USAGE: "0",
              SMOLVM_PUBLISH_ADDR: "100.95.240.37",
              SMOLVM_EGRESS_FLOOR: "strict",
              NO_COLOR: "1",
            },
            stdin: undefined,
          },
        ]);
        expect(environment(settings)).not.toHaveProperty("SMOLVM_BOOT_BINARY");
      }),
  );

  it.effect("a smolvm host refuses to start unless it runs as root", () =>
    Effect.gen(function* () {
      const spawner = scripted(() => undefined);
      const error = yield* startupError(yield* prepared(), spawner, 1000);

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toBe("a smolvm host runs as root, and this one runs as uid 1000");
      expect(spawner.calls).toEqual([]);
    }),
  );

  it.effect("a smolvm host refuses a state dir too deep for smolvm's socket paths", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();
      const deep = { ...settings, stateDir: join("/", "d".repeat(60), "state") };

      expect(Buffer.byteLength(controlSocket(pathsIn(deep.stateDir).dataDir))).toBe(122);

      const error = yield* startupError(
        deep,
        scripted(() => undefined),
      );

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toContain("past Linux's 107: use a shorter state dir");
    }),
  );

  it.effect("a smolvm host refuses a prefix whose disk templates weren't expanded at install", () =>
    Effect.gen(function* () {
      const settings = yield* prepared(["storage-template.ext4"]);
      const spawner = scripted(() => undefined);
      const error = yield* startupError(settings, spawner);
      const overlay = join(settings.prefix, "overlay-template.ext4");

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toBe(
        `smolvm prefix ${settings.prefix} has no overlay-template.ext4: expand it at install with zstd -d --sparse ${overlay}.zst -o ${overlay}`,
      );
      expect(spawner.calls).toEqual([]);
    }),
  );

  it.effect("a smolvm host refuses a smolvm release it wasn't tested on", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();

      const error = yield* startupError(
        settings,
        scripted(() => ({ stdout: "smolvm 0.0.0-test\n" })),
      );

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toBe(
        `${join(settings.prefix, "smolvm")} reports "smolvm 0.0.0-test", and this host was tested on smolvm ${requirements.smolvm.testedVersion}`,
      );
    }),
  );

  it("smolvm's paused state is its own, and the rest map onto running and stopped by whether the VMM is alive", () => {
    expect(
      Object.fromEntries(
        (
          [
            "created",
            "running",
            "stopped",
            "paused",
            "pausing",
            "failed",
            "unreachable",
            "frozen",
          ] as const
        ).map((state) => [state, stateOf(state)]),
      ),
    ).toEqual({
      created: "stopped",
      running: "running",
      stopped: "stopped",
      paused: "paused",
      pausing: "running",
      failed: "stopped",
      unreachable: "running",
      frozen: "running",
    });
  });

  it.effect("observe reads each machine's status", () =>
    Effect.gen(function* () {
      const replies = new Map([
        ["dev-01234567", status("running")],
        ["two-01234567", status("created")],
        [
          "gone-01234567",
          {
            exitCode: 1,
            stderr:
              "Error: config operation failed: machine status: machine 'gone-01234567' not found\n",
          },
        ],
      ]);

      const spawner = scripted((call) =>
        call.args[0] === "machine" ? replies.get(call.args[3] ?? "") : undefined,
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      const observed = yield* runtime.observe([
        machine,
        { ...machine, id: "linux_two", name: "two", port: 10_001 },
        { ...machine, id: "linux_gone", name: "gone", port: 10_002 },
      ]);

      expect(observed).toEqual(["running", "stopped", "missing"]);
      expect(smolvmArgs(spawner.calls).map((args) => args[3])).toEqual(
        expect.arrayContaining(["dev-01234567", "two-01234567", "gone-01234567"]),
      );
      expect(spawner.calls).toHaveLength(4);
    }),
  );

  it.effect(
    "observe reads a machine whose status fails for another reason unknown, and logs smolvm's last output",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[0] === "machine"
            ? call.args[3] === "dev-01234567"
              ? { exitCode: 1, stderr: "Error: database is locked\n" }
              : status("stopped")
            : undefined,
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const logged: Array<unknown> = [];

        const observed = yield* runtime
          .observe([machine, { ...machine, id: "linux_two", name: "two", port: 10_001 }])
          .pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))])));

        expect(observed).toEqual(["unknown", "stopped"]);
        expect(logged).toEqual([
          [
            "couldn't read linux_dev's state: smolvm machine status dev-01234567 exited 1: Error: database is locked",
          ],
        ]);
      }),
  );

  const timed = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      let waited = Duration.zero;

      while (fiber.pollUnsafe() === undefined) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        waited = Duration.sum(waited, Duration.seconds(1));
      }

      return { value: yield* Fiber.join(fiber), waited };
    });

  it.effect(
    "observe reads a status that doesn't answer unknown within 8 s, its wait for a turn included, and only its own machine",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[0] === "machine"
            ? call.args[3] === "two-01234567"
              ? status("stopped")
              : { hangs: true }
            : undefined,
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const hanging = Array.from({ length: 9 }, (_, index) => ({
          ...machine,
          id: `linux_h${index}`,
          name: `h${index}`,
        }));

        const { value, waited } = yield* timed(
          runtime
            .observe([{ ...machine, id: "linux_two", name: "two" }, ...hanging])
            .pipe(Effect.provide(Logger.layer([]))),
        );

        expect(Duration.format(waited)).toBe("8s");
        expect(value).toEqual(["stopped", ...hanging.map(() => "unknown")]);
      }),
  );

  it.effect(
    "create makes the machine with its sizes and published port, then boots it branchable",
    () =>
      Effect.gen(function* () {
        const spawner = scripted(() => undefined);
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.create(machine, requirements.bases.linux.ubuntu);

        expect(smolvmArgs(spawner.calls)).toEqual([
          [
            "machine",
            "create",
            "--name",
            "dev-01234567",
            "--image",
            requirements.bases.linux.ubuntu,
            "--cpus",
            "2",
            "--mem",
            "2048",
            "--net",
            "--net-backend",
            "virtio-net",
            "-p",
            "10000:22",
            "--storage",
            "20",
          ],
          ["machine", "start", "--name", "dev-01234567", "--branchable"],
        ]);
      }),
  );

  it.effect("a failed machine create fails with smolvm's last output and boots nothing", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args[1] === "create" ? { exitCode: 1, stderr: "Error: image not found\n" } : undefined,
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      const error = yield* Effect.flip(
        runtime.create(machine, "mirror.gcr.io/library/ubuntu@sha256:00"),
      );

      expect(error._tag).toBe("Internal");
      expect(error.message).toBe(
        "smolvm machine create dev-01234567 exited 1: Error: image not found",
      );
      expect(smolvmArgs(spawner.calls)).toHaveLength(1);
    }),
  );

  it.effect(
    "start reads the status, then boots a stopped machine branchable, and stop reads it, then is machine stop, its failure returned as it is",
    () =>
      Effect.gen(function* () {
        let booted = false;

        const spawner = scripted((call) => {
          if (call.args[1] === "status") {
            return status(booted ? "running" : "stopped");
          }

          if (call.args[1] === "start") {
            booted = true;
          }

          return call.args[1] === "stop"
            ? {
                exitCode: 1,
                stderr: "Error: guest did not confirm the flush; left the VM alive for retry\n",
              }
            : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.start(machine);
        const error = yield* Effect.flip(runtime.stop(machine));

        expect(error.message).toBe(
          "smolvm machine stop dev-01234567 exited 1: Error: guest did not confirm the flush; left the VM alive for retry",
        );
        expect(smolvmArgs(spawner.calls)).toEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "start", "--name", "dev-01234567", "--branchable"],
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "stop", "--name", "dev-01234567"],
        ]);
      }),
  );

  it.effect(
    "stop of a stopped machine, or one smolvm doesn't know, reads its status and stops nothing",
    () =>
      Effect.gen(function* () {
        for (const reply of [status("stopped"), unknown]) {
          const spawner = scripted((call) => (call.args[1] === "status" ? reply : undefined));
          const runtime = yield* runtimeOf(yield* prepared(), spawner);

          yield* runtime.stop(machine);

          expect(smolvmArgs(spawner.calls)).toEqual([
            ["machine", "status", "--name", "dev-01234567", "--json"],
          ]);
        }
      }),
  );

  it.effect(
    "start leaves a running machine as it is, boots an unreachable one again, resumes a paused one or one a pause left part way, and refuses a frozen or missing one before anything native",
    () =>
      Effect.gen(function* () {
        let reply = status("running");

        const spawner = scripted((call) => (call.args[1] === "status" ? reply : undefined));
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        for (const next of ["running", "unreachable", "paused", "pausing"] as const) {
          reply = status(next);
          yield* runtime.start(machine);
        }

        const refusals = [];

        for (const next of [status("frozen"), unknown]) {
          reply = next;
          refusals.push(yield* Effect.flip(runtime.start(machine)));
        }

        expect(refusals.map(failure)).toEqual([
          ["WrongState", "smolvm reads machine linux_dev frozen, and doesn't start it from there"],
          ["Missing", "machine linux_dev is missing from the linux runtime; delete it"],
        ]);
        expect(smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))).toEqual([
          "status --name dev-01234567",
          "status --name dev-01234567",
          "start --name dev-01234567",
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
        ]);
      }),
  );

  it.effect(
    "pause saves a running machine, leaves a paused one, resumes one a pause left part way before pausing it again, and refuses a stopped or missing one",
    () =>
      Effect.gen(function* () {
        let reply = status("running");

        const spawner = scripted((call) => (call.args[1] === "status" ? reply : undefined));
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        for (const next of ["running", "paused", "pausing"] as const) {
          reply = status(next);
          yield* runtime.pause(machine);
        }

        const refusals = [];

        for (const next of [status("stopped"), unknown]) {
          reply = next;
          refusals.push(yield* Effect.flip(runtime.pause(machine)));
        }

        expect(refusals.map(failure)).toEqual([
          [
            "WrongState",
            "smolvm reads machine linux_dev stopped, and pauses only a running machine",
          ],
          ["Missing", "machine linux_dev is missing from the linux runtime; delete it"],
        ]);
        expect(smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))).toEqual([
          "status --name dev-01234567",
          "pause --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "pause --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
        ]);
      }),
  );

  it.effect(
    "a stopped machine is resized in one machine update and a running one in one live machine resize, each sending only the sizes that change",
    () =>
      Effect.gen(function* () {
        const spawner = scripted(() => undefined);
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.resize(machine, { cpu: 4, ramMib: 1024, diskGib: 30 }, false);
        yield* runtime.resize(machine, { cpu: 2, ramMib: 4096, diskGib: 40 }, true);
        yield* runtime.resize(machine, { cpu: 2, ramMib: 2048, diskGib: 20 }, false);

        expect(smolvmArgs(spawner.calls)).toEqual([
          [
            "machine",
            "update",
            "--name",
            "dev-01234567",
            "--cpus",
            "4",
            "--mem",
            "1024",
            "--storage",
            "30",
          ],
          ["machine", "resize", "--name", "dev-01234567", "--mem", "4096", "--storage", "40"],
        ]);
      }),
  );

  it.effect("a resize smolvm refuses fails with its last output", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args[1] === "resize"
          ? { exitCode: 1, stderr: "Error: not enough host memory for 4096 MiB\n" }
          : undefined,
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      const refused = yield* Effect.flip(
        runtime.resize(machine, { ...machine, ramMib: 4096 }, true),
      );

      expect(failure(refused)).toEqual([
        "Internal",
        "smolvm machine resize dev-01234567 exited 1: Error: not enough host memory for 4096 MiB",
      ]);
    }),
  );

  it.effect(
    "sizes reads vCPUs, RAM and storage from smolvm's status, keeping the machine's disk where it records none",
    () =>
      Effect.gen(function* () {
        let storage: number | null = 30;

        const spawner = scripted((call) =>
          call.args[1] === "status"
            ? {
                stdout: JSON.stringify({
                  state: "stopped",
                  cpus: 3,
                  memory_mib: 4096,
                  storage_gb: storage,
                }),
              }
            : undefined,
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const recorded = yield* runtime.sizes(machine);

        storage = null;

        const unrecorded = yield* runtime.sizes(machine);

        expect(recorded).toEqual({ cpu: 3, ramMib: 4096, diskGib: 30 });
        expect(unrecorded).toEqual({ cpu: 3, ramMib: 4096, diskGib: 20 });
      }),
  );

  it.effect(
    "stop resumes a paused machine, or one a pause left part way, to end its saved execution, and leaves a stopped or missing one",
    () =>
      Effect.gen(function* () {
        let reply = status("paused");

        const spawner = scripted((call) => (call.args[1] === "status" ? reply : undefined));
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        for (const next of [status("paused"), status("pausing"), status("stopped"), unknown]) {
          reply = next;
          yield* runtime.stop(machine);
        }

        expect(smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))).toEqual([
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "stop --name dev-01234567",
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "stop --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
        ]);
      }),
  );

  it.effect("a start whose status read fails fails with smolvm's output and boots nothing", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args[1] === "status"
          ? { exitCode: 1, stderr: "Error: database is locked\n" }
          : undefined,
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      const error = yield* Effect.flip(runtime.start(machine));

      expect(failure(error)).toEqual([
        "Internal",
        "smolvm machine status dev-01234567 exited 1: Error: database is locked",
      ]);
      expect(smolvmArgs(spawner.calls).map((args) => args[1])).toEqual(["status"]);
    }),
  );

  it.effect("delete of a machine smolvm doesn't know touches nothing native", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) => (call.args[1] === "status" ? unknown : undefined));
      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* runtime.delete(machine);

      expect(smolvmArgs(spawner.calls)).toEqual([
        ["machine", "status", "--name", "dev-01234567", "--json"],
      ]);
    }),
  );

  it.effect(
    "delete stops a running machine, giving its workload no time, finds its scope gone, then deletes it",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) => {
          if (call.file === "systemctl") {
            return { stdout: "not-found\n" };
          }

          return call.args[1] === "status" ? status("running") : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.delete(machine);

        expect(smolvmArgs(spawner.calls)).toEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "stop", "--name", "dev-01234567", "--timeout", "0"],
          ["systemctl", "show", "--property=LoadState", "--value", "smolvm-vm-dev-01234567.scope"],
          ["machine", "delete", "--name", "dev-01234567", "--force"],
        ]);
      }),
  );

  it.effect("delete of a stopped machine deletes it without a stop", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args[1] === "status" ? status("stopped") : undefined,
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* runtime.delete(machine);

      expect(smolvmArgs(spawner.calls)).toEqual([
        ["machine", "status", "--name", "dev-01234567", "--json"],
        ["systemctl", "show", "--property=LoadState", "--value", "smolvm-vm-dev-01234567.scope"],
        ["machine", "delete", "--name", "dev-01234567", "--force"],
      ]);
    }),
  );

  it.effect(
    "delete of a machine smolvm reads stopped kills the VMM its scope still holds, as a host killed mid-boot leaves it",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) => {
          if (call.file === "systemctl" && call.args[0] === "show") {
            return { stdout: "loaded\n" };
          }

          return call.args[1] === "status" ? status("stopped") : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.delete(machine);

        expect(smolvmArgs(spawner.calls)).toEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["systemctl", "show", "--property=LoadState", "--value", "smolvm-vm-dev-01234567.scope"],
          ["systemctl", "kill", "--signal=SIGKILL", "smolvm-vm-dev-01234567.scope"],
          ["machine", "delete", "--name", "dev-01234567", "--force"],
          ["systemctl", "reset-failed", "smolvm-vm-dev-01234567.scope"],
        ]);
      }),
  );

  it.effect(
    "delete kills the VM's scope when its stop fails, then deletes it and unloads the scope",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) => {
          if (call.args[1] === "status") {
            return status("running");
          }

          if (call.file === "systemctl" && call.args[0] === "show") {
            return { stdout: "loaded\n" };
          }

          return call.args[1] === "stop"
            ? { exitCode: 1, stderr: "Error: left the VM alive\n" }
            : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.delete(machine);

        expect(smolvmArgs(spawner.calls)).toEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "stop", "--name", "dev-01234567", "--timeout", "0"],
          ["systemctl", "show", "--property=LoadState", "--value", "smolvm-vm-dev-01234567.scope"],
          ["systemctl", "kill", "--signal=SIGKILL", "smolvm-vm-dev-01234567.scope"],
          ["machine", "delete", "--name", "dev-01234567", "--force"],
          ["systemctl", "reset-failed", "smolvm-vm-dev-01234567.scope"],
        ]);
      }),
  );

  it.effect(
    "delete fails when the scope can't be killed after a failed stop, and deletes nothing",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) => {
          if (call.args[1] === "status") {
            return status("unreachable");
          }

          if (call.file === "systemctl" && call.args[0] === "show") {
            return { stdout: "loaded\n" };
          }

          return call.args[1] === "stop" || call.file === "systemctl"
            ? { exitCode: 1, stderr: "Failed\n" }
            : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const error = yield* Effect.flip(runtime.delete(machine));

        expect(error.message).toBe("systemctl kill smolvm-vm-dev-01234567.scope exited 1: Failed");
        expect(smolvmArgs(spawner.calls).at(-1)).toEqual([
          "systemctl",
          "kill",
          "--signal=SIGKILL",
          "smolvm-vm-dev-01234567.scope",
        ]);
      }),
  );

  it.effect(
    "exec runs the command as given, as root, with its stdin, and passes on its output and exit code",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "exec" ? { exitCode: 3, stdout: "out\n", stderr: "err\n" } : undefined,
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const [output, exitCode] = yield* Effect.scoped(
          Effect.flatMap(
            runtime.exec(machine, {
              argv: ["/bin/sh", "-c", "cat >/dev/null"],
              stdin: encoder.encode("the input"),
            }),
            (execution) =>
              Effect.all([
                Stream.mkString(Stream.decodeText(execution.output)),
                execution.exitCode,
              ]),
          ),
        );

        expect([output, exitCode]).toEqual(["out\nerr\n", 3]);
        expect(spawner.calls.at(-1)).toMatchObject({
          args: [
            "machine",
            "exec",
            "--name",
            "dev-01234567",
            "--user",
            "root",
            "-i",
            "--",
            "/bin/sh",
            "-c",
            "cat >/dev/null",
          ],
          stdin: "the input",
        });
      }),
  );

  it.effect("exec runs the command as the user it names", () =>
    Effect.gen(function* () {
      const spawner = scripted(() => undefined);
      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* Effect.scoped(
        Effect.flatMap(
          runtime.exec(machine, { argv: ["true"], user: "user" }),
          (execution) => execution.exitCode,
        ),
      );

      expect(spawner.calls.at(-1)?.args).toEqual([
        "machine",
        "exec",
        "--name",
        "dev-01234567",
        "--user",
        "user",
        "-i",
        "--",
        "true",
      ]);
    }),
  );

  it.effect(
    "an exec that can't start fails without its command line, which can carry a script",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => undefined);
        const missing = join(settings.prefix, "missing");

        const failing = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args[0] === "machine"
            ? Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (node) =>
                node.spawn(ChildProcess.make(missing, command.args)),
              ).pipe(Effect.provide(NodeServices.layer))
            : Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (inner) =>
                inner.spawn(command),
              ).pipe(Effect.provide(spawner.layer)),
        );

        const runtime = yield* make(settings, 0).pipe(
          Effect.provide(
            Layer.merge(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, failing),
            ),
          ),
        );

        const error = yield* Effect.flip(
          Effect.scoped(runtime.exec(machine, { argv: ["/bin/sh", "-c", "the secret script"] })),
        );

        expect(error.message).toBe("smolvm machine exec dev-01234567: NotFound: spawn");
      }),
  );

  it.effect("admit refuses with Capacity when running machines would pass the RAM budget", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args[1] === "status" ? status("running") : undefined,
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);
      const other = { ...machine, id: "linux_other", name: "other", ramMib: 3072 };

      const error = yield* Effect.flip(
        runtime.admit({
          action: "startMachine",
          machine,
          machines: [
            { machine, booting: true },
            { machine: other, booting: false },
          ],
        }),
      );

      expect(error._tag).toBe("Capacity");
    }),
  );

  it.effect(
    "capacity is the RAM budget and what admit counts toward it, every running or booting machine's RAM, each once, and their cpu; a machine whose state can't be read leaves both unread",
    () =>
      Effect.gen(function* () {
        const replies = new Map<string, Reply>([
          ["dev-01234567", status("running")],
          ["two-01234567", status("created")],
        ]);

        const spawner = scripted((call) =>
          call.args[0] === "machine" ? replies.get(call.args[3] ?? "") : undefined,
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const held = [
          { machine, booting: false },
          { machine: { ...machine, id: "linux_two", name: "two", ramMib: 1024 }, booting: false },
          { machine: { ...machine, id: "linux_boot", name: "boot", ramMib: 512 }, booting: true },
        ];

        const next = (ramMib: number) => {
          const target = { ...machine, id: "linux_next", name: "next", ramMib };

          return runtime.admit({
            action: "createMachine",
            machine: target,
            machines: [...held, { machine: target, booting: true }],
          });
        };

        const capacity = yield* runtime.capacity(held);

        yield* next(4096 - 2560);

        const refused = yield* Effect.flip(next(4096 - 2560 + 1));

        replies.set("two-01234567", { exitCode: 1, stderr: "Error: database is locked\n" });

        const unread = yield* runtime.capacity(held);

        expect(capacity).toEqual([
          { resource: "cpu", used: 4 },
          { resource: "ramMib", limit: 4096, used: 2560 },
        ]);
        expect(refused.message).toContain(
          "needs 1537M of RAM, and 1.5G of the host's 4G budget is free",
        );
        expect(unread).toEqual([
          { resource: "cpu", unread: ["linux_two"] },
          { resource: "ramMib", limit: 4096, unread: ["linux_two"] },
        ]);
      }),
  );

  const ramCheckpoint: CheckpointRef = {
    id: "linux_snap",
    name: "snap",
    instance: "fedcba9876543210fedcba9876543210",
    port: 10_000,
    cpu: 2,
    ramMib: 2048,
    diskGib: 20,
  };

  const unknownCopy: Reply = {
    exitCode: 1,
    stderr: "Error: config operation failed: machine status: machine 'copy-abcdefab' not found\n",
  };

  const copy: MachineRef = {
    ...machine,
    id: "linux_copy",
    name: "copy",
    instance: "abcdefabcdefabcdefabcdefabcdefab",
    port: 10_001,
  };

  it.effect("the runtime names its pin", () =>
    Effect.gen(function* () {
      const runtime = yield* runtimeOf(
        yield* prepared(),
        scripted(() => undefined),
      );

      expect(runtime.pin).toBe(pin);
    }),
  );

  it.effect("startup empties the forks area and makes the runtime's directories", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();
      const paths = pathsIn(settings.stateDir);

      const runtime = yield* runtimeOf(
        settings,
        scripted(() => undefined),
      );

      yield* mkdir(join(paths.forks, "old-01234567", "old-01234567.checkpoint"));
      yield* runtime.startup([machine]);

      expect(yield* readDirectory(paths.forks)).toEqual([]);
      expect((yield* readDirectory(settings.stateDir)).sort()).toEqual(["checkpoints", "forks"]);
    }),
  );

  it.effect(
    "a capture or a fork of a machine smolvm doesn't read running is refused before anything native",
    () =>
      Effect.gen(function* () {
        let reply = status("stopped");

        const spawner = scripted((call) => (call.args[1] === "status" ? reply : undefined));
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const capture = yield* Effect.flip(runtime.capture(machine, ramCheckpoint));
        const fork = yield* Effect.flip(runtime.fork(machine, copy));

        reply = unknown;

        const missing = yield* Effect.flip(runtime.capture(machine, ramCheckpoint));

        reply = status("unreachable");

        const unreachable = yield* Effect.flip(runtime.fork(machine, copy));

        reply = status("frozen");

        const frozen = yield* Effect.flip(runtime.capture(machine, ramCheckpoint));

        reply = status("paused");

        const paused = yield* Effect.flip(runtime.fork(machine, copy));

        expect([capture, fork, missing, unreachable, frozen, paused].map(failure)).toEqual([
          [
            "WrongState",
            "a smolvm checkpoint holds a running machine's RAM, and linux_dev is stopped: start it first",
          ],
          [
            "WrongState",
            "a fork copies a running machine, RAM included, and linux_dev is stopped: start it first",
          ],
          ["Missing", "machine linux_dev is missing from the linux runtime; delete it"],
          [
            "WrongState",
            "smolvm reads machine linux_dev unreachable: its VM runs, but its agent doesn't answer; start it to boot it again",
          ],
          [
            "WrongState",
            "smolvm reads machine linux_dev frozen, and copies only a running machine",
          ],
          [
            "WrongState",
            "smolvm reads machine linux_dev paused, and copies only a running machine",
          ],
        ]);
        expect(smolvmArgs(spawner.calls).map((args) => args[1])).toEqual([
          "status",
          "status",
          "status",
          "status",
          "status",
          "status",
        ]);
      }),
  );

  it.effect("a ram capture goes into the host's one store, with no history", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();

      const spawner = scripted((call) =>
        call.args[1] === "status" ? status("running") : undefined,
      );

      const runtime = yield* runtimeOf(settings, spawner);
      const store = join(settings.stateDir, "checkpoints");

      yield* runtime.capture(machine, ramCheckpoint);

      expect(smolvmArgs(spawner.calls)).toEqual([
        ["machine", "status", "--name", "dev-01234567", "--json"],
        [
          "machine",
          "checkpoint",
          "--name",
          "dev-01234567",
          "--store",
          store,
          "--output",
          join(store, "snap-fedcba98.checkpoint"),
          "--history",
          "0",
        ],
      ]);
    }),
  );

  it.effect(
    "a ram restore creates from the store with no restore cache, moves the port, then boots",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => undefined);
        const runtime = yield* runtimeOf(settings, spawner);

        yield* runtime.restore(ramCheckpoint, copy);

        expect(smolvmArgs(spawner.calls)).toEqual([
          [
            "machine",
            "create",
            "--name",
            "copy-abcdefab",
            "--from",
            join(settings.stateDir, "checkpoints", "snap-fedcba98.checkpoint"),
            "--restore-cache-entries",
            "0",
          ],
          [
            "machine",
            "update",
            "--name",
            "copy-abcdefab",
            "--remove-port",
            "10000:22",
            "-p",
            "10001:22",
          ],
          ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
        ]);
      }),
  );

  it.effect("a ram restore that got its source's old port keeps it", () =>
    Effect.gen(function* () {
      const spawner = scripted(() => undefined);
      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* runtime.restore(ramCheckpoint, { ...copy, port: 10_000 });

      expect(smolvmArgs(spawner.calls).map((args) => args[1])).toEqual(["create", "start"]);
    }),
  );

  it.effect(
    "a ram restore or fork given larger sizes than its source's grows the copy live once it boots",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "status" ? status("running") : undefined,
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const larger = { ...copy, port: 10_000, cpu: 4, ramMib: 4096, diskGib: 30 };

        yield* runtime.restore(ramCheckpoint, larger);
        yield* runtime.fork(machine, { ...larger, cpu: 2 });

        const resizes = smolvmArgs(spawner.calls).filter((args) => args[1] === "resize");

        expect(resizes).toEqual([
          [
            "machine",
            "resize",
            "--name",
            nativeName(copy),
            "--cpus",
            "4",
            "--mem",
            "4096",
            "--storage",
            "30",
          ],
          ["machine", "resize", "--name", nativeName(copy), "--mem", "4096", "--storage", "30"],
        ]);
        expect(
          smolvmArgs(spawner.calls)
            .slice(0, 3)
            .map((args) => args[1]),
        ).toEqual(["create", "start", "resize"]);
      }),
  );

  it.effect(
    "a restore whose port move or boot fails returns its error, and leaves its VM to delete",
    () =>
      Effect.gen(function* () {
        for (const failing of ["update", "start"]) {
          const spawner = scripted((call) =>
            call.args[1] === failing
              ? { exitCode: 1, stderr: "Error: database is locked\n" }
              : undefined,
          );

          const runtime = yield* runtimeOf(yield* prepared(), spawner);
          const error = yield* Effect.flip(runtime.restore(ramCheckpoint, copy));

          expect(error.message).toBe(
            `smolvm machine ${failing} copy-abcdefab exited 1: Error: database is locked`,
          );
          expect(smolvmArgs(spawner.calls).map((args) => args[1])).toEqual(
            failing === "update" ? ["create", "update"] : ["create", "update", "start"],
          );
        }
      }),
  );

  const forking = (create: Reply) =>
    scripted((call) => {
      if (call.args[1] === "checkpoint") {
        mkdirSync(call.args[call.args.indexOf("--output") + 1] ?? "", { recursive: true });

        return {};
      }

      if (call.args[1] === "status") {
        return call.args[3] === "dev-01234567" ? status("running") : unknownCopy;
      }

      return call.args[1] === "create" ? create : undefined;
    });

  it.effect(
    "a fork captures into a store of its own, restores from it, and removes the store",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = forking({});
        const runtime = yield* runtimeOf(settings, spawner);
        const store = join(settings.stateDir, "forks", "copy-abcdefab");

        yield* runtime.startup([machine]);
        yield* runtime.fork(machine, copy);

        expect(smolvmArgs(spawner.calls)).toEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          [
            "machine",
            "checkpoint",
            "--name",
            "dev-01234567",
            "--store",
            store,
            "--output",
            join(store, "copy-abcdefab.checkpoint"),
            "--history",
            "0",
          ],
          [
            "machine",
            "create",
            "--name",
            "copy-abcdefab",
            "--from",
            join(store, "copy-abcdefab.checkpoint"),
            "--restore-cache-entries",
            "0",
          ],
          [
            "machine",
            "update",
            "--name",
            "copy-abcdefab",
            "--remove-port",
            "10000:22",
            "-p",
            "10001:22",
          ],
          ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
        ]);
        expect(yield* readDirectory(join(settings.stateDir, "forks"))).toEqual([]);
      }),
  );

  it.effect("a fork that fails still removes its store", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();

      const runtime = yield* runtimeOf(
        settings,
        forking({ exitCode: 1, stderr: "Error: no space\n" }),
      );

      yield* runtime.startup([machine]);

      const error = yield* Effect.flip(runtime.fork(machine, copy));

      expect(error.message).toBe("smolvm machine create copy-abcdefab exited 1: Error: no space");
      expect(yield* readDirectory(join(settings.stateDir, "forks"))).toEqual([]);
    }),
  );

  it.effect("deleting a ram checkpoint removes its directory, then prunes the store", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();
      const spawner = scripted(() => undefined);
      const runtime = yield* runtimeOf(settings, spawner);
      const store = join(settings.stateDir, "checkpoints");

      yield* mkdir(join(store, "snap-fedcba98.checkpoint", "objects"));
      yield* mkdir(join(store, "objects"));
      yield* runtime.deleteCheckpoint(ramCheckpoint);

      expect(yield* readDirectory(store)).toEqual(["objects"]);
      expect(smolvmArgs(spawner.calls)).toEqual([
        ["machine", "checkpoint-prune", "--store", store],
      ]);
    }),
  );

  it.effect("deleting a ram checkpoint from a store no capture has written prunes nothing", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();
      const spawner = scripted(() => undefined);
      const runtime = yield* runtimeOf(settings, spawner);

      yield* runtime.startup([machine]);
      yield* runtime.deleteCheckpoint(ramCheckpoint);

      expect(smolvmArgs(spawner.calls)).toEqual([]);
    }),
  );
});

const observed = (name: string): MachineRef => ({
  id: `linux_${name}`,
  name,
  instance: name.padStart(32, "0"),
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: 10_000,
});

const machines = ["a", "b", "c", "d"].map(observed);

const logging = (logged: Array<unknown>) =>
  Logger.layer([Logger.make(({ message }) => logged.push(message))]);

it.effect("each machine's state comes back in the machines' order", () =>
  Effect.gen(function* () {
    const states: ReadonlyArray<MachineState> = ["running", "stopped", "missing", "running"];

    const read = yield* observeEach(machines, (machine) =>
      Effect.succeed(states[machines.indexOf(machine)] ?? "unknown"),
    );

    expect(read).toEqual(states);
  }),
);

it.effect("a read that fails reads unknown, warns why, and leaves the others", () =>
  Effect.gen(function* () {
    const logged: Array<unknown> = [];

    const read = yield* observeEach(machines, (machine) =>
      machine.name === "b"
        ? Effect.fail(new Internal({ message: "smolvm machine status exited 1" }))
        : Effect.succeed<MachineState>("running"),
    ).pipe(Effect.provide(logging(logged)));

    expect(read).toEqual(["running", "unknown", "running", "running"]);
    expect(logged).toEqual([["couldn't read linux_b's state: smolvm machine status exited 1"]]);
  }),
);

it.effect(
  "a read that takes over machineReadWait reads unknown, and the others don't wait on it",
  () =>
    Effect.gen(function* () {
      const logged: Array<unknown> = [];

      const fiber = yield* Effect.forkChild(
        observeEach(machines, (machine) =>
          machine.name === "c" ? Effect.never : Effect.succeed<MachineState>("stopped"),
        ).pipe(Effect.provide(logging(logged))),
      );

      yield* TestClock.adjust(machineReadWait);

      const read = yield* Fiber.join(fiber);

      expect(read).toEqual(["stopped", "stopped", "unknown", "stopped"]);
      expect(logged).toEqual([
        [`couldn't read linux_c's state: no answer within ${Duration.format(machineReadWait)}`],
      ]);
    }),
);

it.effect("no more than 8 reads run at once", () =>
  Effect.gen(function* () {
    let running = 0;
    let most = 0;

    yield* observeEach(
      Array.from({ length: 12 }, (_, index) => observed(`m${index}`)),
      () =>
        Effect.gen(function* (): Effect.fn.Return<MachineState> {
          running += 1;
          most = Math.max(most, running);

          yield* Effect.yieldNow;

          running -= 1;

          return "running" satisfies MachineState;
        }),
    );

    expect(most).toBe(8);
  }),
);
