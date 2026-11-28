import { mkdirSync } from "node:fs";
import path from "node:path";

import type { MachineRef, Step } from "@clankerbox/host-contract";
import {
  copyRefusal,
  fitted,
  resizeRefusal,
} from "@clankerbox/host-contract/traits";
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
  Duration,
  Effect,
  Fiber,
  Layer,
  Logger,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import type { Facts } from "../../../src/box.ts";
import { runCommand } from "../../../src/exec.ts";
import { PortProbe } from "../../../src/machine-ports.ts";
import type { Probe } from "../../../src/machine-ports.ts";
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
import type { Settings } from "../../../src/platform/smolvm/smolvm.ts";
import * as Reach from "../../../src/reach.ts";
import { Runtime } from "../../../src/runtime.ts";
import type {
  Held,
  Identity,
  Interface,
  MachineState,
  Origin,
  Sighting,
  Sized,
  Sizes,
} from "../../../src/runtime.ts";
import { scripted as scriptedSpawner } from "../../scripted.ts";
import type { Call, Reply } from "../../scripted.ts";
import { prepared, smolvmModel } from "../../smolvm-model.ts";
import { admitOn, eventually } from "../../support.ts";

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

const listing = ["machine", "ls", "--json"];

const callsEnded: Pick<Facts, "uid" | "ended" | "aclHolder"> = {
  uid: 0,
  ended: () => Effect.succeed(true),
  aclHolder: () => Effect.undefined,
};

const everyPortFree: Probe = { free: () => Effect.succeed(true) };

const runtimeOf = (
  settings: Settings,
  spawner: ReturnType<typeof scripted>,
  box = callsEnded,
  probe = everyPortFree
) =>
  make(settings, box).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        spawner.layer,
        Layer.succeed(PortProbe, probe)
      )
    )
  );

const startupError = (
  settings: Settings,
  spawner: ReturnType<typeof scripted>,
  uid = 0,
  box: Partial<typeof callsEnded> = {}
) =>
  make(settings, { ...callsEnded, uid, ...box }).pipe(
    Effect.flip,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        spawner.layer,
        Layer.succeed(PortProbe, everyPortFree)
      )
    )
  );

const sized = (ref: Identity & Sizes): Sized => ({
  ...ref,
  handle: nativeName(ref),
});

const fromImage: Origin = { _tag: "image", image };

const fromCheckpoint = (checkpoint: Sized): Origin => ({
  _tag: "checkpoint",
  checkpoint,
});

const holdingSnap = (settings: { readonly stateDir: string }) =>
  mkdir(
    path.join(settings.stateDir, "checkpoints", "snap-fedcba98.checkpoint")
  );

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

