/**
 * The smolvm runtime over a scripted process spawner: the calls it makes, their environment,
 * and how it reads smolvm's answers. No VM runs here.
 */
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterEach, expect, test } from "vite-plus/test";
import type { CheckpointRef, MachineRef } from "../src/runtime.ts";
import {
  controlSocket,
  environment,
  make,
  nativeName,
  pathsIn,
  pin,
  type Settings,
  stateOf,
  templates,
  testedVersion,
} from "../src/smolvm.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

afterEach(() => removeScratch(owned));

/** One process the runtime started. */
interface Call {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env: unknown;
  readonly stdin: string | undefined;
}

/** What a scripted process prints and how it exits. */
interface Reply {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const encoder = new TextEncoder();

/**
 * A spawner that runs nothing: each process answers with `reply(call)`. `--version` answers
 * the tested version unless `reply` says otherwise.
 */
const scripted = (reply: (call: Call) => Reply | undefined) => {
  const calls: Array<Call> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("the runtime runs no pipelines");
      }

      const input = command.options.stdin;

      const stdin = Stream.isStream(input)
        ? yield* Stream.mkString(Stream.decodeText(input))
        : undefined;

      const call: Call = {
        file: command.command,
        args: command.args,
        env: command.options.env,
        stdin,
      };

      calls.push(call);

      const answer =
        reply(call) ??
        (call.args[0] === "--version" ? { stdout: `smolvm ${testedVersion}\n` } : {});

      const stdout = answer.stdout ?? "";
      const stderr = answer.stderr ?? "";

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.make(encoder.encode(stderr)),
        all: Stream.make(encoder.encode(stdout + stderr)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );

  return { calls, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
};

/**
 * A prefix with its templates expanded, and a state dir short enough for smolvm's sockets: under
 * `/tmp`, as the system's temporary directory can be too deep on macOS.
 */
const prepared = async (expanded: ReadonlyArray<string> = templates): Promise<Settings> => {
  const dir = await scratch(owned);
  const prefix = join(dir, "smolvm", testedVersion);
  const stateDir = await mkdtemp("/tmp/cbx-");

  owned.push(stateDir);
  await mkdir(prefix, { recursive: true });

  for (const template of expanded) {
    await writeFile(join(prefix, template), "");
  }

  return { prefix, publishAddress: "100.95.240.37", ramBudgetMib: 4096, stateDir };
};

const runtimeOf = (settings: Settings, spawner: ReturnType<typeof scripted>, uid = 0) =>
  make(settings, uid).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, spawner.layer)),
    Effect.runPromise,
  );

const startupError = (settings: Settings, spawner: ReturnType<typeof scripted>, uid = 0) =>
  make(settings, uid).pipe(
    Effect.flip,
    Effect.provide(Layer.merge(NodeServices.layer, spawner.layer)),
    Effect.runPromise,
  );

const machine: MachineRef = {
  id: "linux_dev",
  name: "dev",
  instance: "0123456789abcdef0123456789abcdef",
  native: undefined,
  cpu: 2,
  ramMib: 2048,
  diskGib: 20,
  port: 10_000,
};

/** The arguments of each smolvm call after the startup version check. */
const smolvmArgs = (calls: ReadonlyArray<Call>) =>
  calls
    .slice(1)
    .map((call) => (call.file.endsWith("/smolvm") ? call.args : [call.file, ...call.args]));

const status = (state: string): Reply => ({
  stdout: JSON.stringify({ name: "dev-01234567", state, cpus: 2 }),
});

const unknown: Reply = {
  exitCode: 1,
  stderr: "Error: config operation failed: machine status: machine 'dev-01234567' not found\n",
};

test("a native name is the machine's name and its instance's first 8 characters", () => {
  expect(nativeName(machine)).toBe("dev-01234567");
});

test("every smolvm call runs the prefix's wrapper in the spikes' environment, and nothing else", async () => {
  const settings = await prepared();
  const spawner = scripted(() => undefined);

  const runtime = await runtimeOf(settings, spawner);

  expect(runtime.version).toBe("1.22.2");
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
        SMOLVM_PUBLISH_ADDR: "100.95.240.37",
        SMOLVM_EGRESS_FLOOR: "strict",
        NO_COLOR: "1",
      },
      stdin: undefined,
    },
  ]);
  expect(environment(settings)).not.toHaveProperty("SMOLVM_BOOT_BINARY");
});

