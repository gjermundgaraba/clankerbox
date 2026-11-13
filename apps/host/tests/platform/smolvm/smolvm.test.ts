import { mkdirSync } from "node:fs";
import path from "node:path";

import type { MachineRef } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  readDirectory,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { fetch, publish } from "../../../src/builds.ts";
import { runCommand } from "../../../src/guest.ts";
import { PortProbe } from "../../../src/machine-ports.ts";
import * as Operations from "../../../src/operations.ts";
import * as Relay from "../../../src/platform/relay.ts";
import {
  controlSocket,
  environment,
  machineReadWait,
  make,
  minimumVersion,
  nativeName,
  observeEach,
  pathsIn,
  stateOf,
  ramBudget,
} from "../../../src/platform/smolvm/smolvm.ts";
import type { Box, Settings } from "../../../src/platform/smolvm/smolvm.ts";
import * as Reach from "../../../src/reach.ts";
import { Runtime } from "../../../src/runtime.ts";
import type {
  Bind,
  Held,
  Identity,
  Interface,
  MachineState,
  Origin,
  Sized,
  Sizes,
} from "../../../src/runtime.ts";
import { scripted as scriptedSpawner } from "../../scripted.ts";
import type { Call, Reply } from "../../scripted.ts";
import { prepared, smolvmModel } from "../../smolvm-model.ts";
import {
  admitOn,
  eventually,
  filesOf,
  memoryBuildStore,
} from "../../support.ts";

const failure = (error: HostError) => [error._tag, error.message];

const image = "registry.example/ubuntu@sha256:00";

const notFound = (native: string): Reply => ({
  exitCode: 1,
  stderr: `Error: config operation failed: machine status: machine '${native}' not found\n`,
});

const scripted = (reply: (call: Call) => Reply | undefined) =>
  scriptedSpawner((call) => {
    const answer = reply(call);

    if (answer !== undefined) {
      return answer;
    }

    if (call.args[0] === "--version") {
      return { stdout: `smolvm ${minimumVersion}\n` };
    }

    if (call.args[1] === "ls") {
      return { stdout: "[]" };
    }

    return call.args[1] === "status" &&
      call.args[3]?.startsWith("base_") === true
      ? notFound(call.args[3])
      : undefined;
  });

const inGuest = (as: string, ...argv: readonly string[]) => [
  "machine",
  "exec",
  "--name",
  "dev-01234567",
  "--user",
  as,
  "-i",
  "--",
  ...argv,
];

const baseStatus = [
  "machine",
  "status",
  "--name",
  "base_b00710ad_snap-fedcba98",
  "--json",
];

const freezerStatus = [
  "machine",
  "status",
  "--name",
  "base_b00710ad_snap-fedcba98_freeze",
  "--json",
];

const listing = ["machine", "ls", "--json"];

const callsEnded: Box = { uid: 0, ended: () => Effect.succeed(true) };

const runtimeOf = (
  settings: Settings,
  spawner: ReturnType<typeof scripted>,
  box = callsEnded
) =>
  make(settings, box).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, spawner.layer))
  );

const startupError = (
  settings: Settings,
  spawner: ReturnType<typeof scripted>,
  uid = 0
) =>
  make(settings, { ...callsEnded, uid }).pipe(
    Effect.flip,
    Effect.provide(Layer.merge(NodeServices.layer, spawner.layer))
  );

const sized = (ref: Identity & Sizes): Sized => ({
  ...ref,
  handle: nativeName(ref),
});

const on = (port: number): Bind => ({ _tag: "forward", port });

const fromImage: Origin = { _tag: "image", image };

const fromCheckpoint = (checkpoint: Sized): Origin => ({
  _tag: "checkpoint",
  checkpoint,
});

const fromMachine = (source: Sized): Origin => ({
  _tag: "machine",
  machine: source,
});

const machine = sized({
  name: "dev",
  instance: "0123456789abcdef0123456789abcdef",
  cpu: 2,
  ramMib: 2048,
  diskGib: 20,
});

const smolvmArgs = (calls: readonly Call[]) =>
  calls
    .slice(1)
    .map((call) =>
      call.file.endsWith("/smolvm") ? call.args : [call.file, ...call.args]
    );

const status = (state: string): Reply => ({
  stdout: JSON.stringify({
    name: "dev-01234567",
    state,
    cpus: 2,
    ports: 1,
    ...(state === "running" && {
      published_ports: [
        { host: 10_000, guest: 22, guest_listening: "listening" },
      ],
    }),
  }),
});

const unknown: Reply = {
  exitCode: 1,
  stderr:
    "Error: config operation failed: machine status: machine 'dev-01234567' not found\n",
};

const stillAlive: Reply = {
  exitCode: 1,
  stderr:
    "Error: agent operation failed: stop agent: process 4242 still alive after stop attempts\n",
};

const inTurn =
  (...replies: Reply[]) =>
  (): Reply | undefined =>
    replies.length > 1 ? replies.shift() : replies[0];

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

const builderRef = sized({ ...machine, name: "building-1" });

const builderPort = 11_001;

const buildRef = sized({
  name: "built-0123456789abcdef",
  instance: "fedcba9876543210fedcba9876543210",
  cpu: 2,
  ramMib: 2048,
  diskGib: 20,
});

const baseOf = (checkpoint: Identity, bootId = "b00710ad") =>
  `base_${bootId}_${nativeName(checkpoint)}`;

const childOf = (name: string) =>
  sized({ ...machine, name, instance: "abcdefabcdefabcdefabcdefabcdefab" });

const basesIn = (model: ReturnType<typeof smolvmModel>) =>
  [...model.vms.keys()].filter((vm) => vm.startsWith("base_"));

const building = (model: ReturnType<typeof smolvmModel>) => {
  model.vms.set(nativeName(builderRef), {
    state: "running",
    forwards: [`${builderPort}:22`],
  });
};

const commands = (calls: readonly Call[]) =>
  calls.flatMap(({ file, args }) => {
    const at = args.indexOf("--name");

    return file.endsWith("/smolvm") && at !== -1
      ? [`${args[1]} ${args[at + 1]}`]
      : [];
  });

const logging = (logged: unknown[]) =>
  Logger.layer([Logger.make(({ message }) => logged.push(message))]);

const waitFor = <A, E>(
  read: Effect.Effect<A, E>,
  done: (value: A) => boolean
) => TestClock.withLive(eventually(read, done));

const locked: Reply = { exitCode: 1, stderr: "Error: database is locked\n" };

const live = (flag: string, size: string) => [
  "machine",
  "resize",
  "--name",
  "dev-01234567",
  flag,
  size,
];

