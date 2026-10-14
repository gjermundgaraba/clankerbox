/**
 * Each machine's guest root is a directory its commands see as `/` through `CLANKERBOX_ROOT`, and
 * commands run under the host's `/bin/sh`. A fork or restore copies the source's root, identity
 * files included, as a RAM copy does.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Capacity, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Deferred, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { checkRamBudget } from "../src/ram-budget.ts";
import { allotted, inUse } from "../src/usage.ts";
import {
  type Activation,
  type CheckpointKind,
  type CheckpointRef,
  type Held,
  type MachineRef,
  type MachineState,
  missing,
  type Observed,
  Refusal,
  type RoomError,
  Runtime,
  type RuntimeError,
} from "../src/runtime.ts";

export type Operation =
  | "admit"
  | "capacity"
  | "create"
  | "start"
  | "stop"
  | "delete"
  | "exec"
  | "capture"
  | "restore"
  | "fork"
  | "deleteCheckpoint";

export interface FakeOptions {
  readonly dir: string;
  /** Set to `undefined`, not left out, for machines with no host port. Default: 127.0.0.1. */
  readonly publishAddress?: string | undefined;
  readonly ramBudgetMib?: number | undefined;
  readonly pin?: string | undefined;
  /** `ram`, the default, captures and forks only a running machine, as smolvm does. */
  readonly checkpointKind?: CheckpointKind | undefined;
}

export const writeStubs = (dir: string, uname = "Linux"): string => {
  const bin = join(dir, "bin");

  mkdirSync(bin, { recursive: true });

  const stubs: ReadonlyArray<readonly [string, string]> = [
    ["uname", `echo ${uname}`],
    ["perl", `echo "perl $3" >>"$CLANKERBOX_ROOT/calls"`],
    [
      "ssh-keygen",
      [
        `echo "ssh-keygen $*" >>"$CLANKERBOX_ROOT/calls"`,
        `mkdir -p "$CLANKERBOX_ROOT/etc/ssh"`,
        `key=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \\n')`,
        `: >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key"`,
        `echo "ssh-ed25519 AAAA$key root@stub" >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key.pub"`,
      ].join("\n"),
    ],
  ];

  for (const [name, body] of stubs) {
    const file = join(bin, name);

    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }

  return bin;
};

interface FakeMachine {
  state: MachineState;
  readonly root: string;
}

type Injection =
  | { readonly kind: "fail"; readonly error: RuntimeError | Capacity | Refusal }
  | { readonly kind: "die"; readonly message: string }
  | {
      readonly kind: "hold";
      readonly entered: Deferred.Deferred<void>;
      readonly until: Deferred.Deferred<void>;
    };

type Refusable = "create" | "start" | "capture" | "restore" | "fork";

/** The operations that take room, and so may fail with `Capacity`. */
type RoomOperation = Refusable | "admit";

/** What `operation` may fail with, as the `Runtime` port types it. */
type FailureOf<O extends Operation> = O extends Refusable
  ? RoomError | Refusal
  : O extends RoomOperation
    ? RoomError
    : RuntimeError;