test("a smolvm host refuses to start unless it runs as root", async () => {
  const spawner = scripted(() => undefined);
  const error = await startupError(await prepared(), spawner, 1000);

  expect(error._tag).toBe("Precondition");
  expect(error.message).toBe("a smolvm host runs as root, and this one runs as uid 1000");
  expect(spawner.calls).toEqual([]);
});

test("a smolvm host refuses a state dir too deep for smolvm's socket paths", async () => {
  const settings = await prepared();
  const deep = { ...settings, stateDir: join("/", "d".repeat(60), "state") };

  expect(Buffer.byteLength(controlSocket(pathsIn(deep.stateDir).dataDir))).toBe(122);

  const error = await startupError(
    deep,
    scripted(() => undefined),
  );

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("past Linux's 107: use a shorter state dir");
});

test("a smolvm host refuses a prefix whose disk templates weren't expanded at install", async () => {
  const settings = await prepared(["storage-template.ext4"]);
  const spawner = scripted(() => undefined);
  const error = await startupError(settings, spawner);
  const overlay = join(settings.prefix, "overlay-template.ext4");

  expect(error._tag).toBe("Precondition");
  expect(error.message).toBe(
    `smolvm prefix ${settings.prefix} has no overlay-template.ext4: expand it at install with zstd -d --sparse ${overlay}.zst -o ${overlay}`,
  );
  expect(spawner.calls).toEqual([]);
});

test("a smolvm host refuses a smolvm release it wasn't tested on", async () => {
  const settings = await prepared();

  const error = await startupError(
    settings,
    scripted(() => ({ stdout: "smolvm 1.22.3\n" })),
  );

  expect(error._tag).toBe("Precondition");
  expect(error.message).toBe(
    `${join(settings.prefix, "smolvm")} reports "smolvm 1.22.3", and this host was tested on smolvm 1.22.2`,
  );
});

test("smolvm's states map onto running and stopped by whether the VMM is alive", () => {
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
    paused: "stopped",
    pausing: "running",
    failed: "stopped",
    unreachable: "running",
    frozen: "running",
  });
});

test("observe reads one machine's status, and reports its published port unless it is missing", async () => {
  let reply = status("running");
  const spawner = scripted((call) => (call.args[0] === "machine" ? reply : undefined));
  const runtime = await runtimeOf(await prepared(), spawner);

  expect(await Effect.runPromise(runtime.observe(machine))).toEqual({
    state: "running",
    ssh: { host: "100.95.240.37", port: 10_000 },
  });

  reply = status("created");
  expect((await Effect.runPromise(runtime.observe(machine))).state).toBe("stopped");

  reply = unknown;
  expect(await Effect.runPromise(runtime.observe(machine))).toEqual({ state: "missing" });

  expect(smolvmArgs(spawner.calls)).toEqual(
    Array.from({ length: 3 }, () => ["machine", "status", "--name", "dev-01234567", "--json"]),
  );
});

test("observe fails with smolvm's last output when status fails for another reason", async () => {
  const spawner = scripted((call) =>
    call.args[0] === "machine" ? { exitCode: 1, stderr: "Error: database is locked\n" } : undefined,
  );

  const runtime = await runtimeOf(await prepared(), spawner);
  const error = await Effect.runPromise(Effect.flip(runtime.observe(machine)));

  expect(error._tag).toBe("Internal");
  expect(error.message).toBe(
    "smolvm machine status dev-01234567 exited 1: Error: database is locked",
  );
});