layer(NodeServices.layer)((it) => {
  it("a native name is the machine's name and its instance's first 8 characters", () => {
    expect(nativeName(machine)).toBe("dev-01234567");
  });

  it("the RAM budget defaults to physical RAM less smolvm's own reserve, and a set one is kept", () => {
    expect(ramBudget(undefined, 16_384)).toBe(12_288);
    expect(ramBudget(undefined, 65_536)).toBe(57_344);
    expect(ramBudget(undefined, 773_120)).toBe(726_733);
    expect(ramBudget(1_000_000, 16_384)).toBe(1_000_000);
  });

  it.effect(
    "every smolvm call runs the prefix's wrapper in one fixed environment, and nothing else",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});

        const runtime = yield* runtimeOf(settings, spawner);

        expect(runtime.version).toBe(minimumVersion);
        expect(spawner.calls).toStrictEqual([
          {
            file: path.join(settings.prefix, "smolvm"),
            args: ["--version"],
            env: {
              PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              HOME: path.join(settings.stateDir, "smolvm"),
              SMOLVM_DATA_DIR: path.join(settings.stateDir, "smolvm"),
              SMOLVM_AGENT_ROOTFS: path.join(
                settings.prefix,
                ".local/share/smolvm/agent-rootfs"
              ),
              SMOLVM_RESTORE_TMPFS: "0",
              SMOLVM_VM_USE_SCOPE: "1",
              SMOLVM_OOM_VICTIM_ORDER: "0",
              SMOLVM_USAGE: "0",
              SMOLVM_PUBLISH_ADDR: "100.64.0.10",
              SMOLVM_EGRESS_FLOOR: "strict",
              NO_COLOR: "1",
            },
            stdin: undefined,
          },
        ]);
        expect(environment(settings)).not.toHaveProperty("SMOLVM_BOOT_BINARY");
      })
  );

  it.effect("a smolvm host refuses to start unless it runs as root", () =>
    Effect.gen(function* () {
      const spawner = scripted(() => {});
      const error = yield* startupError(yield* prepared(), spawner, 1000);

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toBe(
        "a smolvm host runs as root, and this one runs as uid 1000"
      );
      expect(spawner.calls).toStrictEqual([]);
    })
  );

  it.effect(
    "a smolvm host refuses a state dir too deep for smolvm's socket paths",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();

        const deep = {
          ...settings,
          stateDir: path.join("/", "d".repeat(60), "state"),
        };

        expect(
          Buffer.byteLength(controlSocket(pathsIn(deep.stateDir).dataDir))
        ).toBe(122);

        const error = yield* startupError(
          deep,
          scripted(() => {})
        );

        expect(error._tag).toBe("CannotStart");
        expect(error.message).toContain(
          "past Linux's 107: use a shorter state dir"
        );
      })
  );

  it.effect(
    "a smolvm host refuses a prefix whose disk templates weren't expanded at install",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared(["storage-template.ext4"]);
        const spawner = scripted(() => {});
        const error = yield* startupError(settings, spawner);
        const overlay = path.join(settings.prefix, "overlay-template.ext4");

        expect(error._tag).toBe("CannotStart");
        expect(error.message).toBe(
          `smolvm prefix ${settings.prefix} has no overlay-template.ext4: expand it at install with zstd -d --sparse ${overlay}.zst -o ${overlay}`
        );
        expect(spawner.calls).toStrictEqual([]);
      })
  );

  it.effect(
    "a smolvm host refuses a smolvm release older than its floor, or one it can't read",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();

        for (const reported of ["smolvm 1.33.9", "smolvm dev", "1.34.0"]) {
          const error = yield* startupError(
            settings,
            scripted(() => ({ stdout: `${reported}\n` }))
          );

          expect(error._tag).toBe("CannotStart");
          expect(error.message).toBe(
            `${path.join(settings.prefix, "smolvm")} reports "${reported}", and this host needs smolvm ${minimumVersion} or later`
          );
        }
      })
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
        ).map((state) => [state, stateOf(state)])
      )
    ).toStrictEqual({
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
        call.args[0] === "machine" ? replies.get(call.args[3] ?? "") : undefined
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      const observed = yield* runtime.observe([
        machine,
        sized({ ...machine, name: "two" }),
        sized({ ...machine, name: "gone" }),
      ]);

      expect(observed).toStrictEqual(
        new Map([
          ["dev", "running"],
          ["two", "stopped"],
          ["gone", "missing"],
        ])
      );
      expect(smolvmArgs(spawner.calls).map((args) => args[3])).toStrictEqual(
        expect.arrayContaining([
          "dev-01234567",
          "two-01234567",
          "gone-01234567",
        ])
      );
      expect(spawner.calls).toHaveLength(4);
    })
  );

  it.effect(
    "observe reads a machine whose status fails for another reason unknown, and logs smolvm's last output",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call): Reply | undefined => {
          if (call.args[0] !== "machine") {
            return undefined;
          }

          return call.args[3] === "dev-01234567"
            ? { exitCode: 1, stderr: "Error: database is locked\n" }
            : status("stopped");
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const logged: unknown[] = [];

        const observed = yield* runtime
          .observe([machine, sized({ ...machine, name: "two" })])
          .pipe(
            Effect.provide(
              Logger.layer([Logger.make(({ message }) => logged.push(message))])
            )
          );

        expect(observed).toStrictEqual(
          new Map([
            ["dev", "unknown"],
            ["two", "stopped"],
          ])
        );
        expect(logged).toStrictEqual([
          [
            "couldn't read dev's state: smolvm machine status dev-01234567 exited 1: Error: database is locked",
          ],
        ]);
      })
  );

  it.effect(
    "observe reads a status that doesn't answer unknown within 8 s, its wait for a turn included, and only its own machine",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call): Reply | undefined => {
          if (call.args[0] !== "machine") {
            return undefined;
          }

          return call.args[3] === "two-01234567"
            ? status("stopped")
            : { hangs: true };
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const hanging = Array.from({ length: 9 }, (_, index) =>
          sized({ ...machine, name: `h${index}` })
        );

        const { value, waited } = yield* timed(
          runtime
            .observe([sized({ ...machine, name: "two" }), ...hanging])
            .pipe(Effect.provide(Logger.layer([])))
        );

        expect(Duration.format(waited)).toBe("8s");
        expect(value).toStrictEqual(
          new Map([
            ["two", "stopped"],
            ...hanging.map(({ name }) => [name, "unknown"] as const),
          ])
        );
      })
  );

  it.effect(
    "create makes the machine with its sizes and published port, then boots it branchable",
    () =>
      Effect.gen(function* () {
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.make(machine, fromImage, on(10_000));

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
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
      })
  );

  it.effect(
    "a failed machine create fails with smolvm's last output and boots nothing",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "create"
            ? { exitCode: 1, stderr: "Error: image not found\n" }
            : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const error = yield* Effect.flip(
          runtime.make(
            machine,
            { _tag: "image", image: "mirror.gcr.io/library/ubuntu@sha256:00" },
            on(10_000)
          )
        );

        expect(error._tag).toBe("Internal");
        expect(error.message).toBe(
          "smolvm machine create dev-01234567 exited 1: Error: image not found"
        );
        expect(smolvmArgs(spawner.calls)).toHaveLength(1);
      })
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
                stderr:
                  "Error: guest did not confirm the flush; left the VM alive for retry\n",
              }
            : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.start(machine, new Set());
        const error = yield* Effect.flip(runtime.stop(machine));

        expect(error.message).toBe(
          "smolvm machine stop dev-01234567 exited 1: Error: guest did not confirm the flush; left the VM alive for retry"
        );
        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "start", "--name", "dev-01234567", "--branchable"],
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "stop", "--name", "dev-01234567"],
          ["machine", "status", "--name", "dev-01234567", "--json"],
        ]);
      })
  );

  it.effect(
    "a stop smolvm fails while it reads the machine unreachable, its VMM still exiting, succeeds once it reads it stopped or gone",
    () =>
      Effect.gen(function* () {
        for (const last of [status("stopped"), unknown]) {
          const statuses = inTurn(
            status("running"),
            status("unreachable"),
            status("unreachable"),
            last
          );

          const spawner = scripted((call) => {
            if (call.args[1] === "status") {
              return statuses();
            }

            return call.args[1] === "stop" ? stillAlive : undefined;
          });

          const runtime = yield* runtimeOf(yield* prepared(), spawner);

          const { waited } = yield* timed(runtime.stop(machine));

          expect(Duration.format(waited)).toBe("1s");
          expect(
            smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))
          ).toStrictEqual([
            "status --name dev-01234567",
            "stop --name dev-01234567",
            "status --name dev-01234567",
            "status --name dev-01234567",
            "status --name dev-01234567",
          ]);
        }
      })
  );

  it.effect(
    "a stop cut short while smolvm reads its VMM still exiting waits until it reads it stopped",
    () =>
      Effect.gen(function* () {
        const statuses = inTurn(
          status("running"),
          status("unreachable"),
          status("unreachable"),
          status("unreachable"),
          status("stopped")
        );

        const spawner = scripted((call) => {
          if (call.args[1] === "status") {
            return statuses();
          }

          return call.args[1] === "stop" ? stillAlive : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const stopping = yield* Effect.forkChild(runtime.stop(machine));

        while (smolvmArgs(spawner.calls).length < 3) {
          yield* Effect.yieldNow;
        }

        yield* timed(Fiber.interrupt(stopping));

        expect(
          smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))
        ).toStrictEqual([
          "status --name dev-01234567",
          "stop --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
        ]);
      })
  );

  it.effect(
    "a stop smolvm fails answers its output at once when smolvm then reads the machine running, paused or frozen",
    () =>
      Effect.gen(function* () {
        for (const after of ["running", "paused", "frozen"]) {
          const statuses = inTurn(status("running"), status(after));

          const spawner = scripted((call) => {
            if (call.args[1] === "status") {
              return statuses();
            }

            return call.args[1] === "stop" ? stillAlive : undefined;
          });

          const runtime = yield* runtimeOf(yield* prepared(), spawner);

          const error = yield* Effect.flip(runtime.stop(machine));

          expect(error.message).toBe(
            "smolvm machine stop dev-01234567 exited 1: Error: agent operation failed: stop agent: process 4242 still alive after stop attempts"
          );
          expect(
            smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))
          ).toStrictEqual([
            "status --name dev-01234567",
            "stop --name dev-01234567",
            "status --name dev-01234567",
          ]);
        }
      })
  );

  it.effect(
    "a stop smolvm fails whose status read then fails answers both outputs",
    () =>
      Effect.gen(function* () {
        const statuses = inTurn(status("running"), status("unreachable"), {
          exitCode: 1,
          stderr: "Error: database is locked\n",
        });

        const spawner = scripted((call) => {
          if (call.args[1] === "status") {
            return statuses();
          }

          return call.args[1] === "stop" ? stillAlive : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const { value: error } = yield* timed(
          Effect.flip(runtime.stop(machine))
        );

        expect(error.message).toBe(
          "smolvm machine stop dev-01234567 exited 1: Error: agent operation failed: stop agent: process 4242 still alive after stop attempts; then smolvm machine status dev-01234567 exited 1: Error: database is locked"
        );
      })
  );

  it.effect(
    "a stop smolvm fails while it reads the machine unreachable for 30 s fails with its output",
    () =>
      Effect.gen(function* () {
        const statuses = inTurn(status("running"), status("unreachable"));

        const spawner = scripted((call) => {
          if (call.args[1] === "status") {
            return statuses();
          }

          return call.args[1] === "stop" ? stillAlive : undefined;
        });

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const { value: error, waited } = yield* timed(
          Effect.flip(runtime.stop(machine))
        );

        expect(Duration.format(waited)).toBe("30s");
        expect(error.message).toBe(
          "smolvm machine stop dev-01234567 exited 1: Error: agent operation failed: stop agent: process 4242 still alive after stop attempts; smolvm still read it unreachable 30s later"
        );
      })
  );

  it.effect(
    "stop of a stopped machine, or one smolvm doesn't know, reads its status and stops nothing",
    () =>
      Effect.gen(function* () {
        for (const reply of [status("stopped"), unknown]) {
          const spawner = scripted((call) =>
            call.args[1] === "status" ? reply : undefined
          );

          const runtime = yield* runtimeOf(yield* prepared(), spawner);

          yield* runtime.stop(machine);

          expect(smolvmArgs(spawner.calls)).toStrictEqual([
            ["machine", "status", "--name", "dev-01234567", "--json"],
          ]);
        }
      })
  );

  it.effect(
    "start leaves a running machine as it is, boots an unreachable one again, resumes a paused one or one a pause left part way, and refuses a frozen or missing one before anything native",
    () =>
      Effect.gen(function* () {
        let reply = status("running");

        const spawner = scripted((call) =>
          call.args[1] === "status" ? reply : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        for (const next of [
          "running",
          "unreachable",
          "paused",
          "pausing",
        ] as const) {
          reply = status(next);
          yield* runtime.start(machine, new Set());
        }

        const refusals = [];

        for (const next of [status("frozen"), unknown]) {
          reply = next;
          refusals.push(yield* Effect.flip(runtime.start(machine, new Set())));
        }

        expect(refusals.map(failure)).toStrictEqual([
          [
            "WrongState",
            "smolvm reads machine dev frozen, and doesn't start it from there",
          ],
          [
            "Missing",
            "machine dev is missing from the smolvm runtime; delete it",
          ],
        ]);
        expect(
          smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))
        ).toStrictEqual([
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
      })
  );

  it.effect(
    "pause saves a running machine, leaves a paused one, resumes one a pause left part way before pausing it again, and refuses a stopped or missing one",
    () =>
      Effect.gen(function* () {
        let reply = status("running");

        const spawner = scripted((call) =>
          call.args[1] === "status" ? reply : undefined
        );

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

        expect(refusals.map(failure)).toStrictEqual([
          [
            "WrongState",
            "smolvm reads machine dev stopped, and pauses only a running machine",
          ],
          [
            "Missing",
            "machine dev is missing from the smolvm runtime; delete it",
          ],
        ]);
        expect(
          smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))
        ).toStrictEqual([
          "status --name dev-01234567",
          "pause --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "pause --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
        ]);
      })
  );

  it.effect(
    "a stopped machine is resized in one machine update, and a running one in one live machine resize per size, RAM, then vCPUs, then disk, each sending every size asked, also one it has, so a grow cut short finishes",
    () =>
      Effect.gen(function* () {
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.resize(
          machine,
          { cpu: 4, ramMib: 1024, diskGib: 30 },
          false
        );
        yield* runtime.resize(
          machine,
          { cpu: 2, ramMib: 2048, diskGib: 40 },
          true
        );
        yield* runtime.resize(machine, {}, false);
        yield* runtime.resize(machine, {}, true);

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
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
          live("--mem", "2048"),
          live("--cpus", "2"),
          live("--storage", "40"),
        ]);
      })
  );

  it.effect(
    "off x86_64 a live resize leaves out vCPUs it would keep, as smolvm refuses any live vCPU target there",
    () =>
      Effect.gen(function* () {
        const spawner = scripted(() => {});

        const arm = yield* runtimeOf(
          { ...(yield* prepared()), arch: "arm64" },
          spawner
        );

        const before = spawner.calls.length;

        yield* arm.resize(machine, { cpu: 2, ramMib: 4096 }, true);

        expect(smolvmArgs(spawner.calls.slice(before - 1))).toStrictEqual([
          ["machine", "resize", "--name", "dev-01234567", "--mem", "4096"],
        ]);
      })
  );

  it.effect(
    "a size a live resize keeps goes on to the next when smolvm holds another size's grow unfinished, and a size that changes fails",
    () =>
      Effect.gen(function* () {
        const unfinished = {
          exitCode: 1,
          stderr:
            "Error: live resize: an unfinished resize belongs to a different target or VM incarnation; reconcile it before another resize\n",
        };

        const spawner = scripted((call) =>
          call.args[1] === "resize" && call.args.includes("--mem")
            ? unfinished
            : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const before = spawner.calls.length;

        yield* runtime.resize(machine, { cpu: 4, ramMib: 2048 }, true);

        const refused = yield* Effect.flip(
          runtime.resize(machine, { ramMib: 4096 }, true)
        );

        expect(
          smolvmArgs(spawner.calls.slice(before - 1)).map((args) =>
            args.slice(4)
          )
        ).toStrictEqual([
          ["--mem", "2048"],
          ["--cpus", "4"],
          ["--mem", "4096"],
        ]);
        expect(failure(refused)[0]).toBe("Internal");
      })
  );

  it.effect("a resize smolvm refuses fails with its last output", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args[1] === "resize"
          ? {
              exitCode: 1,
              stderr: "Error: not enough host memory for 4096 MiB\n",
            }
          : undefined
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      const refused = yield* Effect.flip(
        runtime.resize(machine, { ramMib: 4096 }, true)
      );

      expect(failure(refused)).toStrictEqual([
        "Internal",
        "smolvm machine resize dev-01234567 exited 1: Error: not enough host memory for 4096 MiB",
      ]);
    })
  );

  it.effect(
    "sizes reads vCPUs, RAM and storage from smolvm's status, and smolvm's default storage where it records none",
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
            : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);
        const recorded = yield* runtime.sizes(machine);

        storage = null;

        const asked: Sized = { ...machine, diskGib: 40 };
        const unrecorded = yield* runtime.sizes(asked);

        expect(recorded).toStrictEqual({ cpu: 3, ramMib: 4096, diskGib: 30 });
        expect(unrecorded).toStrictEqual({ cpu: 3, ramMib: 4096, diskGib: 20 });
      })
  );

  it.effect(
    "stop resumes a paused machine, or one a pause left part way, to end its saved execution, and leaves a stopped or missing one",
    () =>
      Effect.gen(function* () {
        let reply = status("paused");

        const spawner = scripted((call) =>
          call.args[1] === "status" ? reply : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        for (const next of [
          status("paused"),
          status("pausing"),
          status("stopped"),
          unknown,
        ]) {
          reply = next;
          yield* runtime.stop(machine);
        }

        expect(
          smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))
        ).toStrictEqual([
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "stop --name dev-01234567",
          "status --name dev-01234567",
          "resume --name dev-01234567",
          "stop --name dev-01234567",
          "status --name dev-01234567",
          "status --name dev-01234567",
        ]);
      })
  );

  it.effect(
    "a start whose status read fails fails with smolvm's output and boots nothing",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "status"
            ? { exitCode: 1, stderr: "Error: database is locked\n" }
            : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const error = yield* Effect.flip(runtime.start(machine, new Set()));

        expect(failure(error)).toStrictEqual([
          "Internal",
          "smolvm machine status dev-01234567 exited 1: Error: database is locked",
        ]);
        expect(smolvmArgs(spawner.calls).map((args) => args[1])).toStrictEqual([
          "status",
        ]);
      })
  );

  it.effect(
    "delete of a machine smolvm doesn't know changes nothing native, and only reads for bases to retire",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "status" ? unknown : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        yield* runtime.delete(machine, new Set());

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "ls", "--json"],
        ]);
      })
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

        yield* runtime.delete(machine, new Set());

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "stop", "--name", "dev-01234567", "--timeout", "0"],
          [
            "systemctl",
            "show",
            "--property=LoadState",
            "--value",
            "smolvm-vm-dev-01234567.scope",
          ],
          ["machine", "delete", "--name", "dev-01234567", "--force"],
        ]);
      })
  );

  it.effect("delete of a stopped machine deletes it without a stop", () =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args[1] === "status" ? status("stopped") : undefined
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* runtime.delete(machine, new Set());

      expect(smolvmArgs(spawner.calls)).toStrictEqual([
        ["machine", "status", "--name", "dev-01234567", "--json"],
        [
          "systemctl",
          "show",
          "--property=LoadState",
          "--value",
          "smolvm-vm-dev-01234567.scope",
        ],
        ["machine", "delete", "--name", "dev-01234567", "--force"],
      ]);
    })
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

        yield* runtime.delete(machine, new Set());

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          [
            "systemctl",
            "show",
            "--property=LoadState",
            "--value",
            "smolvm-vm-dev-01234567.scope",
          ],
          [
            "systemctl",
            "kill",
            "--signal=SIGKILL",
            "smolvm-vm-dev-01234567.scope",
          ],
          ["machine", "delete", "--name", "dev-01234567", "--force"],
          ["systemctl", "reset-failed", "smolvm-vm-dev-01234567.scope"],
        ]);
      })
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

        yield* runtime.delete(machine, new Set());

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          ["machine", "stop", "--name", "dev-01234567", "--timeout", "0"],
          [
            "systemctl",
            "show",
            "--property=LoadState",
            "--value",
            "smolvm-vm-dev-01234567.scope",
          ],
          [
            "systemctl",
            "kill",
            "--signal=SIGKILL",
            "smolvm-vm-dev-01234567.scope",
          ],
          ["machine", "delete", "--name", "dev-01234567", "--force"],
          ["systemctl", "reset-failed", "smolvm-vm-dev-01234567.scope"],
        ]);
      })
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
        const error = yield* Effect.flip(runtime.delete(machine, new Set()));

        expect(error.message).toBe(
          "systemctl kill smolvm-vm-dev-01234567.scope exited 1: Failed"
        );
        expect(smolvmArgs(spawner.calls).at(-1)).toStrictEqual([
          "systemctl",
          "kill",
          "--signal=SIGKILL",
          "smolvm-vm-dev-01234567.scope",
        ]);
      })
  );

  it.effect(
    "exec runs the command as given, as root, with its stdin, and passes on its output and exit code",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "exec"
            ? { exitCode: 3, stdout: "out\n", stderr: "err\n" }
            : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

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

        expect([output, exitCode]).toStrictEqual(["out\nerr\n", 3]);
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
      })
  );

  it.effect(
    "a command's arguments and env reach no argument of a smolvm process, as root or as a user",
    () =>
      Effect.gen(function* () {
        const spawner = scripted(() => undefined);
        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        for (const user of [{}, { user: "user" }]) {
          yield* runCommand(runtime, {
            machine,
            argv: ["/bin/echo", "argv-word-91c3"],
            env: { TOKEN: "env-value-5be1" },
            ...user,
          });
        }

        const shown = spawner.calls.filter((call) =>
          call.args.some(
            (argument) =>
              argument.includes("argv-word-91c3") ||
              argument.includes("env-value-5be1")
          )
        );

        const execs = spawner.calls.filter((call) => call.args[1] === "exec");

        expect(shown).toStrictEqual([]);
        expect(execs.at(-1)?.stdin).toContain("env-value-5be1");
      })
  );

  const execsAs = (sudo: boolean) =>
    Effect.gen(function* () {
      const spawner = scripted((call) =>
        call.args.at(-1) === "command -v sudo"
          ? { exitCode: sudo ? 0 : 1, stdout: "", stderr: "" }
          : undefined
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* Effect.scoped(
        Effect.flatMap(
          runtime.exec(machine, { argv: ["true"], user: "user" }),
          (execution) => execution.exitCode
        )
      );

      return spawner.calls
        .filter((call) => call.args[1] === "exec")
        .map((call) => call.args);
    });

  it.effect(
    "exec runs the command as the user it names through the guest's sudo, which gives it the user's groups",
    () =>
      Effect.gen(function* () {
        expect(yield* execsAs(true)).toStrictEqual([
          inGuest("root", "/bin/sh", "-c", "command -v sudo"),
          inGuest("root", "sudo", "-n", "-u", "user", "-H", "--", "true"),
        ]);
      })
  );

  it.effect(
    "exec runs the command as the user it names through smolvm when the guest has no sudo",
    () =>
      Effect.gen(function* () {
        expect(yield* execsAs(false)).toStrictEqual([
          inGuest("root", "/bin/sh", "-c", "command -v sudo"),
          inGuest("user", "true"),
        ]);
      })
  );

  it.effect("exec as root asks nothing of the guest first", () =>
    Effect.gen(function* () {
      const spawner = scripted(() => {});
      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* Effect.scoped(
        Effect.flatMap(
          runtime.exec(machine, { argv: ["true"], user: "root" }),
          (execution) => execution.exitCode
        )
      );

      expect(
        spawner.calls
          .filter((call) => call.args[1] === "exec")
          .map((call) => call.args)
      ).toStrictEqual([inGuest("root", "true")]);
    })
  );

  it.effect(
    "an exec that can't start fails without its command line, which can carry a script",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});
        const missing = path.join(settings.prefix, "missing");

        const failing = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) &&
          command.args[0] === "machine"
            ? Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (node) =>
                node.spawn(ChildProcess.make(missing, command.args))
              ).pipe(Effect.provide(NodeServices.layer))
            : Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (inner) =>
                inner.spawn(command)
              ).pipe(Effect.provide(spawner.layer))
        );

        const runtime = yield* make(settings, callsEnded).pipe(
          Effect.provide(
            Layer.merge(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, failing)
            )
          )
        );

        const error = yield* Effect.flip(
          Effect.scoped(
            runtime.exec(machine, {
              argv: ["/bin/sh", "-c", "the secret script"],
            })
          )
        );

        expect(error.message).toBe(
          "smolvm machine exec dev-01234567: NotFound: spawn"
        );
      })
  );

  it.effect(
    "admit refuses with Capacity when running machines would pass the RAM budget",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "status" ? status("running") : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const other = sized({
          ...machine,
          name: "other",
          ramMib: 3072,
        });

        const error = yield* Effect.flip(
          admitOn(runtime)({
            action: "startMachine",
            machine,
            machines: [
              { _tag: "booting", machine },
              { _tag: "found", machine: other },
            ],
          })
        );

        expect(error._tag).toBe("Capacity");
      })
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
          call.args[0] === "machine"
            ? replies.get(call.args[3] ?? "")
            : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const held: readonly Held[] = [
          { _tag: "found", machine },
          {
            _tag: "found",
            machine: sized({ ...machine, name: "two", ramMib: 1024 }),
          },
          {
            _tag: "booting",
            machine: sized({
              ...machine,
              name: "boot",
              ramMib: 512,
            }),
          },
        ];

        const admitNext = (ramMib: number) => {
          const target = sized({ ...machine, name: "next", ramMib });

          return admitOn(runtime)({
            action: "createMachine",
            machine: target,
            machines: [...held, { _tag: "booting", machine: target }],
          });
        };

        const capacity = yield* runtime.capacity(held);

        yield* admitNext(4096 - 2560);

        const refused = yield* Effect.flip(admitNext(4096 - 2560 + 1));

        replies.set("two-01234567", {
          exitCode: 1,
          stderr: "Error: database is locked\n",
        });

        const unread = yield* runtime.capacity(held);

        expect(capacity).toStrictEqual([
          { resource: "cpu", used: 4 },
          { resource: "ramMib", limit: 4096, used: 2560 },
        ]);
        expect(refused.message).toContain(
          "needs 1537M of RAM, and 1.5G of the host's 4G budget is free"
        );
        expect(unread).toStrictEqual([
          { resource: "cpu", unread: ["two"] },
          { resource: "ramMib", limit: 4096, unread: ["two"] },
        ]);
      })
  );

  it.effect(
    "admit counts a parked base by the memory its scope holds, and capacity leaves it out",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel(1024 * 1024 * 1024);
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const builder = sized({ ...machine, name: "building-1" });
        const build = { ...machine, name: "built-0123456789abcdef" };

        model.vms.set(nativeName(builder), {
          state: "running",
          forwards: ["10000:22"],
        });

        yield* runtime.capture(builder, build);

        const admitNext = (ramMib: number) => {
          const target = sized({ ...machine, name: "next", ramMib });

          return admitOn(runtime)({
            action: "createMachine",
            machine: target,
            machines: [{ _tag: "booting", machine: target }],
          });
        };

        yield* admitNext(4096 - 1024);

        const refused = yield* Effect.flip(admitNext(4096 - 1024 + 1));

        expect(refused._tag).toBe("Capacity");
        expect(yield* runtime.capacity([])).toStrictEqual([
          { resource: "cpu", used: 0 },
          { resource: "ramMib", limit: 4096, used: 0 },
        ]);
      })
  );

  it.effect(
    "a host that starts beside a parked base counts its memory before parking anything",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel(1024 * 1024 * 1024);
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        const target = sized({
          ...machine,
          name: "next",
          ramMib: 4096 - 1024 + 1,
        });

        model.vms.set("base_b00710ad_built-0123456789abcdef-fedcba98", {
          state: "frozen",
          forwards: [],
        });

        const refused = yield* Effect.flip(
          admitOn(runtime)({
            action: "createMachine",
            machine: target,
            machines: [{ _tag: "booting", machine: target }],
          })
        );

        expect(refused._tag).toBe("Capacity");
      })
  );

  const ramCheckpoint = sized({
    name: "snap",
    instance: "fedcba9876543210fedcba9876543210",
    cpu: 2,
    ramMib: 2048,
    diskGib: 20,
  });

  const unknownCopy: Reply = {
    exitCode: 1,
    stderr:
      "Error: config operation failed: machine status: machine 'copy-abcdefab' not found\n",
  };

  const copy = sized({
    ...machine,
    name: "copy",
    instance: "abcdefabcdefabcdefabcdefabcdefab",
  });

  const copyPort = on(10_001);

  it.effect(
    "a later smolvm release starts, and the runtime pins the release it reports",
    () =>
      Effect.gen(function* () {
        const runtime = yield* runtimeOf(
          yield* prepared(),
          scripted((call) =>
            call.args[0] === "--version"
              ? { stdout: "smolvm 1.40.2\n" }
              : undefined
          )
        );

        expect(runtime.version).toBe("1.40.2");
        expect(runtime.pin).toBe(
          `smolvm 1.40.2 ${process.platform}-${process.arch}`
        );
      })
  );

  it.effect(
    "startup empties the forks area and makes the runtime's directories",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const paths = pathsIn(settings.stateDir);

        const runtime = yield* runtimeOf(
          settings,
          scripted(() => {})
        );

        yield* mkdir(
          path.join(paths.forks, "old-01234567", "old-01234567.checkpoint")
        );
        yield* runtime.startup;

        expect(yield* readDirectory(paths.forks)).toStrictEqual([]);
        expect(
          (yield* readDirectory(settings.stateDir)).toSorted()
        ).toStrictEqual(["checkpoints", "forks"]);
      })
  );

  it.effect(
    "a capture or a fork of a machine smolvm doesn't read running is refused before anything native",
    () =>
      Effect.gen(function* () {
        let reply = status("stopped");

        const spawner = scripted((call) =>
          call.args[1] === "status" ? reply : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const capture = yield* Effect.flip(
          runtime.capture(machine, ramCheckpoint)
        );

        const fork = yield* Effect.flip(
          runtime.make(copy, fromMachine(machine), copyPort)
        );

        reply = unknown;

        const missing = yield* Effect.flip(
          runtime.capture(machine, ramCheckpoint)
        );

        reply = status("unreachable");

        const unreachable = yield* Effect.flip(
          runtime.make(copy, fromMachine(machine), copyPort)
        );

        reply = status("frozen");

        const frozen = yield* Effect.flip(
          runtime.capture(machine, ramCheckpoint)
        );

        reply = status("paused");

        const paused = yield* Effect.flip(
          runtime.make(copy, fromMachine(machine), copyPort)
        );

        expect(
          [capture, fork, missing, unreachable, frozen, paused].map(failure)
        ).toStrictEqual([
          [
            "WrongState",
            "a smolvm checkpoint holds a running machine's RAM, and dev is stopped: start it first",
          ],
          [
            "WrongState",
            "a fork copies a running machine, RAM included, and dev is stopped: start it first",
          ],
          [
            "Missing",
            "machine dev is missing from the smolvm runtime; delete it",
          ],
          [
            "WrongState",
            "smolvm reads machine dev unreachable: its VM runs, but its agent doesn't answer; start it to boot it again",
          ],
          [
            "WrongState",
            "smolvm reads machine dev frozen, and copies only a running machine",
          ],
          [
            "WrongState",
            "smolvm reads machine dev paused, and copies only a running machine",
          ],
        ]);
        expect(smolvmArgs(spawner.calls).map((args) => args[1])).toStrictEqual([
          "status",
          "status",
          "status",
          "status",
          "status",
          "status",
        ]);
      })
  );

  it.effect(
    "a ram capture goes into the host's one store, with no history",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();

        const spawner = scripted((call) =>
          call.args[1] === "status" ? status("running") : undefined
        );

        const runtime = yield* runtimeOf(settings, spawner);
        const store = path.join(settings.stateDir, "checkpoints");

        yield* runtime.capture(machine, ramCheckpoint);

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          ["machine", "status", "--name", "dev-01234567", "--json"],
          [
            "machine",
            "checkpoint",
            "--name",
            "dev-01234567",
            "--store",
            store,
            "--output",
            path.join(store, "snap-fedcba98.checkpoint"),
            "--history",
            "0",
          ],
        ]);
      })
  );

  it.effect(
    "find answers the handle a make gave its instance, none for another instance of its name, and a captured checkpoint's",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const later = { ...machine, instance: "76543210".repeat(4) };
        const { handle } = yield* runtime.make(machine, fromImage, on(10_000));
        const uncaptured = yield* runtime.find("checkpoint", ramCheckpoint);

        const captured = yield* runtime.capture(
          { ...machine, handle },
          ramCheckpoint
        );

        expect({
          machine: yield* runtime.find("machine", machine),
          later: yield* runtime.find("machine", later),
          uncaptured,
          checkpoint: yield* runtime.find("checkpoint", ramCheckpoint),
          laterCheckpoint: yield* runtime.find("checkpoint", {
            ...ramCheckpoint,
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
    "a ram restore creates from the store with no restore cache, its port moved, then boots",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(settings, spawner);

        yield* runtime.make(copy, fromCheckpoint(ramCheckpoint), copyPort);

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          baseStatus,
          [
            "machine",
            "create",
            "--name",
            "copy-abcdefab",
            "--from",
            path.join(
              settings.stateDir,
              "checkpoints",
              "snap-fedcba98.checkpoint"
            ),
            "-p",
            "10001:22",
            "--restore-cache-entries",
            "0",
          ],
          ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
        ]);
      })
  );

  it.effect(
    "a copy from a parked base branches it, and one with no base restores the build",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();

        const parked = scripted((call) =>
          call.args[1] === "status" &&
          call.args[3]?.startsWith("base_") === true
            ? status("frozen")
            : undefined
        );

        const unparked = scripted(() => {});

        yield* (yield* runtimeOf(settings, parked)).make(
          { ...copy, ramMib: 4096 },
          fromCheckpoint(ramCheckpoint),
          copyPort
        );
        yield* (yield* runtimeOf(settings, unparked)).make(
          copy,
          fromCheckpoint(ramCheckpoint),
          copyPort
        );

        expect(smolvmArgs(parked.calls)).toStrictEqual([
          baseStatus,
          [
            "machine",
            "branch",
            "--from",
            "base_b00710ad_snap-fedcba98",
            "--name",
            "copy-abcdefab",
            "--freeze-source",
            "--branchable",
            "-p",
            "10001:22",
          ],
          ["machine", "resize", "--name", "copy-abcdefab", "--mem", "4096"],
        ]);
        expect(smolvmArgs(unparked.calls).map((args) => args[1])).toStrictEqual(
          ["status", "create", "start"]
        );
        expect(smolvmArgs(unparked.calls)[1]).toContain(
          path.join(
            settings.stateDir,
            "checkpoints",
            "snap-fedcba98.checkpoint"
          )
        );
      })
  );

  it.effect(
    "a delete of a build retires its base, also past a freezer an interrupted freeze left",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        const build = sized({
          ...ramCheckpoint,
          name: "built-0123456789abcdef",
        });

        const base = `base_b00710ad_${nativeName(build)}`;

        model.vms.set(nativeName(builderRef), {
          state: "running",
          forwards: ["10000:22"],
        });

        yield* runtime.capture(builderRef, build);
        model.vms.set(`${base}_freeze`, {
          state: "running",
          parent: base,
          forwards: [],
        });
        yield* runtime.deleteCheckpoint(build);

        expect(
          [...model.vms.keys()].filter((vm) => vm.startsWith("base_"))
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "a host that starts removes every image seed build a killed smolvm call left, the VM its record lost included",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const left = "image-seed-0123456789abcdef-4242";

        model.orphanVmm(left);

        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        yield* runtime.startup;

        expect(model.vms.has(left)).toBe(false);
        expect(model.vmmsLeft()).toStrictEqual([]);
      })
  );

  it.effect(
    "a boot cut short or failed removes the seed build its smolvm call left, and keeps one whose call still runs",
    () =>
      Effect.gen(function* () {
        for (const ends of ["cut", "failed"] as const) {
          const model = smolvmModel();

          const runtime = yield* runtimeOf(
            yield* prepared(),
            model.spawner,
            model.box()
          );

          const left = "image-seed-0123456789abcdef-4242";
          const running = "image-seed-fedcba9876543210-4243";

          model.running.add(4243);

          model.faults.reply = ({ args }) => {
            if (args[1] !== "start") {
              return undefined;
            }

            model.orphanVmm(left);
            model.orphanVmm(running);

            return ends === "cut"
              ? { hangs: true }
              : { exitCode: 1, stderr: "Error: image seed failed\n" };
          };

          const making = yield* Effect.forkChild(
            Effect.exit(
              runtime.make(machine, { _tag: "image", image }, { _tag: "none" })
            )
          );

          yield* waitFor(
            Effect.sync(() =>
              model.spawner.calls.some(({ args }) => args[1] === "start")
            ),
            Boolean
          );

          model.faults.reply = undefined;

          yield* ends === "cut"
            ? Fiber.interrupt(making)
            : Effect.asVoid(Fiber.join(making));

          expect([model.vms.has(left), model.vms.has(running)]).toStrictEqual([
            false,
            true,
          ]);
          expect(model.vmmsLeft()).toStrictEqual([running]);
        }
      })
  );

  it.effect(
    "a host that starts resumes a machine a killed pause left half-paused, so no step meets its frozen guest, and leaves a paused one paused",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const paused = nativeName({ name: "web", instance: machine.instance });

        model.vms.set(machine.handle, { state: "pausing", forwards: [] });
        model.vms.set(paused, { state: "paused", forwards: [] });

        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        yield* runtime.startup;

        expect([
          model.vms.get(machine.handle)?.state,
          model.vms.get(paused)?.state,
        ]).toStrictEqual(["running", "paused"]);
      })
  );

  it.effect(
    "a host's start that can't remove one seed build or resume one machine still removes and resumes the rest",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const stuck = "image-seed-0123456789abcdef-4242";
        const left = "image-seed-fedcba9876543210-4242";
        const frozen = "frozen-01234567";

        model.orphanVmm(stuck);
        model.orphanVmm(left);
        model.vms.set(frozen, { state: "pausing", forwards: [] });
        model.vms.set(machine.handle, { state: "pausing", forwards: [] });
        model.faults.reply = ({ args }) =>
          (args[1] === "delete" && args.includes(stuck)) ||
          (args[1] === "resume" && args.includes(frozen))
            ? locked
            : undefined;

        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        yield* runtime.startup;

        expect({
          left: model.vms.has(left),
          resumed: model.vms.get(machine.handle)?.state,
        }).toStrictEqual({ left: false, resumed: "running" });
      })
  );

  it.effect(
    "a pause cut short ends only once smolvm has paused the machine, so it never leaves it half-paused",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const gate = yield* Deferred.make<undefined>();
        const vm = { state: "running", forwards: [] };

        model.vms.set(machine.handle, vm);
        model.faults.reply = ({ args }) => {
          if (args[1] !== "pause") {
            return undefined;
          }

          vm.state = "pausing";

          return {
            until: Effect.andThen(
              Deferred.await(gate),
              Effect.sync(() => {
                vm.state = "paused";
              })
            ),
          };
        };

        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const pausing = yield* Effect.forkChild(runtime.pause(machine));

        yield* waitFor(
          Effect.sync(() => vm.state),
          (state) => state === "pausing"
        );

        const cut = yield* Effect.forkChild(Fiber.interrupt(pausing));

        yield* TestClock.withLive(Effect.sleep(Duration.millis(50)));

        const cutBeforePaused = cut.pollUnsafe() !== undefined;

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(cut);

        expect({ cutBeforePaused, state: vm.state }).toStrictEqual({
          cutBeforePaused: false,
          state: "paused",
        });
      })
  );

  it.effect(
    "a machine smolvm lists in a state this host doesn't know refuses no admission",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        model.vms.set("other", { state: "migrating", forwards: [] });

        yield* admitOn(runtime)({
          action: "createMachine",
          machine,
          machines: [{ _tag: "booting", machine }],
        });
      })
  );

  it.effect(
    "a smolvm host counts a running image seed build's RAM as held",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel(1024 * 1024 * 1024);

        const runtime = yield* runtimeOf(
          { ...(yield* prepared()), ramBudgetMib: 2048 },
          model.spawner
        );

        const admitted = (machines: readonly Held[]) =>
          admitOn(runtime)({
            action: "createMachine",
            machine,
            machines: [{ _tag: "booting", machine }, ...machines],
          });

        yield* admitted([]);

        model.orphanVmm("image-seed-0123456789abcdef-4242");

        const refused = yield* Effect.flip(admitted([]));

        expect(refused._tag).toBe("Capacity");
      })
  );

  it.effect(
    "a delete of a build whose base won't go keeps the build for find, so a retry with no handle retires the base",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const base = baseOf(buildRef);

        building(model);
        yield* runtime.capture(builderRef, buildRef);
        model.faults.reply = ({ args }) =>
          args[1] === "delete" && args.includes(base) ? locked : undefined;

        const refused = yield* Effect.flip(runtime.deleteCheckpoint(buildRef));

        model.faults.reply = undefined;

        const found = yield* runtime.find("checkpoint", {
          name: buildRef.name,
          instance: buildRef.instance,
        });

        yield* runtime.deleteCheckpoint(buildRef);

        expect(refused.message).toContain("database is locked");
        expect(found).toBe(buildRef.handle);
        expect(basesIn(model)).toStrictEqual([]);
      })
  );

  it.effect(
    "a capture of a build's copy drops the guest's host keys before it copies and parks a base after, and one of any other checkpoint does neither",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const builder = nativeName(builderRef);
        const base = baseOf(buildRef);

        building(model);

        yield* runtime.capture(builderRef, { ...buildRef, name: "snap" });

        const plain = commands(model.spawner.calls);
        const before = model.spawner.calls.length;

        yield* runtime.capture(builderRef, buildRef);

        const built = model.spawner.calls.slice(before);

        expect(plain).toStrictEqual([
          `status ${builder}`,
          `checkpoint ${builder}`,
        ]);
        expect(commands(built)).toStrictEqual([
          `exec ${builder}`,
          `status ${builder}`,
          `checkpoint ${builder}`,
          `status ${base}_freeze`,
          `status ${base}`,
          `create ${base}`,
          `update ${base}`,
          `start ${base}`,
          `branch ${base}_freeze`,
          `status ${base}_freeze`,
          `stop ${base}_freeze`,
          `delete ${base}_freeze`,
        ]);
        expect(built[0]?.stdin).toContain("clankerbox-unkey");
        expect(basesIn(model)).toStrictEqual([base]);
      })
  );

  it.effect(
    "a capture of a build whose park fails is still done, keeps its checkpoint, parks no base, and logs why",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const logged: unknown[] = [];

        building(model);
        model.faults.reply = ({ args }) =>
          args[1] === "create" ? locked : undefined;

        yield* runtime
          .capture(builderRef, buildRef)
          .pipe(Effect.provide(logging(logged)));

        expect(
          yield* fs.exists(
            path.join(
              settings.stateDir,
              "checkpoints",
              `${nativeName(buildRef)}.checkpoint`
            )
          )
        ).toBe(true);
        expect(basesIn(model)).toStrictEqual([]);
        expect(logged).toStrictEqual([
          [
            `park build ${buildRef.name}: smolvm machine create ${baseOf(buildRef)} exited 1: Error: database is locked`,
          ],
        ]);
      })
  );

  it.effect(
    "a capture of a build whose host keys can't be dropped fails Internal with the script's output, and copies nothing",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        building(model);
        model.faults.reply = ({ stdin }) =>
          stdin?.includes("clankerbox-unkey") === true
            ? { exitCode: 1, stderr: "rm: Read-only file system\n" }
            : undefined;

        const error = yield* Effect.flip(runtime.capture(builderRef, buildRef));

        expect(failure(error)).toStrictEqual([
          "Internal",
          "couldn't drop building-1's host keys before its capture: preparation exited 1; its last output:\nrm: Read-only file system",
        ]);
        expect(commands(model.spawner.calls)).toStrictEqual([
          `exec ${nativeName(builderRef)}`,
        ]);
      })
  );

  it.effect(
    "an install of a build's copy parks its base before it returns, and one whose park fails is installed all the same and logs why",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const files = runtime.files ?? (yield* Effect.die("smolvm has files"));
        const logged: unknown[] = [];
        const store = path.join(settings.stateDir, "checkpoints");
        const fetched = { ...buildRef, name: "fetched-fedcba9876543210" };
        const failing = { ...buildRef, name: "fetched-0123456789abcdef" };

        const staged = (checkpoint: Identity) =>
          Effect.as(
            fs.copy(
              path.join(store, `${nativeName(buildRef)}.checkpoint`),
              files.staging(checkpoint)
            ),
            files.staging(checkpoint)
          );

        building(model);
        yield* runtime.capture(builderRef, buildRef);
        yield* files.install(fetched, yield* staged(fetched));

        const parked = model.vms.get(baseOf(fetched))?.state;

        model.faults.reply = ({ args }) =>
          args[1] === "create" ? locked : undefined;

        yield* files
          .install(failing, yield* staged(failing))
          .pipe(Effect.provide(logging(logged)));

        expect(parked).toBe("frozen");
        expect(
          yield* fs.exists(
            path.join(store, `${nativeName(failing)}.checkpoint`)
          )
        ).toBe(true);
        expect(basesIn(model).toSorted()).toStrictEqual(
          [baseOf(buildRef), baseOf(fetched)].toSorted()
        );
        expect(logged).toStrictEqual([
          [
            `park build ${failing.name}: smolvm machine create ${baseOf(failing)} exited 1: Error: database is locked`,
          ],
        ]);
      })
  );

  it.effect(
    "a fetch of a build's copy cut short in its install's park keeps the checkpoint it installed and leaves no staging folder",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { store } = memoryBuildStore();
        const source = smolvmModel();
        const other = smolvmModel();
        const fetched = { ...buildRef, name: "fetched-fedcba9876543210" };
        const base = baseOf(fetched, "5bfae059");
        const settings = { ...(yield* prepared()), bootId: "5bfae059" };
        const builds = yield* runtimeOf(yield* prepared(), source.spawner);
        const fetches = yield* runtimeOf(settings, other.spawner);
        const files = yield* filesOf(fetches);
        let hung = false;

        building(source);
        yield* builds.capture(builderRef, buildRef);
        yield* publish(store, yield* filesOf(builds), buildRef);

        other.faults.reply = ({ args }) => {
          if (args[1] !== "create" || !args.includes(base)) {
            return undefined;
          }

          hung = true;

          return { hangs: true };
        };

        const fetching = yield* Effect.forkChild(
          fetch(store, files, fetched, buildRef.name, "web@1")
        );

        yield* waitFor(
          Effect.sync(() => hung),
          (cut) => cut
        );
        yield* Fiber.interrupt(fetching);

        expect({
          installed: yield* fs.exists(
            path.join(
              settings.stateDir,
              "checkpoints",
              `${nativeName(fetched)}.checkpoint`
            )
          ),
          staging: yield* fs.exists(files.staging(fetched)),
        }).toStrictEqual({ installed: true, staging: false });
      })
  );

  it.effect(
    "a capture of a build cut short in its host-key drop, or in its park after its base or its freezer is made, leaves nothing its checkpoint's delete doesn't clear",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const base = baseOf(buildRef);

        const stored = path.join(
          settings.stateDir,
          "checkpoints",
          `${nativeName(buildRef)}.checkpoint`
        );

        const cutAt = (hangs: (call: Call) => boolean) =>
          Effect.gen(function* () {
            let hung = false;

            model.faults.reply = (call) => {
              if (hung || !hangs(call)) {
                return undefined;
              }

              hung = true;

              return { hangs: true };
            };

            const capture = yield* Effect.forkChild(
              runtime.capture(builderRef, buildRef)
            );

            yield* waitFor(
              Effect.sync(() => hung),
              (cut) => cut
            );

            const left = basesIn(model);

            yield* Fiber.interrupt(capture);
            yield* runtime.deleteCheckpoint(buildRef);

            return {
              left,
              after: basesIn(model),
              stored: yield* fs.exists(stored),
            };
          });

        building(model);

        const unkeyed = yield* cutAt(
          ({ stdin }) => stdin?.includes("clankerbox-unkey") === true
        );

        const started = yield* cutAt(
          ({ args }) => args[1] === "start" && args.includes(base)
        );

        const frozen = yield* cutAt(
          ({ args }) => args[1] === "stop" && args.includes(`${base}_freeze`)
        );

        expect([unkeyed, started, frozen]).toStrictEqual([
          { left: [], after: [], stored: false },
          { left: [base], after: [], stored: false },
          { left: [base, `${base}_freeze`], after: [], stored: false },
        ]);
      })
  );

  it.effect("a base outlives its build until its last child is deleted", () =>
    Effect.gen(function* () {
      const model = smolvmModel();
      const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
      const child = childOf("web-1");
      const base = baseOf(buildRef);

      building(model);
      yield* runtime.capture(builderRef, buildRef);

      const parked = [...model.vms].map(([name, { state }]) => [name, state]);

      yield* runtime.make(child, fromCheckpoint(buildRef), on(10_001));

      const branched = model.vms.get(nativeName(child));

      yield* runtime.deleteCheckpoint(buildRef);

      const kept = model.vms.get(base)?.state;

      yield* runtime.delete(child, new Set());

      expect(parked).toStrictEqual([
        [nativeName(builderRef), "running"],
        [base, "frozen"],
      ]);
      expect(branched?.parent).toBe(base);
      expect(branched?.forwards).toStrictEqual(["10001:22"]);
      expect(kept).toBe("frozen");
      expect([...model.vms.keys()]).toStrictEqual([nativeName(builderRef)]);
    })
  );

  it.effect(
    "a child's delete that can't retire its base still succeeds, and a delete again retires it",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);

        building(model);
        yield* runtime.capture(builderRef, buildRef);
        model.vms.delete(nativeName(builderRef));
        yield* runtime.make(child, fromCheckpoint(buildRef), on(10_001));
        yield* runtime.deleteCheckpoint(buildRef);

        model.faults.reply = ({ args }) =>
          args[1] === "delete" && args.includes(base) ? locked : undefined;

        yield* runtime.delete(child, new Set());

        const kept = model.vms.has(base);

        model.faults.reply = undefined;

        yield* runtime.delete(child, new Set());

        expect(kept).toBe(true);
        expect([...model.vms.keys()]).toStrictEqual([]);
      })
  );

  it.effect(
    "a base a child's delete couldn't retire goes at the host's next start, with no delete reaching smolvm again",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const settings = yield* prepared();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);

        building(model);
        yield* runtime.capture(builderRef, buildRef);
        model.vms.delete(nativeName(builderRef));
        yield* runtime.make(child, fromCheckpoint(buildRef), on(10_001));
        yield* runtime.deleteCheckpoint(buildRef);

        model.faults.reply = ({ args }) =>
          args[1] === "delete" && args.includes(base) ? locked : undefined;

        yield* runtime.delete(child, new Set());

        const kept = model.vms.has(base);

        model.faults.reply = undefined;

        const restarted = yield* runtimeOf(settings, model.spawner);

        yield* restarted.startup;
        yield* waitFor(
          Effect.sync(() => model.vms.has(base)),
          (left) => !left
        );

        expect(kept).toBe(true);
        expect([...model.vms.keys()]).toStrictEqual([]);
      })
  );

  it.effect(
    "a restore of a build restores the copy when its base can't be read or goes before the branch, and fails when the branch fails beside a frozen base",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const base = baseOf(buildRef);

        const restored = (name: string, port: number) =>
          Effect.map(
            Effect.exit(
              runtime.make(childOf(name), fromCheckpoint(buildRef), on(port))
            ),
            (exit) => ({
              done: Exit.isSuccess(exit),
              parent: model.vms.get(nativeName(childOf(name)))?.parent,
            })
          );

        building(model);
        yield* runtime.capture(builderRef, buildRef);
        model.vms.delete(nativeName(builderRef));

        model.faults.reply = ({ args }) =>
          args[1] === "status" && args.includes(base) ? locked : undefined;

        const unread = yield* restored("web-1", 10_001);

        model.faults.reply = ({ args }) =>
          args[1] === "branch" && !args.includes(`${base}_freeze`)
            ? { exitCode: 1, stderr: "Error: port 10002 is already in use\n" }
            : undefined;

        const refused = yield* restored("web-2", 10_002);

        model.faults.reply = ({ args }) => {
          if (args[1] !== "branch") {
            return undefined;
          }

          model.vms.delete(base);

          return {
            exitCode: 1,
            stderr: `Error: machine '${base}' not found\n`,
          };
        };

        const gone = yield* restored("web-3", 10_003);

        expect([unread, refused, gone]).toStrictEqual([
          { done: true, parent: undefined },
          { done: false, parent: undefined },
          { done: true, parent: undefined },
        ]);
      })
  );

  it.effect(
    "a restore of a build whose base goes before its branch, and whose half-made VM can't be removed, fails with the branch's error and logs the removal's",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);
        const native = nativeName(child);
        const logged: unknown[] = [];
        let branched = false;

        building(model);
        yield* runtime.capture(builderRef, buildRef);
        model.vms.delete(nativeName(builderRef));

        model.faults.reply = ({ args }) => {
          if (args[1] === "branch") {
            branched = true;
            model.vms.delete(base);

            return {
              exitCode: 1,
              stderr: `Error: machine '${base}' not found\n`,
            };
          }

          return branched && args[1] === "status" && args.includes(native)
            ? locked
            : undefined;
        };

        const error = yield* Effect.flip(
          runtime.make(child, fromCheckpoint(buildRef), on(10_001))
        ).pipe(Effect.provide(logging(logged)));

        expect(error.message).toContain(`machine '${base}' not found`);
        expect(
          logged.filter(
            (line) =>
              String(line).includes(`${native} couldn't be removed`) &&
              String(line).includes("database is locked")
          )
        ).toHaveLength(1);
      })
  );

  it.effect("a ram restore that got its source's old port keeps it", () =>
    Effect.gen(function* () {
      const spawner = scripted(() => {});
      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      yield* runtime.make(copy, fromCheckpoint(ramCheckpoint), on(10_000));

      expect(smolvmArgs(spawner.calls).map((args) => args[1])).toStrictEqual([
        "status",
        "create",
        "start",
      ]);
    })
  );

  it.effect(
    "sizes smolvm can't give are Unsizable before anything native: RAM below its least, vCPUs or RAM past what its CLI takes, and for a live grow RAM off its 128M steps or vCPUs off x86_64",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(settings, spawner);
        const arm = yield* runtimeOf({ ...settings, arch: "arm64" }, spawner);
        const before = spawner.calls.length;

        const refused = [
          yield* Effect.flip(
            runtime.sizable(machine, machine, { ...machine, ramMib: 32 }, false)
          ),
          yield* Effect.flip(
            runtime.sizable(machine, machine, { ...machine, cpu: 256 }, false)
          ),
          yield* Effect.flip(
            runtime.sizable(
              machine,
              machine,
              { ...machine, ramMib: 2100 },
              true
            )
          ),
          yield* Effect.flip(
            arm.sizable(machine, machine, { ...machine, cpu: 4 }, true)
          ),
        ];

        yield* arm.sizable(
          machine,
          machine,
          { ...machine, cpu: 4, ramMib: 2100 },
          false
        );
        yield* runtime.sizable(
          machine,
          machine,
          { ...machine, cpu: 255, ramMib: 2176 },
          true
        );

        expect(refused.map(failure)).toStrictEqual([
          [
            "Unsizable",
            "smolvm gives a machine at least 64M of RAM, and dev would have 32M",
          ],
          [
            "Unsizable",
            "smolvm's CLI takes at most 255 vCPUs, and dev would have 256",
          ],
          [
            "Unsizable",
            "smolvm grows a running machine's RAM in 128M steps, and dev's would grow from 2G to 2100M",
          ],
          [
            "Unsizable",
            "smolvm grows a running machine's vCPUs only on x86_64, and this host is arm64: give dev more vCPUs once it is stopped",
          ],
        ]);
        expect(spawner.calls).toHaveLength(before);
      })
  );

  it.effect(
    "a ram restore or fork given larger sizes than its source's grows the copy live once it boots",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "status" ? status("running") : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const larger = {
          ...copy,
          cpu: 4,
          ramMib: 4096,
          diskGib: 30,
        };

        yield* runtime.make(larger, fromCheckpoint(ramCheckpoint), on(10_000));
        yield* runtime.make(
          { ...larger, cpu: 2 },
          fromMachine(machine),
          on(10_000)
        );

        const resizes = smolvmArgs(spawner.calls).filter(
          (args) => args[1] === "resize"
        );

        const grow = (flag: string, size: string) => [
          "machine",
          "resize",
          "--name",
          nativeName(copy),
          flag,
          size,
        ];

        expect(resizes).toStrictEqual([
          grow("--mem", "4096"),
          grow("--cpus", "4"),
          grow("--storage", "30"),
          grow("--mem", "4096"),
          grow("--storage", "30"),
        ]);
        expect(
          smolvmArgs(spawner.calls)
            .slice(0, 4)
            .map((args) => args[1])
        ).toStrictEqual(["status", "create", "start", "resize"]);
      })
  );

  it.effect(
    "a restore whose create, boot or live grow fails returns its error, and leaves its VM to delete",
    () =>
      Effect.gen(function* () {
        const larger = { ...copy, ramMib: 4096 };

        for (const failing of ["create", "start", "resize"]) {
          const spawner = scripted((call) =>
            call.args[1] === failing
              ? { exitCode: 1, stderr: "Error: database is locked\n" }
              : undefined
          );

          const runtime = yield* runtimeOf(yield* prepared(), spawner);

          const error = yield* Effect.flip(
            runtime.make(larger, fromCheckpoint(ramCheckpoint), copyPort)
          );

          const steps = ["status", "create", "start", "resize"];
          const seedBuildsRead = failing === "start" ? ["ls"] : [];

          expect(error.message).toBe(
            `smolvm machine ${failing} copy-abcdefab exited 1: Error: database is locked`
          );
          expect(
            smolvmArgs(spawner.calls).map((args) => args[1])
          ).toStrictEqual([
            ...steps.slice(0, steps.indexOf(failing) + 1),
            ...seedBuildsRead,
          ]);
        }
      })
  );

  const forking = (create: Reply) =>
    scripted((call) => {
      if (call.args[1] === "checkpoint") {
        mkdirSync(call.args[call.args.indexOf("--output") + 1] ?? "", {
          recursive: true,
        });

        return {};
      }

      if (call.args[1] === "status") {
        return call.args[3] === "dev-01234567"
          ? status("running")
          : unknownCopy;
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
        const store = path.join(settings.stateDir, "forks", "copy-abcdefab");

        yield* runtime.startup;
        yield* waitFor(
          Effect.sync(
            () =>
              spawner.calls.filter(({ args }) => args[1] === listing[1]).length
          ),
          (lists) => lists === 2
        );
        yield* runtime.make(copy, fromMachine(machine), copyPort);

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          listing,
          listing,
          ["machine", "status", "--name", "dev-01234567", "--json"],
          [
            "machine",
            "checkpoint",
            "--name",
            "dev-01234567",
            "--store",
            store,
            "--output",
            path.join(store, "copy-abcdefab.checkpoint"),
            "--history",
            "0",
          ],
          [
            "machine",
            "create",
            "--name",
            "copy-abcdefab",
            "--from",
            path.join(store, "copy-abcdefab.checkpoint"),
            "-p",
            "10001:22",
            "--restore-cache-entries",
            "0",
          ],
          ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
        ]);
        expect(
          yield* readDirectory(path.join(settings.stateDir, "forks"))
        ).toStrictEqual([]);
      })
  );

  it.effect("a fork that fails still removes its store", () =>
    Effect.gen(function* () {
      const settings = yield* prepared();

      const runtime = yield* runtimeOf(
        settings,
        forking({ exitCode: 1, stderr: "Error: no space\n" })
      );

      yield* runtime.startup;

      const error = yield* Effect.flip(
        runtime.make(copy, fromMachine(machine), copyPort)
      );

      expect(error.message).toBe(
        "smolvm machine create copy-abcdefab exited 1: Error: no space"
      );
      expect(
        yield* readDirectory(path.join(settings.stateDir, "forks"))
      ).toStrictEqual([]);
    })
  );

  it.effect(
    "deleting a ram checkpoint removes its directory, then prunes the store",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(settings, spawner);
        const store = path.join(settings.stateDir, "checkpoints");

        yield* mkdir(path.join(store, "snap-fedcba98.checkpoint", "objects"));
        yield* mkdir(path.join(store, "objects"));
        yield* runtime.deleteCheckpoint(ramCheckpoint);

        expect(yield* readDirectory(store)).toStrictEqual(["objects"]);
        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          freezerStatus,
          baseStatus,
          ["machine", "checkpoint-prune", "--store", store],
        ]);
      })
  );

  it.effect(
    "deleting a ram checkpoint from a store no capture has written prunes nothing",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(settings, spawner);

        yield* runtime.startup;
        yield* waitFor(
          Effect.sync(
            () =>
              spawner.calls.filter(({ args }) => args[1] === listing[1]).length
          ),
          (lists) => lists === 2
        );
        yield* runtime.deleteCheckpoint(ramCheckpoint);

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          listing,
          listing,
          freezerStatus,
          baseStatus,
        ]);
      })
  );

  it.effect(
    "a host's start prunes a store that has objects, so what a delete cut short before its prune left goes",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(settings, spawner);
        const store = path.join(settings.stateDir, "checkpoints");
        const prune = ["machine", "checkpoint-prune", "--store", store];

        yield* mkdir(path.join(store, "objects"));
        yield* runtime.startup;
        yield* waitFor(
          Effect.sync(() => smolvmArgs(spawner.calls)),
          (calls) => calls.some((call) => call[1] === prune[1])
        );

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
          listing,
          listing,
          prune,
        ]);
      })
  );

  it.effect(
    "a host's start parks a base for a build's copy, and none for a checkpoint a client named as one begins, whose copies restore it",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const base = baseOf(buildRef, "5bfae059");
        const named = sized({ ...buildRef, name: "built" });

        const others = ["fetched", "built-x"].map((name) => ({
          ...buildRef,
          name,
        }));

        building(model);

        for (const checkpoint of [buildRef, named, ...others]) {
          yield* runtime.capture(builderRef, checkpoint);
        }

        const restarted = yield* runtimeOf(
          { ...settings, bootId: "5bfae059" },
          model.spawner
        );

        yield* restarted.startup;

        const bases = yield* waitFor(
          Effect.sync(() => basesIn(model)),
          (found) =>
            found.length === 1 && model.vms.get(base)?.state === "frozen"
        );

        yield* restarted.make(copy, fromCheckpoint(named), copyPort);

        expect(bases).toStrictEqual([base]);
        expect(model.vms.get(nativeName(copy))?.parent).toBeUndefined();
      })
  );

  it.effect(
    "a build whose index names no smolvm version parks no base at a host's start, and its warning says so",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const logged: unknown[] = [];

        const index = path.join(
          settings.stateDir,
          "checkpoints",
          `${nativeName(buildRef)}.checkpoint`,
          "checkpoint.json"
        );

        building(model);
        yield* runtime.capture(builderRef, buildRef);

        yield* fs.writeFileString(
          index,
          (yield* fs.readFileString(index)).replace(
            `"smolvm_version":"${minimumVersion}",`,
            ""
          )
        );

        const restarted = yield* runtimeOf(settings, model.spawner);

        yield* restarted.startup.pipe(Effect.provide(logging(logged)));
        yield* waitFor(
          Effect.sync(() => logged.length),
          (count) => count > 0
        );

        expect(basesIn(model)).toStrictEqual([]);
        expect(logged).toStrictEqual([
          [
            `${nativeName(buildRef)}'s checkpoint.json names no smolvm version, so it parks no base and its copies restore`,
          ],
        ]);
      })
  );

  it.effect(
    "a restore of a build returns before its base parks, and the park goes on in the runtime's scope after it",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);
        const gate = yield* Deferred.make<undefined>();
        let held = false;

        building(model);
        model.faults.reply = ({ args }) =>
          args[1] === "create" && args.includes(base) ? locked : undefined;
        yield* runtime.capture(builderRef, buildRef);

        model.faults.reply = ({ args }) => {
          if (
            held ||
            args[1] !== "status" ||
            !args.includes(`${base}_freeze`)
          ) {
            return undefined;
          }

          held = true;

          return { ...notFound(`${base}_freeze`), until: Deferred.await(gate) };
        };

        yield* runtime.make(child, fromCheckpoint(buildRef), on(10_001));
        yield* waitFor(
          Effect.sync(() => held),
          (parking) => parking
        );

        const restored = {
          parent: model.vms.get(nativeName(child))?.parent,
          parked: model.vms.has(base),
        };

        yield* Deferred.succeed(gate, undefined);

        yield* waitFor(
          Effect.sync(() => model.vms.get(base)?.state),
          (state) => state === "frozen"
        );

        expect(restored).toStrictEqual({ parent: undefined, parked: false });
      })
  );

  it.effect(
    "a delete of a build waits for the park its restore began, and then retires the base",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);
        const gate = yield* Deferred.make<undefined>();
        let held = false;

        const stored = path.join(
          settings.stateDir,
          "checkpoints",
          `${nativeName(buildRef)}.checkpoint`
        );

        building(model);
        model.faults.reply = ({ args }) =>
          args[1] === "create" && args.includes(base) ? locked : undefined;
        yield* runtime.capture(builderRef, buildRef);

        model.faults.reply = ({ args }) => {
          const vm = model.vms.get(base);

          if (
            held ||
            args[1] !== "start" ||
            !args.includes(base) ||
            vm === undefined
          ) {
            return undefined;
          }

          vm.state = "running";
          held = true;

          return { until: Deferred.await(gate) };
        };

        yield* runtime.make(child, fromCheckpoint(buildRef), on(10_001));
        yield* waitFor(
          Effect.sync(() => held),
          (parking) => parking
        );

        const deleting = yield* Effect.forkChild(
          runtime.deleteCheckpoint(buildRef)
        );

        yield* TestClock.withLive(Effect.sleep(Duration.millis(100)));

        const whileParking = {
          stored: yield* fs.exists(stored),
          deleted: deleting.pollUnsafe() !== undefined,
        };

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(deleting);

        expect(whileParking).toStrictEqual({ stored: true, deleted: false });
        expect({
          stored: yield* fs.exists(stored),
          bases: basesIn(model),
        }).toStrictEqual({ stored: false, bases: [] });
      })
  );

  it.effect(
    "a restore's park and a host's start's settle end with the runtime's scope, and run nothing after it closes",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);

        building(model);
        model.faults.reply = ({ args }) =>
          args[1] === "create" && args.includes(base) ? locked : undefined;
        yield* runtime.capture(builderRef, buildRef);

        const cutWith = Effect.fn(function* (
          bootId: string,
          held: (args: readonly string[]) => Reply | undefined,
          run: (runtime: Interface) => Effect.Effect<void, HostError>
        ) {
          const scope = yield* Scope.make();
          const gate = yield* Deferred.make<undefined>();
          let holding = false;

          model.faults.reply = ({ args }) => {
            const reply = holding ? undefined : held(args);

            if (reply === undefined) {
              return undefined;
            }

            holding = true;

            return { ...reply, until: Deferred.await(gate) };
          };

          const scoped = yield* runtimeOf(
            { ...settings, bootId },
            model.spawner
          ).pipe(Scope.provide(scope));

          yield* run(scoped);
          yield* waitFor(
            Effect.sync(() => holding),
            (parking) => parking
          );
          yield* Scope.close(scope, Exit.void);

          const closed = model.spawner.calls.length;

          yield* Deferred.succeed(gate, undefined);
          yield* TestClock.withLive(Effect.sleep(Duration.millis(100)));

          return model.spawner.calls.length - closed;
        });

        const afterRestore = yield* cutWith(
          "b00710ad",
          (args) =>
            args[1] === "status" && args.includes(`${base}_freeze`)
              ? notFound(`${base}_freeze`)
              : undefined,
          (scoped) => scoped.make(child, fromCheckpoint(buildRef), on(10_001))
        );

        let lists = 0;

        const afterSettle = yield* cutWith(
          "5bfae059",
          (args) => {
            lists += args[1] === "ls" ? 1 : 0;

            return args[1] === "ls" && lists === 2
              ? { stdout: "[]" }
              : undefined;
          },
          (scoped) => scoped.startup
        );

        expect({
          afterRestore,
          afterSettle,
          bases: basesIn(model),
        }).toStrictEqual({ afterRestore: 0, afterSettle: 0, bases: [] });
      })
  );

  it.effect(
    "a host that fetches a build's copy parks its base before the fetch ends, so its first restore branches, and parks one again when it starts",
    () =>
      Effect.gen(function* () {
        const { store } = memoryBuildStore();
        const source = smolvmModel();
        const other = smolvmModel();
        const fetched = { ...buildRef, name: "fetched-fedcba9876543210" };
        const child = childOf("web-1");
        const settings = { ...(yield* prepared()), bootId: "5bfae059" };
        const builds = yield* runtimeOf(yield* prepared(), source.spawner);
        const fetches = yield* runtimeOf(settings, other.spawner);

        building(source);
        yield* builds.capture(builderRef, buildRef);
        yield* publish(store, yield* filesOf(builds), buildRef);

        const handle = yield* fetch(
          store,
          yield* filesOf(fetches),
          fetched,
          buildRef.name,
          "web@1"
        );

        const parked = other.vms.get(baseOf(fetched, "5bfae059"))?.state;

        yield* fetches.make(
          child,
          fromCheckpoint({ ...fetched, handle }),
          on(10_001)
        );

        const rebooted = yield* runtimeOf(
          { ...settings, bootId: "c0ffee00" },
          other.spawner
        );

        yield* rebooted.startup;
        yield* waitFor(
          Effect.sync(() => other.vms.get(baseOf(fetched, "c0ffee00"))?.state),
          (state) => state === "frozen"
        );

        expect(parked).toBe("frozen");
        expect(other.vms.get(nativeName(child))?.parent).toBe(
          baseOf(fetched, "5bfae059")
        );
      })
  );

  it.effect(
    "a host that starts under another smolvm than a build was captured under drops the build's base and parks none, so its copies restore",
    () => {
      const logged: unknown[] = [];

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);

        const index = path.join(
          settings.stateDir,
          "checkpoints",
          `${nativeName(buildRef)}.checkpoint`,
          "checkpoint.json"
        );

        building(model);
        yield* runtime.capture(builderRef, buildRef);

        const parked = model.vms.get(base)?.state;

        model.vms.delete(nativeName(builderRef));

        yield* fs.writeFileString(
          index,
          (yield* fs.readFileString(index)).replace(
            `"smolvm_version":"${minimumVersion}"`,
            '"smolvm_version":"1.32.0"'
          )
        );

        const upgraded = yield* runtimeOf(settings, model.spawner);

        yield* upgraded.startup;
        yield* waitFor(
          Effect.sync(() => model.vms.has(base)),
          (kept) => !kept
        );
        yield* upgraded.make(child, fromCheckpoint(buildRef), on(10_001));
        yield* waitFor(
          Effect.sync(
            () =>
              logged.filter((line) =>
                String(line).includes(
                  "captured under smolvm 1.32.0, not this host's"
                )
              ).length
          ),
          (skipped) => skipped === 2
        );

        expect(parked).toBe("frozen");
        expect(model.vms.get(nativeName(child))?.parent).toBeUndefined();
        expect(basesIn(model)).toStrictEqual([]);
      }).pipe(Effect.provide(logging(logged)));
    }
  );

  it.effect(
    "a host that starts again under the same boot freezes a base its last run left running, so a restore branches it",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const child = childOf("web-1");
        const base = baseOf(buildRef);

        building(model);
        yield* runtime.capture(builderRef, buildRef);

        const parked = model.vms.get(base);

        if (parked !== undefined) {
          parked.state = "running";
        }

        const restarted = yield* runtimeOf(settings, model.spawner);

        yield* restarted.startup;
        yield* waitFor(
          Effect.sync(() => model.vms.get(base)?.state),
          (state) => state === "frozen"
        );
        yield* restarted.make(child, fromCheckpoint(buildRef), on(10_001));

        expect(model.vms.get(nativeName(child))?.parent).toBe(base);
      })
  );

  it.effect(
    "a host that boots again parks each build it keeps anew, and drops the old base with its last child",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const model = smolvmModel();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const child = childOf("web-1");
        const before = baseOf(buildRef);
        const after = baseOf(buildRef, "5bfae059");

        building(model);
        yield* runtime.capture(builderRef, buildRef);
        yield* runtime.make(child, fromCheckpoint(buildRef), on(10_001));

        for (const vm of model.vms.values()) {
          vm.state = "stopped";
        }

        const rebooted = yield* runtimeOf(
          { ...settings, bootId: "5bfae059" },
          model.spawner
        );

        yield* rebooted.startup;
        yield* waitFor(
          Effect.sync(() => model.vms.get(after)?.state),
          (state) => state === "frozen"
        );

        const pinned = model.vms.get(before)?.state;

        yield* rebooted.delete(child, new Set());

        expect(pinned).toBe("stopped");
        expect(model.vms.get(after)?.forwards).toStrictEqual([]);
        expect([...model.vms.keys()].toSorted()).toStrictEqual(
          [nativeName(builderRef), after].toSorted()
        );
      })
  );
});