export const fakeRuntime = (options: FakeOptions) => {
  const machines = new Map<string, FakeMachine>();
  const calls: Array<string> = [];
  const activations: Array<Activation> = [];
  const observed: Array<ReadonlyArray<string>> = [];
  const injections = new Map<Operation, Array<Injection>>();
  const observeFailures: Array<RuntimeError | "hang"> = [];
  const publishAddress = "publishAddress" in options ? options.publishAddress : "127.0.0.1";
  let stubs: string | undefined;

  const inject = (operation: Operation, injection: Injection) => {
    injections.set(operation, [...(injections.get(operation) ?? []), injection]);
  };

  /** Injections fire in the order they were queued. */
  const enter = <O extends Operation>(
    operation: O,
    resource: { readonly id: string },
  ): Effect.Effect<void, FailureOf<O>> =>
    Effect.gen(function* () {
      calls.push(`${operation} ${resource.id}`);

      const injection = injections.get(operation)?.shift();

      if (injection === undefined) {
        return;
      }

      if (injection.kind === "hold") {
        yield* Deferred.succeed(injection.entered, undefined);

        return yield* Deferred.await(injection.until);
      }

      if (injection.kind === "die") {
        return yield* Effect.die(new Error(injection.message));
      }

      // SAFETY: `failNext` queues only a `FailureOf<O>` for `O`.
      return yield* Effect.fail(injection.error as FailureOf<O>);
    });

  const states = (refs: ReadonlyArray<MachineRef>): Effect.Effect<ReadonlyArray<Observed>> =>
    Effect.sync(() => {
      observed.push(refs.map(({ id }) => id));

      return refs.map((machine) => ({ state: machines.get(machine.name)?.state ?? "missing" }));
    });

  const observe = (refs: ReadonlyArray<MachineRef>) =>
    Effect.suspend(() => {
      const failure = observeFailures.shift();

      if (failure === undefined) {
        return states(refs);
      }

      return failure === "hang" ? Effect.never : Effect.fail(failure);
    });

  const capacity = (held: ReadonlyArray<Held>) =>
    Effect.andThen(
      enter("capacity", { id: "host" }),
      Effect.map(inUse(held, states), ({ running, unread }) =>
        allotted(running, unread, options.ramBudgetMib),
      ),
    );

  const checkpointRoot = (checkpoint: CheckpointRef) =>
    join(options.dir, "checkpoints", checkpoint.instance);

  const copyInto = (from: string, machine: MachineRef) =>
    Effect.tryPromise({
      try: async () => {
        const root = join(options.dir, "roots", machine.instance);

        await access(from);
        await cp(from, root, { recursive: true });
        machines.set(machine.name, { state: "running", root });
      },
      catch: (cause) => new Internal({ message: `copy into ${machine.id}: ${String(cause)}` }),
    });

  const copyable = (machine: MachineRef) => {
    const state = machines.get(machine.name)?.state ?? "missing";

    if (state === "running" || (state === "stopped" && options.checkpointKind === "disk")) {
      return Effect.void;
    }

    return Effect.fail(
      state === "missing"
        ? missing("smolvm", machine)
        : new Refusal({
            error: new Precondition({ message: `${machine.id} is stopped: start it first` }),
          }),
    );
  };

  const rootOf = (machine: MachineRef) => {
    const found = machines.get(machine.name);

    return found === undefined
      ? Effect.fail(new Internal({ message: `no machine ${machine.id}` }))
      : Effect.succeed(found.root);
  };

  const running = (machine: MachineRef) => {
    const found = machines.get(machine.name);

    return found?.state === "running"
      ? Effect.succeed(found)
      : Effect.fail(new Internal({ message: `exec: ${machine.id} isn't running` }));
  };

  const layer = Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bin = yield* Effect.sync(() => writeStubs(options.dir));

      stubs = bin;

      return Runtime.of({
        name: "smolvm",
        version: "fake",
        publishAddress,
        pin: options.pin ?? "fake 1",
        checkpointKind: options.checkpointKind ?? "ram",
        captureFrom: "running",
        loginUser: "root",
        startup: () => Effect.sync(() => calls.push("startup")),
        observe,
        admit: (activation: Activation) =>
          Effect.andThen(
            Effect.andThen(
              Effect.sync(() => activations.push(activation)),
              enter("admit", activation.machine),
            ),
            options.ramBudgetMib === undefined
              ? Effect.void
              : checkRamBudget(options.ramBudgetMib, activation, states),
          ),
        capacity,
        create: (machine) =>
          Effect.andThen(
            enter("create", machine),
            Effect.promise(async () => {
              // A machine made again under the same name gets a fresh root.
              const root = join(options.dir, "roots", machine.instance);

              await mkdir(join(root, "dev"), { recursive: true });
              machines.set(machine.name, { state: "running", root });
            }),
          ),
        // As smolvm: a start refuses a machine it doesn't have, and a stop ignores one.
        start: (machine) =>
          Effect.andThen(
            enter("start", machine),
            Effect.suspend(() => {
              const found = machines.get(machine.name);

              if (found === undefined) {
                return Effect.fail(missing("smolvm", machine));
              }

              found.state = "running";

              return Effect.void;
            }),
          ),
        stop: (machine) =>
          Effect.andThen(
            enter("stop", machine),
            Effect.sync(() => {
              const found = machines.get(machine.name);

              if (found !== undefined) {
                found.state = "stopped";
              }
            }),
          ),
        delete: (machine) =>
          Effect.andThen(
            enter("delete", machine),
            Effect.sync(() => {
              machines.delete(machine.name);
            }),
          ),
        capture: (machine, checkpoint) =>
          Effect.andThen(
            enter("capture", checkpoint),
            Effect.andThen(
              copyable(machine),
              Effect.flatMap(rootOf(machine), (root) =>
                Effect.promise(() => cp(root, checkpointRoot(checkpoint), { recursive: true })),
              ),
            ),
          ),
        restore: (checkpoint, machine) =>
          Effect.andThen(enter("restore", machine), copyInto(checkpointRoot(checkpoint), machine)),
        fork: (source, machine) =>
          Effect.andThen(
            enter("fork", machine),
            Effect.andThen(
              copyable(source),
              Effect.flatMap(rootOf(source), (root) => copyInto(root, machine)),
            ),
          ),
        deleteCheckpoint: (checkpoint) =>
          Effect.andThen(
            enter("deleteCheckpoint", checkpoint),
            Effect.promise(() => rm(checkpointRoot(checkpoint), { recursive: true, force: true })),
          ),
        exec: (machine, command) =>
          Effect.gen(function* () {
            yield* enter("exec", machine);

            const { root } = yield* running(machine);
            const [file = "/bin/sh", ...args] = command.argv;

            const handle = yield* spawner
              .spawn(
                ChildProcess.make(file, args, {
                  env: { CLANKERBOX_ROOT: root, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
                  extendEnv: true,
                  // smolvm SIGKILLs a killed exec's guest command, so no trap runs.
                  killSignal: "SIGKILL",
                  stdin:
                    command.stdin === undefined
                      ? "ignore"
                      : Stream.make(Uint8Array.from(command.stdin)),
                }),
              )
              .pipe(Effect.mapError((error) => new Internal({ message: error.message })));

            return {
              output: Stream.mapError(
                handle.all,
                (error) => new Internal({ message: error.message }),
              ),
              exitCode: Effect.mapError(
                handle.exitCode,
                (error) => new Internal({ message: error.message }),
              ),
            };
          }),
      });
    }),
  );

  return {
    layer,
    calls,
    activations,
    observed,
    root: (name: string) => machines.get(name)?.root,
    machines,
    stubs: () => stubs,
    failNext: <O extends Operation>(operation: O, error: FailureOf<O>) => {
      inject(operation, { kind: "fail", error });
    },
    dieNext: (operation: Operation, message: string) => {
      inject(operation, { kind: "die", message });
    },
    failNextObserve: (error: RuntimeError) => {
      observeFailures.push(error);
    },
    hangNextObserve: () => {
      observeFailures.push("hang");
    },
    /** `entered` ends once the held call has started, so its action is past its claim. */
    holdNext: (operation: Operation) => {
      const until = Deferred.makeUnsafe<void>();
      const entered = Deferred.makeUnsafe<void>();

      inject(operation, { kind: "hold", entered, until });

      return { release: Deferred.succeed(until, undefined), entered: Deferred.await(entered) };
    },
  };
};

export type FakeRuntime = ReturnType<typeof fakeRuntime>;