test("create makes the machine with its sizes and published port, then boots it branchable", async () => {
  const spawner = scripted(() => undefined);
  const runtime = await runtimeOf(await prepared(), spawner);

  const image =
    "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

  await Effect.runPromise(runtime.create(machine, image));

  expect(smolvmArgs(spawner.calls)).toEqual([
    [
      "machine",
      "create",
      "--name",
      "dev-01234567",
      "--image",
      image,
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
});

test("a failed machine create fails with smolvm's last output and boots nothing", async () => {
  const spawner = scripted((call) =>
    call.args[1] === "create" ? { exitCode: 1, stderr: "Error: image not found\n" } : undefined,
  );

  const runtime = await runtimeOf(await prepared(), spawner);

  const error = await Effect.runPromise(
    Effect.flip(runtime.create(machine, "mirror.gcr.io/library/ubuntu@sha256:00")),
  );

  expect(error._tag).toBe("Internal");
  expect(error.message).toBe("smolvm machine create dev-01234567 exited 1: Error: image not found");
  expect(smolvmArgs(spawner.calls)).toHaveLength(1);
});

test("start boots branchable, and stop is machine stop, its failure returned as it is", async () => {
  const spawner = scripted((call) =>
    call.args[1] === "stop"
      ? {
          exitCode: 1,
          stderr: "Error: guest did not confirm the flush; left the VM alive for retry\n",
        }
      : undefined,
  );

  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(runtime.start(machine));
  const error = await Effect.runPromise(Effect.flip(runtime.stop(machine)));

  expect(error.message).toBe(
    "smolvm machine stop dev-01234567 exited 1: Error: guest did not confirm the flush; left the VM alive for retry",
  );
  expect(smolvmArgs(spawner.calls)).toEqual([
    ["machine", "start", "--name", "dev-01234567", "--branchable"],
    ["machine", "stop", "--name", "dev-01234567"],
  ]);
});

test("delete of a machine smolvm doesn't know touches nothing native", async () => {
  const spawner = scripted((call) => (call.args[1] === "status" ? unknown : undefined));
  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(runtime.delete(machine));

  expect(smolvmArgs(spawner.calls)).toEqual([
    ["machine", "status", "--name", "dev-01234567", "--json"],
  ]);
});

test("delete stops a running machine, then deletes it", async () => {
  const spawner = scripted((call) => (call.args[1] === "status" ? status("running") : undefined));
  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(runtime.delete(machine));

  expect(smolvmArgs(spawner.calls)).toEqual([
    ["machine", "status", "--name", "dev-01234567", "--json"],
    ["machine", "stop", "--name", "dev-01234567"],
    ["machine", "delete", "--name", "dev-01234567", "--force"],
  ]);
});

test("delete of a stopped machine deletes it without a stop", async () => {
  const spawner = scripted((call) => (call.args[1] === "status" ? status("stopped") : undefined));
  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(runtime.delete(machine));

  expect(smolvmArgs(spawner.calls)).toEqual([
    ["machine", "status", "--name", "dev-01234567", "--json"],
    ["machine", "delete", "--name", "dev-01234567", "--force"],
  ]);
});

test("delete kills the VM's scope when its stop fails, then deletes it and unloads the scope", async () => {
  const spawner = scripted((call) => {
    if (call.args[1] === "status") {
      return status("running");
    }

    return call.args[1] === "stop"
      ? { exitCode: 1, stderr: "Error: left the VM alive\n" }
      : undefined;
  });

  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(runtime.delete(machine));

  expect(smolvmArgs(spawner.calls)).toEqual([
    ["machine", "status", "--name", "dev-01234567", "--json"],
    ["machine", "stop", "--name", "dev-01234567"],
    ["systemctl", "kill", "--signal=SIGKILL", "smolvm-vm-dev-01234567.scope"],
    ["machine", "delete", "--name", "dev-01234567", "--force"],
    ["systemctl", "reset-failed", "smolvm-vm-dev-01234567.scope"],
  ]);
});

test("delete fails when the scope can't be killed after a failed stop, and deletes nothing", async () => {
  const spawner = scripted((call) => {
    if (call.args[1] === "status") {
      return status("unreachable");
    }

    return call.args[1] === "stop" || call.file === "systemctl"
      ? { exitCode: 1, stderr: "Failed\n" }
      : undefined;
  });

  const runtime = await runtimeOf(await prepared(), spawner);
  const error = await Effect.runPromise(Effect.flip(runtime.delete(machine)));

  expect(error.message).toBe("systemctl kill smolvm-vm-dev-01234567.scope exited 1: Failed");
  expect(smolvmArgs(spawner.calls).at(-1)).toEqual([
    "systemctl",
    "kill",
    "--signal=SIGKILL",
    "smolvm-vm-dev-01234567.scope",
  ]);
});

test("exec runs the command as given, with its stdin, and passes on its output and exit code", async () => {
  const spawner = scripted((call) =>
    call.args[1] === "exec" ? { exitCode: 3, stdout: "out\n", stderr: "err\n" } : undefined,
  );

  const runtime = await runtimeOf(await prepared(), spawner);

  const [output, exitCode] = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        runtime.exec(machine, {
          argv: ["/bin/sh", "-c", "cat >/dev/null"],
          stdin: encoder.encode("the input"),
        }),
        (execution) =>
          Effect.all([Stream.mkString(Stream.decodeText(execution.output)), execution.exitCode]),
      ),
    ),
  );

  expect([output, exitCode]).toEqual(["out\nerr\n", 3]);
  expect(spawner.calls.at(-1)).toMatchObject({
    args: [
      "machine",
      "exec",
      "--name",
      "dev-01234567",
      "-i",
      "--",
      "/bin/sh",
      "-c",
      "cat >/dev/null",
    ],
    stdin: "the input",
  });
});