const parkedByOlderHost = (
  model: ReturnType<typeof smolvmModel>,
  child: Sized
) => {
  const base = baseOf(buildRef);

  model.vms.set(base, { state: "frozen", forwards: [] });
  model.vms.set(nativeName(child), {
    state: "running",
    parent: base,
    forwards: ["10001:22"],
  });

  return base;
};

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
            detached: true,
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
    "a smolvm host refuses a prefix whose agent rootfs carries POSIX ACLs, which break every fork, before any smolvm call",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();

        const rootfs = path.join(
          settings.prefix,
          ".local/share/smolvm/agent-rootfs"
        );

        const asked: string[] = [];
        const spawner = scripted(() => {});

        const error = yield* startupError(settings, spawner, 0, {
          aclHolder: (directory) =>
            Effect.sync(() => {
              asked.push(directory);

              return path.join(directory, "mnt");
            }),
        });

        expect(asked).toStrictEqual([rootfs]);
        expect(error._tag).toBe("CannotStart");
        expect(error.message).toBe(
          `smolvm prefix ${settings.prefix} carries POSIX ACLs, as on ${rootfs}/mnt, which smolvm's guest kernel can't copy up, so every fork, and every capture of a stopped machine, would fail "Not supported": strip them with setfacl -bR ${settings.prefix}`
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

  it("smolvm's states map onto running and stopped by whether the VMM is alive, a paused one stopped, as no host pauses one", () => {
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
      paused: "stopped",
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
        ["far-01234567", status("unreachable")],
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
        sized({ ...machine, name: "far" }),
        sized({ ...machine, name: "gone" }),
      ]);

      expect(observed).toStrictEqual(
        new Map([
          ["dev", { state: "running" }],
          ["two", { state: "stopped" }],
          [
            "far",
            {
              state: "stopped",
              why: "smolvm reads its VM unreachable: its VM manager runs, but the agent in it doesn't answer",
            },
          ],
          ["gone", { state: "missing" }],
        ])
      );
      expect(smolvmArgs(spawner.calls).map((args) => args[3])).toStrictEqual(
        expect.arrayContaining([
          "dev-01234567",
          "two-01234567",
          "far-01234567",
          "gone-01234567",
        ])
      );
      expect(spawner.calls).toHaveLength(5);
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
            ["dev", { state: "unknown" }],
            ["two", { state: "stopped" }],
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
            ["two", { state: "stopped" }],
            ...hanging.map(({ name }) => [name, { state: "unknown" }] as const),
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

        yield* runtime.make(machine, fromImage, 10_000);

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
            10_000
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
    "start leaves a running machine as it is, boots an unreachable one again, and refuses a frozen or missing one before anything native",
    () =>
      Effect.gen(function* () {
        let reply = status("running");

        const spawner = scripted((call) =>
          call.args[1] === "status" ? reply : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        for (const next of ["running", "unreachable"] as const) {
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
    "a live RAM grow past what smolvm's VMM reserved above the boot RAM fails Unsizable, saying so",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "resize"
            ? {
                exitCode: 1,
                stderr:
                  "Error: RAM resize: RAM growth not confirmed: ERR EIO RAM hot-add area must grow in 128 MiB units within the platform aperture; limits may be raised, reconcile before retrying\n",
              }
            : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

        const refused = yield* Effect.flip(
          runtime.resize(machine, { ramMib: 200_000 }, true)
        );

        expect(refused._tag).toBe("Unsizable");
        expect(refused.message).toContain("64G above the RAM it booted with");
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

  it.effect("stop leaves a stopped or missing machine as it is", () =>
    Effect.gen(function* () {
      let reply = status("stopped");

      const spawner = scripted((call) =>
        call.args[1] === "status" ? reply : undefined
      );

      const runtime = yield* runtimeOf(yield* prepared(), spawner);

      for (const next of [status("stopped"), unknown]) {
        reply = next;
        yield* runtime.stop(machine);
      }

      expect(
        smolvmArgs(spawner.calls).map((args) => args.slice(1, 4).join(" "))
      ).toStrictEqual([
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
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, failing),
              Layer.succeed(PortProbe, everyPortFree)
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
    "a host that starts beside a base an older host parked counts its memory",
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

  const copyPort = 10_001;

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
    "a capture or a fork of a machine smolvm reads neither running nor stopped is refused before anything native",
    () =>
      Effect.gen(function* () {
        let reply = unknown;

        const spawner = scripted((call) =>
          call.args[1] === "status" ? reply : undefined
        );

        const runtime = yield* runtimeOf(yield* prepared(), spawner);

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

        expect([missing, unreachable, frozen].map(failure)).toStrictEqual([
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
            "smolvm reads machine dev frozen, and copies only a running or stopped machine",
          ],
        ]);
        expect(smolvmArgs(spawner.calls).map((args) => args[1])).toStrictEqual([
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
    "find answers the handle a make gave its instance and none for another instance of its name",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const later = { ...machine, instance: "76543210".repeat(4) };
        const { handle } = yield* runtime.make(machine, fromImage, 10_000);

        expect({
          machine: yield* runtime.find(machine),
          later: yield* runtime.find(later),
        }).toStrictEqual({ machine: handle, later: undefined });
      })
  );

  it.effect(
    "a restore of a ram checkpoint creates from the store with no restore cache, its port moved, boots, then boots again, so it holds its source's disk and none of its memory",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();

        yield* holdingSnap(settings);
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf(settings, spawner);

        yield* runtime.make(copy, fromCheckpoint(ramCheckpoint), copyPort);

        expect(smolvmArgs(spawner.calls)).toStrictEqual([
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
          ["machine", "stop", "--name", "copy-abcdefab"],
          ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
        ]);
      })
  );

  it.effect(
    "a host that starts removes each image seed build whose smolvm call has ended, the VM its record lost included, and keeps one whose call still runs",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const left = "image-seed-0123456789abcdef-4242";
        const running = "image-seed-fedcba9876543210-4243";

        model.running.add(4243);
        model.orphanVmm(left);
        model.orphanVmm(running);

        const runtime = yield* runtimeOf(
          yield* prepared(),
          model.spawner,
          model.box()
        );

        yield* runtime.startup;

        expect([model.vms.has(left), model.vms.has(running)]).toStrictEqual([
          false,
          true,
        ]);
        expect(model.vmmsLeft()).toStrictEqual([running]);
      })
  );

  it.effect(
    "a host removes only the seed builds smolvm names, sixteen hex digits of its key and then its PID, and leaves a VM named otherwise whose PID has ended",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const seed = "image-seed-0123456789abcdef-4242";

        const others = [
          "image-seed-made-by-hand-4242",
          "image-seed-0123456789abcde-4242",
          "image-seed-0123456789ABCDEF-4242",
          "image-seed-0123456789abcdef0-4242",
        ];

        for (const vm of [seed, ...others]) {
          model.vms.set(vm, { state: "running", forwards: [] });
        }

        const runtime = yield* runtimeOf(
          yield* prepared(),
          model.spawner,
          model.box()
        );

        yield* runtime.startup;

        expect(
          [seed, ...others].filter((vm) => model.vms.has(vm))
        ).toStrictEqual(others);
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
            Effect.exit(runtime.make(machine, { _tag: "image", image }, 10_022))
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
    "a machine whose VM smolvm would take for a builder of its own and delete is refused, and nothing is made",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const before = model.spawner.calls.length;

        const refused = yield* Effect.forEach(
          ["image-seed", "image-seed-x", "init-bake-x"],
          (name) =>
            Effect.flip(
              runtime.make(sized({ ...machine, name }), fromImage, 10_022)
            )
        );

        expect(refused.map(({ _tag }) => _tag)).toStrictEqual([
          "Invalid",
          "Invalid",
          "Invalid",
        ]);
        expect(refused.map(({ message }) => message)).toStrictEqual([
          "a smolvm host makes no machine named image-seed: smolvm takes a VM whose name begins image-seed- for the builder of its image seeds, and deletes it once it is 30 minutes old",
          "a smolvm host makes no machine named image-seed-x: smolvm takes a VM whose name begins image-seed- for the builder of its image seeds, and deletes it once it is 30 minutes old",
          "a smolvm host makes no machine named init-bake-x: smolvm takes a VM whose name begins init-bake- for the builder of its init layers, and deletes it once it is 30 minutes old",
        ]);
        expect(model.spawner.calls.slice(before)).toStrictEqual([]);
        expect(
          yield* Effect.exit(
            runtime.make(
              sized({ ...machine, name: "image" }),
              fromImage,
              10_022
            )
          )
        ).toMatchObject({ _tag: "Success" });
      })
  );

  it.effect(
    "a machine named as a seed build begins, made before smolvm's names were refused, survives a host's start and another machine's failed boot, as does a VM named for a PID Linux never gives",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();

        const kept = sized({
          ...machine,
          name: "image-seed-x",
          instance: "12345678abcdefabcdefabcdefabcdef",
        });

        const beyond = "image-seed-0123456789abcdef-4194304";

        model.vms.set(kept.handle, { state: "running", forwards: [] });
        model.vms.set(beyond, { state: "running", forwards: [] });

        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        yield* runtime.startup;

        model.faults.reply = ({ args }) =>
          args[1] === "start"
            ? { exitCode: 1, stderr: "Error: image seed failed\n" }
            : undefined;

        yield* Effect.exit(runtime.make(machine, fromImage, 10_022));

        expect([
          model.vms.get(kept.handle)?.state,
          model.vms.get(beyond)?.state,
        ]).toStrictEqual(["running", "running"]);
      })
  );

  it.effect(
    "a host's start that can't remove one seed build still removes the rest",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const stuck = "image-seed-0123456789abcdef-4242";
        const left = "image-seed-fedcba9876543210-4242";

        model.orphanVmm(stuck);
        model.orphanVmm(left);
        model.faults.reply = ({ args }) =>
          args[1] === "delete" && args.includes(stuck) ? locked : undefined;

        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);

        yield* runtime.startup;

        expect(model.vms.has(left)).toBe(false);
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
    "a base an older host parked outlives a host's start while a copy branched from it is left, and goes with its last copy",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const child = childOf("web-1");
        const base = parkedByOlderHost(model, child);
        const lone = baseOf({ ...buildRef, name: "built-fedcba9876543210" });

        model.vms.set(lone, { state: "frozen", forwards: [] });

        yield* runtime.startup;
        yield* waitFor(
          Effect.sync(() => model.vms.has(lone)),
          (left) => !left
        );

        const kept = model.vms.get(base)?.state;

        yield* runtime.delete(child, new Set());

        expect(kept).toBe("frozen");
        expect([...model.vms.keys()]).toStrictEqual([]);
      })
  );

  it.effect(
    "a copy's delete that can't retire its base still succeeds, and a delete again retires it",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const runtime = yield* runtimeOf(yield* prepared(), model.spawner);
        const child = childOf("web-1");
        const base = parkedByOlderHost(model, child);

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
    "a base a copy's delete couldn't retire goes at the host's next start",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const settings = yield* prepared();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const child = childOf("web-1");
        const base = parkedByOlderHost(model, child);

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

  it.effect("a ram restore that got its source's old port keeps it", () =>
    Effect.gen(function* () {
      const spawner = scripted(() => {});
      const settings = yield* prepared();
      const runtime = yield* runtimeOf(settings, spawner);

      yield* holdingSnap(settings);

      yield* runtime.make(copy, fromCheckpoint(ramCheckpoint), 10_000);

      expect(smolvmArgs(spawner.calls).map((args) => args[1])).toStrictEqual([
        "create",
        "start",
        "stop",
        "start",
      ]);
    })
  );

  it.effect(
    "smolvm's traits bound a machine at 64M of RAM at least, and at most at 16 vCPUs, the most its guest kernel boots, on every architecture, and the RAM its CLI parses, also for a running one, so a machine an older host gave more vCPUs is resized only to 16 or fewer and never copied; a live grow of RAM off its 128M steps or of vCPUs off x86_64 is Unsizable before anything native",
    () =>
      Effect.gen(function* () {
        const settings = yield* prepared();
        const spawner = scripted(() => {});
        const runtime = yield* runtimeOf({ ...settings, arch: "x64" }, spawner);
        const arm = yield* runtimeOf({ ...settings, arch: "arm64" }, spawner);
        const before = spawner.calls.length;

        const fits = (on: typeof runtime, sizes: Partial<typeof machine>) =>
          fitted(on.traits, { ...machine, ...sizes });

        const old = { ...machine, cpu: 32 };

        const resized = (
          state: "running" | "stopped",
          cpu: number
        ): string | undefined =>
          resizeRefusal(runtime.traits, "dev", state, machine, {
            ...machine,
            cpu,
          })?.message;

        expect({
          ramMib: [
            fits(runtime, { ramMib: 64 }),
            fits(runtime, { ramMib: 63 }),
          ],
          mostRamMib: [
            fits(runtime, { ramMib: 2 ** 32 - 1 }),
            fits(runtime, { ramMib: 2 ** 32 }),
          ],
          x64: [fits(runtime, { cpu: 16 }), fits(runtime, { cpu: 17 })],
          arm64: [fits(arm, { cpu: 16 }), fits(arm, { cpu: 17 })],
          resized: [
            resized("running", 16),
            resized("running", 17),
            resized("stopped", 16),
            resized("stopped", 32),
          ],
          given32: [
            resizeRefusal(runtime.traits, "old", "stopped", old, {
              ...old,
              ramMib: 4096,
            })?._tag,
            resizeRefusal(runtime.traits, "old", "stopped", old, {
              ...old,
              cpu: 16,
              ramMib: 4096,
            })?._tag,
            copyRefusal(runtime.traits, "dev", "fork", old, old) === undefined,
          ],
        }).toStrictEqual({
          ramMib: [true, false],
          mostRamMib: [true, false],
          x64: [true, false],
          arm64: [true, false],
          resized: [
            undefined,
            "the smolvm runtime gives any sizes from 64M of RAM up to 16 vCPUs and 4294967295M of RAM, and dev was asked 17 vCPUs, 2G of RAM and 20G of disk",
            undefined,
            "the smolvm runtime gives any sizes from 64M of RAM up to 16 vCPUs and 4294967295M of RAM, and dev was asked 32 vCPUs, 2G of RAM and 20G of disk",
          ],
          given32: ["Unsizable", undefined, false],
        });

        expect([
          resizeRefusal(runtime.traits, "dev", "running", machine, {
            ...machine,
            ramMib: machine.ramMib + 65 * 1024,
          })?.message,
          resizeRefusal(arm.traits, "dev", "running", machine, {
            ...machine,
            cpu: 4,
          })?._tag,
          resizeRefusal(arm.traits, "dev", "stopped", machine, {
            ...machine,
            cpu: 4,
          })?._tag,
        ]).toStrictEqual([
          "the smolvm runtime grows a running machine's RAM at most 64G above the RAM it booted with, and dev's would grow by 65G: give dev more once it is stopped",
          "Unsizable",
          undefined,
        ]);

        const refused = [
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
          { ...machine, cpu: 16, ramMib: 2176 },
          true
        );

        expect(refused.map(failure)).toStrictEqual([
          [
            "Unsizable",
            "the smolvm runtime grows a running machine's RAM in 128M steps, and dev's would grow from 2G to 2100M",
          ],
          [
            "Unsizable",
            "the smolvm runtime grows no running machine's vCPUs on this host, and dev has 2 vCPUs: give dev more once it is stopped",
          ],
        ]);
        expect(spawner.calls).toHaveLength(before);
      })
  );

  it.effect(
    "a restore of a ram checkpoint or a fork of a running machine given other sizes than its source's sets them while the copy is stopped between its boots",
    () =>
      Effect.gen(function* () {
        const spawner = scripted((call) =>
          call.args[1] === "status" ? status("running") : undefined
        );

        const settings = yield* prepared();
        const runtime = yield* runtimeOf(settings, spawner);

        yield* holdingSnap(settings);

        const larger = {
          ...copy,
          cpu: 4,
          ramMib: 4096,
          diskGib: 30,
        };

        yield* runtime.make(larger, fromCheckpoint(ramCheckpoint), 10_000);
        yield* runtime.make(
          { ...larger, cpu: 2, ramMib: 1024 },
          fromMachine(machine),
          10_000
        );

        const update = (...flags: readonly string[]) => [
          "machine",
          "update",
          "--name",
          nativeName(copy),
          ...flags,
        ];

        expect(
          smolvmArgs(spawner.calls).filter((args) => args[1] === "update")
        ).toStrictEqual([
          update("--cpus", "4", "--mem", "4096", "--storage", "30"),
          update("--mem", "1024", "--storage", "30"),
        ]);
        expect(
          smolvmArgs(spawner.calls)
            .slice(0, 5)
            .map((args) => args[1])
        ).toStrictEqual(["create", "start", "stop", "update", "start"]);
      })
  );

  it.effect(
    "a restore whose create, boot or resize fails returns its error, and leaves its VM to delete",
    () =>
      Effect.gen(function* () {
        const larger = { ...copy, ramMib: 4096 };

        for (const failing of ["create", "start", "update"]) {
          const spawner = scripted((call) =>
            call.args[1] === failing
              ? { exitCode: 1, stderr: "Error: database is locked\n" }
              : undefined
          );

          const settings = yield* prepared();
          const runtime = yield* runtimeOf(settings, spawner);

          yield* holdingSnap(settings);

          const error = yield* Effect.flip(
            runtime.make(larger, fromCheckpoint(ramCheckpoint), copyPort)
          );

          const steps = ["create", "start", "stop", "update"];
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
    "a fork of a running machine captures it into a store of its own, restores from it, boots the copy again, and removes the store",
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
          ["machine", "stop", "--name", "copy-abcdefab"],
          ["machine", "start", "--name", "copy-abcdefab", "--branchable"],
        ]);
        expect(
          yield* readDirectory(path.join(settings.stateDir, "forks"))
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "a fork of a stopped machine packs it with its /workspace into a store of its own, never booting it, creates the copy from the pack at its own sizes and port, boots it, and removes the store",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const settings = yield* prepared();
        const runtime = yield* runtimeOf(settings, model.spawner);
        const store = path.join(settings.stateDir, "forks", "copy-abcdefab");
        const smaller = { ...copy, cpu: 1, ramMib: 1024, diskGib: 30 };

        model.vms.set(nativeName(machine), {
          state: "stopped",
          forwards: ["10000:22"],
        });

        const before = model.spawner.calls.length;

        yield* runtime.make(smaller, fromMachine(machine), copyPort);

        expect(
          model.spawner.calls
            .slice(before)
            .map(({ args }) => args.slice(0, 2).join(" "))
        ).toStrictEqual([
          "machine status",
          "pack create",
          "machine create",
          "machine start",
        ]);
        expect(
          model.spawner.calls.find(({ args }) => args[0] === "pack")?.args
        ).toStrictEqual([
          "pack",
          "create",
          "--from-vm",
          "dev-01234567",
          "--include-workspace",
          "-o",
          path.join(store, "machine"),
        ]);
        expect(model.vms.get(nativeName(machine))?.state).toBe("stopped");
        expect(model.vms.get(nativeName(copy))).toStrictEqual({
          state: "running",
          forwards: ["10001:22"],
          sizes: { "--cpus": 1, "--mem": 1024, "--storage": 30 },
          unpacked: "dev-01234567",
        });
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
    "a capture of a stopped machine packs it with its /workspace into its checkpoint, never booting it, and a restore of that creates the copy from the pack at its own sizes and port and boots it once",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const settings = yield* prepared();
        const runtime = yield* runtimeOf(settings, model.spawner);

        const held = path.join(
          settings.stateDir,
          "checkpoints",
          "snap-fedcba98.checkpoint"
        );

        model.vms.set(nativeName(machine), {
          state: "stopped",
          forwards: ["10000:22"],
        });

        const handle = yield* runtime.capture(machine, ramCheckpoint);
        const captured = yield* readDirectory(held);
        const before = model.spawner.calls.length;

        yield* runtime.make(
          { ...copy, ramMib: 1024 },
          fromCheckpoint({ ...ramCheckpoint, handle }),
          copyPort
        );

        expect(handle).toBe("snap-fedcba98");
        expect(captured).toStrictEqual(["machine.smolmachine"]);
        expect(model.packs).toStrictEqual(["dev-01234567"]);
        expect(model.vms.get(nativeName(machine))?.state).toBe("stopped");
        expect(
          model.spawner.calls
            .slice(before)
            .map(({ args }) => args.slice(0, 2).join(" "))
        ).toStrictEqual(["machine create", "machine start"]);
        expect(model.vms.get(nativeName(copy))).toStrictEqual({
          state: "running",
          forwards: ["10001:22"],
          sizes: { "--cpus": 2, "--mem": 1024, "--storage": 20 },
          unpacked: "dev-01234567",
        });
      })
  );

  it.effect(
    "a capture of a stopped machine whose pack fails leaves no checkpoint behind",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();
        const settings = yield* prepared();
        const runtime = yield* runtimeOf(settings, model.spawner);

        model.vms.set(nativeName(machine), { state: "stopped", forwards: [] });
        model.faults.reply = ({ args }) =>
          args[0] === "pack" ? locked : undefined;

        const error = yield* Effect.flip(
          runtime.capture(machine, ramCheckpoint)
        );

        expect(error.message).toBe(
          "smolvm pack create dev-01234567 exited 1: Error: database is locked"
        );
        expect(
          yield* readDirectory(path.join(settings.stateDir, "checkpoints"))
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "deleting a checkpoint removes its directory, then prunes the store",
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
          ["machine", "checkpoint-prune", "--store", store],
        ]);
      })
  );

  it.effect(
    "deleting a checkpoint from a store no capture has written prunes nothing",
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

        expect(smolvmArgs(spawner.calls)).toStrictEqual([listing, listing]);
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
        Effect.succeed({ state: states[names.indexOf(ref.name)] ?? "unknown" })
      );

      expect(read).toStrictEqual(
        new Map([
          ["a", { state: "running" }],
          ["b", { state: "stopped" }],
          ["c", { state: "missing" }],
          ["d", { state: "running" }],
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
            : Effect.succeed<Sighting>({ state: "running" })
        ).pipe(Effect.provide(logging(logged)));

        expect(read).toStrictEqual(
          new Map([
            ["a", { state: "running" }],
            ["b", { state: "unknown" }],
            ["c", { state: "running" }],
            ["d", { state: "running" }],
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
              : Effect.succeed<Sighting>({ state: "stopped" })
          ).pipe(Effect.provide(logging(logged)))
        );

        yield* TestClock.adjust(machineReadWait);

        const read = yield* Fiber.join(fiber);

        expect(read).toStrictEqual(
          new Map([
            ["a", { state: "stopped" }],
            ["b", { state: "stopped" }],
            ["c", { state: "unknown" }],
            ["d", { state: "stopped" }],
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
          Effect.gen(function* (): Effect.fn.Return<Sighting> {
            running += 1;
            most = Math.max(most, running);

            yield* Effect.yieldNow;

            running -= 1;

            return { state: "running" } satisfies Sighting;
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
  port,
});

const operationsOver = (runtime: Interface) =>
  Layer.build(
    Operations.layer({ id: "smolvm", bases: new Map() }).pipe(
      Layer.provide(Reach.layer({ first: 10_100, last: 10_109 })),
      Layer.provideMerge(Layer.succeed(Runtime, runtime)),
      Layer.provide(
        Layer.merge(Layer.succeed(PortProbe, everyPortFree), Relay.layer)
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
            forwards: [`${each.port}:22`],
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
          dev: { state: "running" },
          two: { state: "unknown" },
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

  it.effect(
    "a start of a machine whose port another program holds fails Capacity naming the port and the cure, with nothing sent to boot it, while a running machine's resize or start, whose VM holds its port, goes on",
    () =>
      Effect.gen(function* () {
        const model = smolvmModel();

        const runtime = yield* runtimeOf(
          yield* prepared(),
          model.spawner,
          model.box(),
          model.probe
        );

        const stopped = migrated("stopped", 10_000);
        const grown = migrated("grown", 10_003);
        const again = migrated("again", 10_004);

        const states = new Map([
          [stopped, "stopped"],
          [grown, "running"],
          [again, "running"],
        ] as const);

        for (const [each, state] of states) {
          model.vms.set(nativeName(each), {
            state,
            forwards: [`${each.port}:22`],
          });

          if (state !== "running") {
            model.elsewhere.add(each.port ?? 0);
          }
        }

        const operations = yield* operationsOver(runtime);
        const onHost = [...states.keys()];
        const before = model.spawner.calls.length;

        const steps: ReadonlyArray<readonly [string, Step]> = [
          [
            stopped.name,
            { _tag: "start", machine: stopped, keep: [], machines: onHost },
          ],
          [
            grown.name,
            {
              _tag: "resize",
              machine: grown,
              to: { ramMib: 1152 },
              machines: onHost,
            },
          ],
          [
            again.name,
            { _tag: "start", machine: again, keep: [], machines: onHost },
          ],
        ];

        const reports = yield* Effect.forEach(steps, ([name, step]) =>
          Effect.andThen(
            operations.run({
              id: `step-${name}`,
              boot: operations.boot,
              scope: { resource: "machine", name },
              sequence: 1,
              step,
            }),
            eventually(
              operations.wait(`step-${name}`),
              (report) => report.status !== "running"
            )
          )
        );

        expect(
          reports.map((report) => [
            report.status,
            report.error?._tag,
            report.error?.message,
          ])
        ).toStrictEqual([
          [
            "failed",
            "Capacity",
            "startMachine stopped needs port 10000 on 100.64.0.10, which another program on this host holds: free it, then ask again",
          ],
          ["done", undefined, undefined],
          ["done", undefined, undefined],
        ]);
        expect(
          smolvmArgs(model.spawner.calls.slice(before)).filter(
            ([, command]) => command === "start"
          )
        ).toStrictEqual([]);
        expect(
          onHost.map((each) => model.vms.get(nativeName(each))?.state)
        ).toStrictEqual(["stopped", "running", "running"]);
      })
  );
});