const observed = (name: string) =>
  sized({
    name,
    instance: name.padStart(32, "0"),
    cpu: 1,
    ramMib: 1024,
    diskGib: 10,
  });

const names = ["a", "b", "c", "d"];

const machines = names.map(observed);

layer(NodeServices.layer)((it) => {
  it.effect("each machine's state comes back under its name", () =>
    Effect.gen(function* () {
      const states: readonly MachineState[] = [
        "running",
        "stopped",
        "missing",
        "running",
      ];

      const read = yield* observeEach(machines, (ref) =>
        Effect.succeed(states[names.indexOf(ref.name)] ?? "unknown")
      );

      expect(read).toStrictEqual(
        new Map([
          ["a", "running"],
          ["b", "stopped"],
          ["c", "missing"],
          ["d", "running"],
        ])
      );
    })
  );

  it.effect(
    "a read that fails reads unknown, warns why, and leaves the others",
    () =>
      Effect.gen(function* () {
        const logged: unknown[] = [];

        const read = yield* observeEach(machines, (ref) =>
          ref.name === "b"
            ? Effect.fail(
                new Internal({ message: "smolvm machine status exited 1" })
              )
            : Effect.succeed<MachineState>("running")
        ).pipe(Effect.provide(logging(logged)));

        expect(read).toStrictEqual(
          new Map([
            ["a", "running"],
            ["b", "unknown"],
            ["c", "running"],
            ["d", "running"],
          ])
        );
        expect(logged).toStrictEqual([
          ["couldn't read b's state: smolvm machine status exited 1"],
        ]);
      })
  );

  it.effect(
    "a read that takes over machineReadWait reads unknown, and the others don't wait on it",
    () =>
      Effect.gen(function* () {
        const logged: unknown[] = [];

        const fiber = yield* Effect.forkChild(
          observeEach(machines, (ref) =>
            ref.name === "c"
              ? Effect.never
              : Effect.succeed<MachineState>("stopped")
          ).pipe(Effect.provide(logging(logged)))
        );

        yield* TestClock.adjust(machineReadWait);

        const read = yield* Fiber.join(fiber);

        expect(read).toStrictEqual(
          new Map([
            ["a", "stopped"],
            ["b", "stopped"],
            ["c", "unknown"],
            ["d", "stopped"],
          ])
        );
        expect(logged).toStrictEqual([
          [
            `couldn't read c's state: no answer within ${Duration.format(machineReadWait)}`,
          ],
        ]);
      })
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
          })
      );

      expect(most).toBe(8);
    })
  );
});