test("an exec that can't start fails without its command line, which can carry a script", async () => {
  const settings = await prepared();
  const spawner = scripted(() => undefined);
  const missing = join(settings.prefix, "missing");

  // A real spawn of a missing file, whose own error names the whole command line.
  const failing = ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.args[0] === "machine"
      ? Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (node) =>
          node.spawn(ChildProcess.make(missing, command.args)),
        ).pipe(Effect.provide(NodeServices.layer))
      : Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (inner) =>
          inner.spawn(command),
        ).pipe(Effect.provide(spawner.layer)),
  );

  const runtime = await make(settings, 0).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, failing),
      ),
    ),
    Effect.runPromise,
  );

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(runtime.exec(machine, { argv: ["/bin/sh", "-c", "the secret script"] })),
    ),
  );

  expect(error.message).toBe("smolvm machine exec dev-01234567: NotFound: spawn");
});

test("admit refuses with Capacity when running machines would pass the RAM budget", async () => {
  const spawner = scripted((call) => (call.args[1] === "status" ? status("running") : undefined));
  const runtime = await runtimeOf(await prepared(), spawner);
  const other = { ...machine, id: "linux_other", name: "other", ramMib: 3072 };

  const error = await Effect.runPromise(
    Effect.flip(
      runtime.admit({
        action: "start",
        machine,
        machines: [
          { machine, holder: "start" },
          { machine: other, holder: undefined },
        ],
      }),
    ),
  );

  expect(error._tag).toBe("Capacity");
});

const ramCheckpoint: CheckpointRef = {
  id: "linux_snap",
  name: "snap",
  instance: "fedcba9876543210fedcba9876543210",
  native: undefined,
  kind: "ram",
  port: 10_000,
};

const unknownCopy: Reply = {
  exitCode: 1,
  stderr: "Error: config operation failed: machine status: machine 'copy-abcdefab' not found\n",
};

/** A machine made from a checkpoint, on its own port. */
const copy: MachineRef = {
  ...machine,
  id: "linux_copy",
  name: "copy",
  instance: "abcdefabcdefabcdefabcdefabcdefab",
  port: 10_001,
};

test("the runtime names its pin", async () => {
  const runtime = await runtimeOf(
    await prepared(),
    scripted(() => undefined),
  );

  expect(runtime.pin).toBe(pin);
});

test("startup empties the forks area and makes the runtime's directories", async () => {
  const settings = await prepared();
  const paths = pathsIn(settings.stateDir);

  const runtime = await runtimeOf(
    settings,
    scripted(() => undefined),
  );

  await mkdir(join(paths.forks, "old-01234567", "old-01234567.checkpoint"), { recursive: true });
  await Effect.runPromise(runtime.startup);

  expect(await readdir(paths.forks)).toEqual([]);
  expect((await readdir(settings.stateDir)).sort()).toEqual(["checkpoints", "forks"]);
});

