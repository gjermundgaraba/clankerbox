/**
 * A fake runtime for unit tests. Its machines live in memory, and each has a guest root: a
 * temporary directory that its commands see as `/` through `CLANKERBOX_ROOT`. Commands run with
 * the host's own `/bin/sh`, so setup and preparation run for real, with `perl`, `ssh-keygen` and
 * `uname` stubbed. Tests can fail, refuse or hold any runtime call.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { checkRamBudget } from "../src/ram-budget.ts";
import {
  type Activation,
  type MachineRef,
  type MachineState,
  type Observed,
  type Refusal,
  Runtime,
} from "../src/runtime.ts";

/** The runtime calls a test can fail, refuse or hold. */
export type Operation = "admit" | "create" | "start" | "stop" | "delete" | "exec";

export interface FakeOptions {
  /** Where machines' guest roots and the command stubs go. */
  readonly dir: string;
  /** `undefined` gives machines no host port. Default: 127.0.0.1. */
  readonly publishAddress?: string | undefined;
  /** When set, `admit` checks the RAM budget like smolvm. */
  readonly ramBudgetMib?: number | undefined;
  /** What the stubbed `uname -s` says. Default: Linux. */
  readonly uname?: string | undefined;
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
  | { readonly kind: "hold"; readonly until: Promise<void> };

/** The calls a runtime can refuse. */
type Refusable = "create" | "start";

/** The native name, as smolvm would make it. */
const nativeName = (machine: MachineRef) => `${machine.name}-${machine.instance.slice(0, 8)}`;

export const fakeRuntime = (options: FakeOptions) => {
  const machines = new Map<string, FakeMachine>();
  const calls: Array<string> = [];
  const injections = new Map<Operation, Array<Injection>>();
  const refusals = new Map<Refusable, Array<Refusal>>();
  const publishAddress = "publishAddress" in options ? options.publishAddress : "127.0.0.1";
  let stubs: string | undefined;

  const inject = (operation: Operation, injection: Injection) => {
    injections.set(operation, [...(injections.get(operation) ?? []), injection]);
  };

  /** Records the call, then applies what the test injected for it, if anything. */
  const enter = (operation: Operation, machine: MachineRef) =>
    Effect.gen(function* () {
      calls.push(`${operation} ${machine.id}`);

      const injection = injections.get(operation)?.shift();

      if (injection === undefined) {
        return;
      }

      if (injection.kind === "hold") {
        return yield* Effect.promise(() => injection.until);
      }

      return yield* Effect.fail(injection.error);
    });

  /** Like `enter`, and then refuses if the test asked for a refusal. */
  const enterRefusable = (operation: Refusable, machine: MachineRef) =>
    Effect.andThen(
      enter(operation, machine),
      Effect.suspend(() => {
        const refusal = refusals.get(operation)?.shift();

        return refusal === undefined ? Effect.void : Effect.fail(refusal);
      }),
    );

  const observe = (machine: MachineRef): Effect.Effect<Observed> =>
    Effect.sync(() => {
      const state = machines.get(nativeName(machine))?.state ?? "missing";

      return machine.port === undefined || publishAddress === undefined
        ? { state }
        : { state, ssh: { host: publishAddress, port: machine.port } };
    });

  const running = (machine: MachineRef) => {
    const found = machines.get(nativeName(machine));

    return found?.state === "running"
      ? Effect.succeed(found)
      : Effect.fail(new Internal({ message: `exec: ${machine.id} isn't running` }));
  };

  const layer = Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bin = yield* Effect.sync(() => writeStubs(options.dir, options.uname));

      stubs = bin;

      return Runtime.of({
        name: "smolvm",
        version: "fake",
        publishAddress,
        startup: Effect.sync(() => calls.push("startup")),
        observe,
        admit: (activation: Activation) =>
          Effect.andThen(
            enter("admit", activation.machine),
            options.ramBudgetMib === undefined
              ? Effect.void
              : checkRamBudget(options.ramBudgetMib, activation, observe),
          ),
        create: (machine) =>
          Effect.andThen(
            enterRefusable("create", machine),
            Effect.promise(async () => {
              const root = join(options.dir, "roots", nativeName(machine));

              await mkdir(join(root, "dev"), { recursive: true });
              machines.set(nativeName(machine), { state: "running", root });
            }),
          ),
        start: (machine) =>
          Effect.andThen(
            enterRefusable("start", machine),
            Effect.sync(() => {
              const found = machines.get(nativeName(machine));

              if (found !== undefined) {
                found.state = "running";
              }
            }),
          ),
        stop: (machine) =>
          Effect.andThen(
            enter("stop", machine),
            Effect.sync(() => {
              const found = machines.get(nativeName(machine));

              if (found !== undefined) {
                found.state = "stopped";
              }
            }),
          ),
        delete: (machine) =>
          Effect.andThen(
            enter("delete", machine),
            Effect.sync(() => {
              machines.delete(nativeName(machine));
            }),
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
    /** The guest root of the machine named `name`, while the fake holds it. */
    root: (name: string) =>
      [...machines].find(([native]) => native.slice(0, -9) === name)?.[1].root,
    /** The fake's machines by native name, with their state. */
    machines,
    stubs: () => stubs,
    failNext: (operation: Operation, error: HostError) => {
      inject(operation, { kind: "fail", error });
    },
    refuseNext: (operation: Refusable, refusal: Refusal) => {
      refusals.set(operation, [...(refusals.get(operation) ?? []), refusal]);
    },
    /** Holds the next call of `operation` until the returned function is called. */
    holdNext: (operation: Operation) => {
      let release: () => void = () => {};

      const until = new Promise<void>((resolve) => {
        release = resolve;
      });

      inject(operation, { kind: "hold", until });

      return release;
    },
  };
};

export type FakeRuntime = ReturnType<typeof fakeRuntime>;