const migrated = (name: string, port: number): MachineRef => ({
  name,
  instance: name.padEnd(32, "0"),
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  endpoint: { port },
});

const operationsOver = (runtime: Interface) =>
  Layer.build(
    Operations.layer({ id: "smolvm", bases: new Map() }).pipe(
      Layer.provide(Reach.layer({ first: 10_100, last: 10_109 })),
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
    "a host whose smolvm can't read one migrated machine's status reads the others, counts its capacity, makes another machine and adopts the rest",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const dev = migrated("dev", 10_000);
        const two = migrated("two", 10_001);

        for (const each of [dev, two]) {
          model.vms.set(nativeName(each), {
            state: "running",
            forwards: [`${each.endpoint?.port}:22`],
          });
        }

        model.faults.reply = ({ args }) =>
          args[1] === "status" && args.includes(nativeName(two))
            ? locked
            : undefined;

        const operations = yield* operationsOver(runtime);
        const read = yield* operations.read([dev, two]);
        const capacity = yield* operations.capacity([dev, two]);
        const adopted = yield* operations.adopt([dev, two]);

        yield* operations.run({
          id: "make-web",
          boot: operations.boot,
          scope: { resource: "machine", name: "web" },
          sequence: 1,
          step: {
            _tag: "make",
            machine: {
              name: "web",
              instance: "web".padEnd(32, "0"),
              cpu: 1,
              ramMib: 1024,
              diskGib: 10,
            },
            source: { _tag: "base", base: image },
            taken: [10_000, 10_001],
            machines: [dev, two],
          },
        });

        const made = yield* eventually(
          operations.wait("make-web"),
          (report) => report.status !== "running"
        );

        expect(Object.fromEntries(read)).toStrictEqual({
          dev: "running",
          two: "unknown",
        });
        expect(capacity).toContainEqual({
          resource: "ramMib",
          unread: ["two"],
          limit: 4096,
        });
        expect([
          adopted.adopted.map(({ name, handle }) => [name, handle]),
          adopted.unresolved,
        ]).toStrictEqual([[["dev", nativeName(dev)]], ["two"]]);
        expect([made.status, made.error]).toStrictEqual(["done", undefined]);
        expect(
          model.vms.has(
            nativeName({ name: "web", instance: "web".padEnd(32, "0") })
          )
        ).toBe(true);
      })
  );
});