test("a capture is ram, of a running machine only: a stopped one is started first", async () => {
  let reply = status("running");
  const spawner = scripted((call) => (call.args[1] === "status" ? reply : undefined));
  const runtime = await runtimeOf(await prepared(), spawner);

  const running = await Effect.runPromise(runtime.captureKind(machine));

  reply = status("stopped");

  const stopped = await Effect.runPromise(Effect.flip(runtime.captureKind(machine)));

  reply = unknown;

  const missing = await Effect.runPromise(Effect.flip(runtime.captureKind(machine)));

  expect(running).toBe("ram");
  expect(stopped).toEqual(
    new Precondition({
      message:
        "a smolvm checkpoint holds a running machine's RAM, and linux_dev is stopped: start it first",
    }),
  );
  expect(missing).toEqual(
    new Precondition({
      message: "machine linux_dev is missing from the smolvm runtime; delete it",
    }),
  );
});

test("a ram capture goes into the host's one store, with no history", async () => {
  const settings = await prepared();
  const spawner = scripted(() => undefined);
  const runtime = await runtimeOf(settings, spawner);
  const store = join(settings.stateDir, "checkpoints");

  await Effect.runPromise(runtime.capture(machine, ramCheckpoint));

  expect(smolvmArgs(spawner.calls)).toEqual([
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
});

test("a ram restore creates from the store with no restore cache, moves the port, then boots", async () => {
  const settings = await prepared();
  const spawner = scripted(() => undefined);
  const runtime = await runtimeOf(settings, spawner);

  await Effect.runPromise(runtime.restore(ramCheckpoint, copy));

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
    ["machine", "update", "--name", "copy-abcdefab", "--remove-port", "10000:22", "-p", "10001:22"],
    ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
  ]);
});

test("a ram restore that got its source's old port keeps it", async () => {
  const spawner = scripted(() => undefined);
  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(runtime.restore(ramCheckpoint, { ...copy, port: 10_000 }));

  expect(smolvmArgs(spawner.calls).map((args) => args[1])).toEqual(["create", "start"]);
});

test("a restore whose port move fails deletes the VM it made, and returns the move's error", async () => {
  const spawner = scripted((call) => {
    if (call.args[1] === "update") {
      return { exitCode: 1, stderr: "Error: database is locked\n" };
    }

    return call.args[1] === "status" ? status("created") : undefined;
  });

  const runtime = await runtimeOf(await prepared(), spawner);
  const error = await Effect.runPromise(Effect.flip(runtime.restore(ramCheckpoint, copy)));

  expect(error.message).toBe(
    "smolvm machine update copy-abcdefab exited 1: Error: database is locked",
  );
  expect(smolvmArgs(spawner.calls).map((args) => args.slice(0, 2).join(" "))).toEqual([
    "machine create",
    "machine update",
    "systemctl show",
    "machine status",
    "machine delete",
  ]);
});

test("a restore whose create fails deletes nothing: smolvm rolled it back", async () => {
  const spawner = scripted((call) => {
    if (call.args[1] === "create") {
      return { exitCode: 1, stderr: "Error: no space\n" };
    }

    return call.args[1] === "status" ? unknownCopy : undefined;
  });

  const runtime = await runtimeOf(await prepared(), spawner);
  const error = await Effect.runPromise(Effect.flip(runtime.restore(ramCheckpoint, copy)));

  expect(error.message).toBe("smolvm machine create copy-abcdefab exited 1: Error: no space");
  expect(smolvmArgs(spawner.calls).map((args) => args.slice(0, 2).join(" "))).toEqual([
    "machine create",
    "systemctl show",
    "machine status",
  ]);
});

test("a restore whose boot fails deletes the VM it made", async () => {
  const spawner = scripted((call) => {
    if (call.args[1] === "start") {
      return { exitCode: 1, stderr: "Error: crun create failed\n" };
    }

    return call.args[1] === "status" ? status("stopped") : undefined;
  });

  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(Effect.flip(runtime.restore(ramCheckpoint, copy)));

  expect(smolvmArgs(spawner.calls).at(-1)).toEqual([
    "machine",
    "delete",
    "--name",
    "copy-abcdefab",
    "--force",
  ]);
});

