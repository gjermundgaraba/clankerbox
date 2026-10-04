/**
 * A fake runtime for unit tests. Its machines live in memory, and each has a guest root: a
 * temporary directory that its commands see as `/` through `CLANKERBOX_ROOT`. Commands run with
 * the host's own `/bin/sh`, so setup and preparation run for real, with `perl`, `ssh-keygen` and
 * `uname` stubbed. A checkpoint is a copy of its machine's root, and a fork or restore copies a
 * root into the new machine's, so the copy carries the source's identity files as a RAM copy
 * does. Tests can fail, refuse or hold any runtime call.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type HostError, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { checkRamBudget } from "../src/ram-budget.ts";
import {
  type Activation,
  type CheckpointKind,
  type CheckpointRef,
  type MachineRef,
  type MachineState,
  type Observed,
  type Refusal,
  Runtime,
} from "../src/runtime.ts";

/** The runtime calls a test can fail, refuse or hold. */
export type Operation =
  | "admit"
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
  /** Where machines' guest roots and the command stubs go. */
  readonly dir: string;
  /** `undefined` gives machines no host port. Default: 127.0.0.1. */
  readonly publishAddress?: string | undefined;
  /** When set, `admit` checks the RAM budget like smolvm. */
  readonly ramBudgetMib?: number | undefined;
  /** What `ram` checkpoints record. Default: `fake 1`. */
  readonly pin?: string | undefined;
  /**
   * The kind of every checkpoint. `ram`, the default, captures only a running machine, as
   * smolvm does; `disk` captures one in any state, as boat does.
   */
  readonly checkpointKind?: CheckpointKind | undefined;
}

/**
 * Stubs for the guest commands preparation calls. Each appends its call to `$root/calls`.
 * `ssh-keygen -A` writes an ed25519 key pair with a fresh public key.
 */
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

/** What a test injects into the next call of an operation. */
type Injection =
  | { readonly kind: "fail"; readonly error: HostError }
  | { readonly kind: "hold"; readonly entered: () => void; readonly until: Promise<void> };

/** The calls a runtime can refuse. */
type Refusable = "create" | "start" | "capture" | "restore" | "fork";

export const fakeRuntime = (options: FakeOptions) => {
  const machines = new Map<string, FakeMachine>();
  const calls: Array<string> = [];
  const activations: Array<Activation> = [];
  const observed: Array<ReadonlyArray<string>> = [];
  const injections = new Map<Operation, Array<Injection>>();
  const refusals = new Map<Refusable, Array<Refusal>>();
  const publishAddress = "publishAddress" in options ? options.publishAddress : "127.0.0.1";
  let stubs: string | undefined;

  const inject = (operation: Operation, injection: Injection) => {
    injections.set(operation, [...(injections.get(operation) ?? []), injection]);
  };

  /** Records the call, then applies what the test injected for it, if anything. */
  const enter = (operation: Operation, resource: { readonly id: string }) =>
    Effect.gen(function* () {
      calls.push(`${operation} ${resource.id}`);

      const injection = injections.get(operation)?.shift();

      if (injection === undefined) {
        return;
      }

      if (injection.kind === "hold") {
        injection.entered();

        return yield* Effect.promise(() => injection.until);
      }

      return yield* Effect.fail(injection.error);
    });

  /** Like `enter`, and then refuses if the test asked for a refusal. */
  const enterRefusable = (operation: Refusable, resource: { readonly id: string }) =>
    Effect.andThen(
      enter(operation, resource),
      Effect.suspend(() => {
        const refusal = refusals.get(operation)?.shift();

        return refusal === undefined ? Effect.void : Effect.fail(refusal);
      }),
    );

  const observe = (refs: ReadonlyArray<MachineRef>): Effect.Effect<ReadonlyArray<Observed>> =>
    Effect.sync(() => {
      observed.push(refs.map(({ id }) => id));

      return refs.map((machine) => {
        const state = machines.get(machine.name)?.state ?? "missing";

        return machine.port === undefined || publishAddress === undefined
          ? { state }
          : { state, ssh: { host: publishAddress, port: machine.port } };
      });
    });

  /** Where a checkpoint's copy of its machine's root is kept. */
  const checkpointRoot = (checkpoint: CheckpointRef) =>
    join(options.dir, "checkpoints", checkpoint.instance);

  /** Makes `machine` running, on a copy of the root at `from`. */
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
              : checkRamBudget(options.ramBudgetMib, activation, observe),
          ),
        create: (machine) =>
          Effect.andThen(
            enterRefusable("create", machine),
            Effect.promise(async () => {
              // A machine made again under the same name gets a fresh root.
              const root = join(options.dir, "roots", machine.instance);

              await mkdir(join(root, "dev"), { recursive: true });
              machines.set(machine.name, { state: "running", root });
            }),
          ),
        start: (machine) =>
          Effect.andThen(
            enterRefusable("start", machine),
            Effect.sync(() => {
              const found = machines.get(machine.name);

              if (found !== undefined) {
                found.state = "running";
              }
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
        captureKind: (machine) => {
          const state = machines.get(machine.name)?.state;
          const kind = options.checkpointKind ?? "ram";

          if (state === undefined) {
            return Effect.fail(new Precondition({ message: `machine ${machine.id} is missing` }));
          }

          return state === "running" || kind === "disk"
            ? Effect.succeed(kind)
            : Effect.fail(
                new Precondition({ message: `${machine.id} is stopped: start it first` }),
              );
        },
        capture: (machine, checkpoint) =>
          Effect.andThen(
            enterRefusable("capture", checkpoint),
            Effect.flatMap(
              Effect.sync(() => machines.get(machine.name)),
              (found) =>
                found === undefined
                  ? Effect.fail(new Internal({ message: `capture: no machine ${machine.id}` }))
                  : Effect.promise(() =>
                      cp(found.root, checkpointRoot(checkpoint), { recursive: true }),
                    ),
            ),
          ),
        restore: (checkpoint, machine) =>
          Effect.andThen(
            enterRefusable("restore", machine),
            copyInto(checkpointRoot(checkpoint), machine),
          ),
        fork: (source, machine) =>
          Effect.andThen(
            enterRefusable("fork", machine),
            Effect.flatMap(running(source), (found) => copyInto(found.root, machine)),
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
    /** Every runtime call, as `<operation> <machine ID>`, and `startup`. */
    calls,
    /** What each `admit` was asked. */
    activations,
    /** The machine IDs each `observe` read. */
    observed,
    /** The guest root of the machine named `name`, while the fake holds it. */
    root: (name: string) => machines.get(name)?.root,
    /** The fake's machines by name, with their state. */
    machines,
    stubs: () => stubs,
    failNext: (operation: Operation, error: HostError) => {
      inject(operation, { kind: "fail", error });
    },
    refuseNext: (operation: Refusable, refusal: Refusal) => {
      refusals.set(operation, [...(refusals.get(operation) ?? []), refusal]);
    },
    /**
     * Holds the next call of `operation` until `release` is called. `entered` resolves once
     * that call has started, so the action holding it is past its claim.
     */
    holdNext: (operation: Operation) => {
      const until = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();

      inject(operation, { kind: "hold", entered: entered.resolve, until: until.promise });

      return { release: until.resolve, entered: entered.promise };
    },
  };
};

export type FakeRuntime = ReturnType<typeof fakeRuntime>;
