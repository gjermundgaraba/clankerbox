import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type HostError, Internal, type Kind, WrongState } from "@gjermundgaraba/clankerbox-sdk";
import { Deferred, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { allotted, checkRamBudget, inUse } from "../src/usage.ts";
import {
  type Activation,
  type CheckpointRef,
  type Held,
  type MachineRef,
  type MachineState,
  missing,
  type Interface,
  Runtime,
  type RuntimeError,
  type StateError,
} from "../src/runtime.ts";

export type Operation =
  | "admit"
  | "capacity"
  | "create"
  | "start"
  | "stop"
  | "pause"
  | "delete"
  | "exec"
  | "capture"
  | "restore"
  | "fork"
  | "deleteCheckpoint";

export interface FakeOptions {
  readonly dir: string;
  /** `linux` by default, which captures and forks only a running machine. */
  readonly kind?: Kind | undefined;
  readonly ramBudgetMib?: number | undefined;
  /** `fake 1` by default on linux, where a paused machine resumes under it too; mac has none. */
  readonly pin?: string | undefined;
}

export const loginSetup = [
  'mkdir -p "$CLANKERBOX_ROOT/etc"',
  'echo "admin:x:1000:1000::/home/admin:/bin/sh" >>"$CLANKERBOX_ROOT/etc/passwd"',
  "",
].join("\n");

export const furnish = (root: string, stubs: string): void => {
  mkdirSync(join(root, "usr", "local"), { recursive: true });
  symlinkSync(stubs, join(root, "usr", "local", "bin"));
  symlinkSync("/usr/bin", join(root, "usr", "bin"));
  symlinkSync("/bin", join(root, "bin"));
};

export const writeStubs = (dir: string, uname = "Linux"): string => {
  const bin = join(dir, "bin");

  mkdirSync(bin, { recursive: true });

  const stubs: ReadonlyArray<readonly [string, string]> = [
    ["uname", `echo ${uname}`],
    [
      "sudo",
      [
        "user=root",
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        "    -n | -H) shift ;;",
        "    -u) user=$2; shift 2 ;;",
        "    --) shift; break ;;",
        "    *) break ;;",
        "  esac",
        "done",
        'if ! grep -q "^$user:" "$CLANKERBOX_ROOT/etc/passwd" 2>/dev/null; then',
        '  echo "sudo: unknown user $user" >&2',
        "  exit 1",
        "fi",
        'HOME=$CLANKERBOX_ROOT/home/$user exec "$@"',
      ].join("\n"),
    ],
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

export const writeTailscaleStubs = (bin: string): void => {
  mkdirSync(bin, { recursive: true });

  const running = String.raw`{\n  "BackendState": "Running",\n  "Self": {\n    "ID": "n2",\n    "DNSName": "linux-dev.example.ts.net."\n  }\n}\n`;
  const needsLogin = String.raw`{\n  "BackendState": "NeedsLogin",\n  "Self": {\n    "ID": "n1",\n    "DNSName": ""\n  }\n}\n`;

  const stubs: ReadonlyArray<readonly [string, string]> = [
    [
      "tailscaled",
      [
        'echo "tailscaled $*" >>"$CLANKERBOX_ROOT/calls"',
        'env >"$CLANKERBOX_ROOT/tailscaled.env"',
        ': >"$CLANKERBOX_ROOT/daemon"',
      ].join("\n"),
    ],
    [
      "tailscale",
      [
        'case " $* " in',
        '  *" up "*)',
        '    echo "tailscale $*" >>"$CLANKERBOX_ROOT/calls"',
        '    for arg in "$@"; do',
        '      case "$arg" in',
        "        --auth-key=file:*)",
        "          key=${arg#--auth-key=file:}",
        '          cp "$key" "$CLANKERBOX_ROOT/key-seen"',
        '          ls -l "$key" | cut -c1-10 >"$CLANKERBOX_ROOT/key-mode"',
        "          ;;",
        "      esac",
        "    done",
        `    printf '${running}' >"$CLANKERBOX_ROOT/status.json"`,
        "    ;;",
        '  *" status "*)',
        '    [ -e "$CLANKERBOX_ROOT/daemon" ] || exit 1',
        '    if [ -e "$CLANKERBOX_ROOT/status.json" ]; then cat "$CLANKERBOX_ROOT/status.json"; else',
        `      printf '${needsLogin}'`,
        "    fi",
        "    ;;",
        "esac",
      ].join("\n"),
    ],
  ];

  for (const [name, body] of stubs) {
    const file = join(bin, name);

    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
};

interface FakeMachine {
  state: MachineState;
  readonly root: string;
}

type Injection =
  | { readonly kind: "fail"; readonly error: HostError }
  | { readonly kind: "die"; readonly message: string }
  | {
      readonly kind: "hold";
      readonly entered: Deferred.Deferred<void>;
      readonly until: Deferred.Deferred<void>;
      /** As native work does, the call goes on to its end though the caller interrupts it. */
      readonly runsOn: boolean;
    };

/** What `operation` may fail with, as the `Runtime` port types it. */
type FailureOf<O extends Operation> = Interface[O] extends (
  ...args: never
) => Effect.Effect<unknown, infer E, unknown>
  ? E
  : never;

export const fakeRuntime = (options: FakeOptions) => {
  const machines = new Map<string, FakeMachine>();
  const images = new Map<string, string>();
  const calls: Array<string> = [];
  const activations: Array<Activation> = [];
  const observed: Array<ReadonlyArray<string>> = [];
  const injections = new Map<Operation, Array<Injection>>();
  const observeFailures: Array<RuntimeError | "hang" | "die"> = [];

  const observeHolds: Array<{
    readonly entered: Deferred.Deferred<void>;
    readonly until: Deferred.Deferred<void>;
  }> = [];

  const kind = options.kind ?? "linux";
  let stubs: string | undefined;

  const inject = (operation: Operation, injection: Injection) => {
    injections.set(operation, [...(injections.get(operation) ?? []), injection]);
  };

  const call = <O extends Operation, A, E, R>(
    operation: O,
    resource: { readonly id: string },
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | FailureOf<O>, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend((): Effect.Effect<A, E | FailureOf<O>, R> => {
        calls.push(`${operation} ${resource.id}`);

        const injection = injections.get(operation)?.shift();

        if (injection === undefined) {
          return restore(body);
        }

        if (injection.kind === "hold") {
          const held = Effect.andThen(
            Effect.andThen(
              Deferred.succeed(injection.entered, undefined),
              Deferred.await(injection.until),
            ),
            body,
          );

          return injection.runsOn ? held : restore(held);
        }

        if (injection.kind === "die") {
          return Effect.die(new Error(injection.message));
        }

        // SAFETY: `failNext` queues only a `FailureOf<O>` for `O`.
        return Effect.fail(injection.error as FailureOf<O>);
      }),
    );

  const states = (refs: ReadonlyArray<MachineRef>): Effect.Effect<ReadonlyArray<MachineState>> =>
    Effect.sync(() => {
      observed.push(refs.map(({ id }) => id));

      return refs.map((machine) => machines.get(machine.name)?.state ?? "missing");
    });

  const observe = (refs: ReadonlyArray<MachineRef>) =>
    Effect.suspend(() => {
      const held = observeHolds.shift();

      if (held !== undefined) {
        return Effect.tap(states(refs), () =>
          Effect.andThen(Deferred.succeed(held.entered, undefined), Deferred.await(held.until)),
        );
      }

      const failure = observeFailures.shift();

      if (failure === undefined) {
        return states(refs);
      }

      if (failure === "hang") {
        return Effect.never;
      }

      return failure === "die" ? Effect.die(new Error("observe blew up")) : Effect.fail(failure);
    });

  const capacity = (held: ReadonlyArray<Held>) =>
    call(
      "capacity",
      { id: "host" },
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

    if (state === (kind === "mac" ? "stopped" : "running")) {
      return Effect.void;
    }

    return Effect.fail(
      state === "missing"
        ? missing(kind, machine)
        : new WrongState({
            message: `${machine.id} is ${state}: ${kind === "mac" ? "stop" : "start"} it first`,
            machine: machine.id,
            state,
          }),
    );
  };

  const rootOf = (machine: MachineRef) => {
    const found = machines.get(machine.name);

    return found === undefined
      ? Effect.fail(new Internal({ message: `no machine ${machine.id}` }))
      : Effect.succeed(found.root);
  };

  const commands = new Map<string, Set<ChildProcessSpawner.ChildProcessHandle>>();

  const endCommands = (machine: MachineRef) =>
    Effect.forEach(commands.get(machine.name) ?? [], (handle) => Effect.ignore(handle.kill()), {
      discard: true,
    });

  const layer = Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bin = yield* Effect.sync(() => writeStubs(options.dir));

      stubs = bin;

      return Runtime.of({
        version: "fake",
        publishAddress: "127.0.0.1",
        pin: options.pin ?? (kind === "linux" ? "fake 1" : undefined),
        stopResumes: kind === "linux",
        startup: () => Effect.sync(() => calls.push("startup")),
        observe,
        admit: (activation: Activation) =>
          Effect.andThen(
            Effect.sync(() => activations.push(activation)),
            call(
              "admit",
              activation.machine,
              options.ramBudgetMib === undefined
                ? Effect.void
                : checkRamBudget(options.ramBudgetMib, activation, states),
            ),
          ),
        capacity,
        create: (machine, image) =>
          call(
            "create",
            machine,
            Effect.promise(async () => {
              images.set(machine.name, image);
              const root = join(options.dir, "roots", machine.instance);

              await mkdir(join(root, "dev"), { recursive: true });
              furnish(root, bin);
              machines.set(machine.name, { state: "running", root });
            }),
          ),
        start: (machine) =>
          call(
            "start",
            machine,
            Effect.suspend(() => {
              const found = machines.get(machine.name);

              if (found === undefined) {
                return Effect.fail(missing(kind, machine));
              }

              found.state = "running";

              return Effect.void;
            }),
          ),
        stop: (machine) =>
          call(
            "stop",
            machine,
            Effect.andThen(
              endCommands(machine),
              Effect.sync(() => {
                const found = machines.get(machine.name);

                if (found !== undefined) {
                  found.state = "stopped";
                }
              }),
            ),
          ),
        pause: (machine) =>
          call(
            "pause",
            machine,
            Effect.suspend((): Effect.Effect<void, StateError> => {
              const found = machines.get(machine.name);

              if (found === undefined) {
                return Effect.fail(missing(kind, machine));
              }

              if (found.state === "stopped") {
                return Effect.fail(
                  new WrongState({
                    message: `${machine.id} is stopped: start it first`,
                    machine: machine.id,
                    state: found.state,
                  }),
                );
              }

              found.state = "paused";

              return Effect.void;
            }),
          ),
        delete: (machine) =>
          call(
            "delete",
            machine,
            Effect.andThen(
              endCommands(machine),
              Effect.sync(() => {
                machines.delete(machine.name);
              }),
            ),
          ),
        capture: (machine, checkpoint) =>
          call(
            "capture",
            checkpoint,
            Effect.andThen(
              copyable(machine),
              Effect.flatMap(rootOf(machine), (root) =>
                Effect.promise(() => cp(root, checkpointRoot(checkpoint), { recursive: true })),
              ),
            ),
          ),
        restore: (checkpoint, machine) =>
          call("restore", machine, copyInto(checkpointRoot(checkpoint), machine)),
        fork: (source, machine) =>
          call(
            "fork",
            machine,
            Effect.andThen(
              copyable(source),
              Effect.flatMap(rootOf(source), (root) => copyInto(root, machine)),
            ),
          ),
        deleteCheckpoint: (checkpoint) =>
          call(
            "deleteCheckpoint",
            checkpoint,
            Effect.promise(() => rm(checkpointRoot(checkpoint), { recursive: true, force: true })),
          ),
        exec: (machine, command) =>
          call(
            "exec",
            machine,
            Effect.gen(function* () {
              const found = machines.get(machine.name);

              if (found?.state !== "running") {
                return {
                  output: Stream.make(
                    new TextEncoder().encode(`exec: ${machine.id} isn't running\n`),
                  ),
                  exitCode: Effect.succeed(1),
                };
              }

              const { root } = found;
              const [file = "/bin/sh", ...args] = command.argv;

              const handle = yield* spawner
                .spawn(
                  ChildProcess.make(file, args, {
                    env: {
                      CLANKERBOX_ROOT: root,
                      CLANKERBOX_USER: command.user ?? "root",
                      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
                    },
                    extendEnv: true,
                    killSignal: "SIGKILL",
                    stdin:
                      command.stdin === undefined
                        ? "ignore"
                        : Stream.make(Uint8Array.from(command.stdin)),
                  }),
                )
                .pipe(Effect.mapError((error) => new Internal({ message: error.message })));

              const running = commands.get(machine.name) ?? new Set();

              commands.set(machine.name, running.add(handle));
              yield* Effect.addFinalizer(() => Effect.sync(() => running.delete(handle)));

              return {
                output: Stream.mapError(
                  handle.all,
                  (error) => new Internal({ message: error.message }),
                ),
                exitCode: Effect.orElseSucceed(handle.exitCode, () => 137),
              };
            }),
          ),
      });
    }),
  );

  return {
    layer,
    calls,
    activations,
    observed,
    root: (name: string) => machines.get(name)?.root,
    images,
    machines,
    stubs: () => stubs,
    failNext: <O extends Operation>(operation: O, error: FailureOf<O>) => {
      // SAFETY: every port method fails with host errors.
      inject(operation, { kind: "fail", error: error as HostError });
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
    dieNextObserve: () => {
      observeFailures.push("die");
    },
    holdNextObserve: () => {
      const until = Deferred.makeUnsafe<void>();
      const entered = Deferred.makeUnsafe<void>();

      observeHolds.push({ entered, until });

      return { release: Deferred.succeed(until, undefined), entered: Deferred.await(entered) };
    },
    holdNext: (operation: Operation, options?: { readonly runsOn?: boolean }) => {
      const until = Deferred.makeUnsafe<void>();
      const entered = Deferred.makeUnsafe<void>();

      inject(operation, { kind: "hold", entered, until, runsOn: options?.runsOn ?? false });

      return { release: Deferred.succeed(until, undefined), entered: Deferred.await(entered) };
    },
  };
};

export type FakeRuntime = ReturnType<typeof fakeRuntime>;