test("a restore whose boot is cut short kills the VMM its scope still holds, then deletes the VM", async () => {
  const spawner = scripted((call) => {
    if (call.args[1] === "start") {
      return { exitCode: 143 };
    }

    if (call.file === "systemctl" && call.args[0] === "show") {
      return { stdout: "loaded\n" };
    }

    // smolvm recorded no pid for the cut-short boot, so it reads the VM as stopped.
    return call.args[1] === "status" ? status("stopped") : undefined;
  });

  const runtime = await runtimeOf(await prepared(), spawner);

  await Effect.runPromise(Effect.flip(runtime.restore(ramCheckpoint, copy)));

  expect(smolvmArgs(spawner.calls).slice(3)).toEqual([
    ["systemctl", "show", "--property=LoadState", "--value", "smolvm-vm-copy-abcdefab.scope"],
    ["systemctl", "kill", "--signal=SIGKILL", "smolvm-vm-copy-abcdefab.scope"],
    ["machine", "status", "--name", "copy-abcdefab", "--json"],
    ["machine", "delete", "--name", "copy-abcdefab", "--force"],
    ["systemctl", "reset-failed", "smolvm-vm-copy-abcdefab.scope"],
  ]);
});

/**
 * A spawner whose `machine checkpoint` makes its output in its store, as smolvm does, whose
 * `machine create` answers `create`, and whose `machine status` knows no copy.
 */
const forking = (create: Reply) =>
  scripted((call) => {
    if (call.args[1] === "checkpoint") {
      mkdirSync(call.args[call.args.indexOf("--output") + 1] ?? "", { recursive: true });

      return {};
    }

    if (call.args[1] === "status") {
      return unknownCopy;
    }

    return call.args[1] === "create" ? create : undefined;
  });

test("a fork captures into a store of its own, restores from it, and removes the store", async () => {
  const settings = await prepared();
  const spawner = forking({});
  const runtime = await runtimeOf(settings, spawner);
  const store = join(settings.stateDir, "forks", "copy-abcdefab");

  await Effect.runPromise(runtime.startup);
  await Effect.runPromise(runtime.fork(machine, copy));

  expect(smolvmArgs(spawner.calls)).toEqual([
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
    ["machine", "update", "--name", "copy-abcdefab", "--remove-port", "10000:22", "-p", "10001:22"],
    ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
  ]);
  expect(await readdir(join(settings.stateDir, "forks"))).toEqual([]);
});

test("a fork that fails still removes its store", async () => {
  const settings = await prepared();
  const runtime = await runtimeOf(settings, forking({ exitCode: 1, stderr: "Error: no space\n" }));

  await Effect.runPromise(runtime.startup);

  const error = await Effect.runPromise(Effect.flip(runtime.fork(machine, copy)));

  expect(error.message).toBe("smolvm machine create copy-abcdefab exited 1: Error: no space");
  expect(await readdir(join(settings.stateDir, "forks"))).toEqual([]);
});

test("a fork of a machine that isn't running is refused before anything runs", async () => {
  const spawner = scripted((call) => (call.args[1] === "status" ? status("stopped") : undefined));
  const runtime = await runtimeOf(await prepared(), spawner);

  const error = await Effect.runPromise(
    Effect.flip(
      runtime.admit({
        action: "fork",
        machine: copy,
        source: machine,
        machines: [
          { machine, holder: "fork" },
          { machine: copy, holder: "fork" },
        ],
      }),
    ),
  );

  expect(error._tag).toBe("Precondition");
  expect(error.message).toBe(
    "a fork copies a running machine, RAM included, and linux_dev is stopped",
  );
});

test("deleting a ram checkpoint removes its directory, then prunes the store", async () => {
  const settings = await prepared();
  const spawner = scripted(() => undefined);
  const runtime = await runtimeOf(settings, spawner);
  const store = join(settings.stateDir, "checkpoints");

  await mkdir(join(store, "snap-fedcba98.checkpoint", "objects"), { recursive: true });
  await mkdir(join(store, "objects"));
  await Effect.runPromise(runtime.deleteCheckpoint(ramCheckpoint));

  expect(await readdir(store)).toEqual(["objects"]);
  expect(smolvmArgs(spawner.calls)).toEqual([["machine", "checkpoint-prune", "--store", store]]);
});

test("deleting a ram checkpoint from a store no capture has written prunes nothing", async () => {
  const settings = await prepared();
  const spawner = scripted(() => undefined);
  const runtime = await runtimeOf(settings, spawner);

  await Effect.runPromise(runtime.startup);
  await Effect.runPromise(runtime.deleteCheckpoint(ramCheckpoint));

  expect(smolvmArgs(spawner.calls)).toEqual([]);
});
