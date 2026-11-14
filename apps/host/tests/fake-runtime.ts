import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  Capacity,
  Internal,
  RuntimeName,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  RuntimeTraits,
  Sizing,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import { Deferred, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { traits as smolvm } from "../src/platform/smolvm/traits.ts";
import { traits as tart } from "../src/platform/tart/traits.ts";
import { Handle, missing, Runtime, sizedBy } from "../src/runtime.ts";
import type {
  Activation,
  Admission,
  CheckpointFiles,
  Held,
  Identity,
  MachineState,
  Made,
  Marked,
  MarkedMachine,
  Observed,
  Interface,
  RuntimeError,
  Sizes,
  StateError,
  Target,
} from "../src/runtime.ts";
import { allotted, checkRamBudget, inUse } from "../src/usage.ts";
import { lateLandings } from "./late-landing.ts";
import type { Dropped, Faults } from "./runtime-contract.ts";

export type Operation =
  | "admit"
  | "capacity"
  | "create"
  | "start"
  | "stop"
  | "pause"
  | "resize"
  | "sizes"
  | "delete"
  | "exec"
  | "capture"
  | "restore"
  | "fork"
  | "deleteCheckpoint"
  | "install";

export interface Preset {
  readonly traits: RuntimeTraits;
  readonly guest: Interface["guest"];
  readonly pin: string | undefined;
  readonly prepares: Interface["prepares"];
  readonly admits: boolean;
  readonly files: { readonly keyed: boolean } | undefined;
  readonly owned: { readonly checkpoints: "held" | "marked" } | undefined;
}

export const fixed: RuntimeTraits = {
  runtime: RuntimeName.make("fixed"),
  images: "named",
  checkpoint: "disk",
  captureFrom: "stopped",
  pause: "stops",
  stop: "discards",
  copies: "any",
  resize: { running: "none", stopped: "any" },
  sizes: {
    _tag: "classes",
    classes: [
      { name: "small", cpu: 1, ramMib: 1024, diskGib: 10 },
      { name: "default", cpu: 2, ramMib: 4096, diskGib: 20 },
      { name: "large", cpu: 4, ramMib: 8192, diskGib: 40 },
    ],
  },
  stopsOnItsOwn: true,
};

export const presets = {
  smolvm: {
    traits: smolvm,
    guest: "debian",
    pin: "fake 1",
    prepares: "with-setup",
    admits: true,
    files: { keyed: true },
    owned: undefined,
  },
  tart: {
    traits: tart,
    guest: "macos",
    pin: undefined,
    prepares: "with-setup",
    admits: true,
    files: { keyed: false },
    owned: undefined,
  },
  fixed: {
    traits: fixed,
    guest: "debian",
    pin: undefined,
    prepares: "always",
    admits: false,
    files: undefined,
    owned: { checkpoints: "held" },
  },
} as const satisfies Record<string, Preset>;

export type FakeRuntimeName = keyof typeof presets;

export interface FakeOptions {
  readonly dir: string;
  readonly as?: FakeRuntimeName | undefined;
  readonly traits?: RuntimeTraits | undefined;
  readonly owned?: Preset["owned"];
  readonly ramBudgetMib?: number | undefined;
  readonly pin?: string | undefined;
  readonly relayed?: boolean | undefined;
  readonly onCall?: ((call: string) => void) | undefined;
}

export const hostKeySetup = "ssh-keygen -A\n";

const macLogin = "admin:x:501:20::/Users/admin:/bin/zsh\n";

const guestTools = [
  "awk",
  "cat",
  "chmod",
  "cp",
  "cut",
  "env",
  "grep",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "nohup",
  "od",
  "rm",
  "setsid",
  "sh",
  "sleep",
  "tr",
];

const hostTool = (tool: string): string | undefined =>
  ["/usr/bin", "/bin"]
    .map((dir) => path.join(dir, tool))
    .find((file) => existsSync(file));

export const furnish = (root: string, stubs: string): void => {
  const bin = path.join(root, "usr", "bin");

  mkdirSync(path.join(root, "usr", "local"), { recursive: true });
  mkdirSync(path.join(root, "dev", "shm"), { recursive: true });
  mkdirSync(path.join(root, "var", "tmp"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  symlinkSync(stubs, path.join(root, "usr", "local", "bin"));
  symlinkSync(bin, path.join(root, "bin"));

  for (const tool of guestTools) {
    const file = hostTool(tool);

    if (file !== undefined) {
      symlinkSync(file, path.join(bin, tool));
    }
  }
};

export const writeStubs = (dir: string, uname = "Linux"): string => {
  const bin = path.join(dir, "bin");

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
    ["mountpoint", 'grep -qxF -e "$2" "$CLANKERBOX_ROOT/mounted" 2>/dev/null'],
    [
      "mount",
      [
        'echo "$3" >>"$CLANKERBOX_ROOT/mounted"',
        'echo "mount $*" >>"$CLANKERBOX_ROOT/mounts"',
      ].join("\n"),
    ],
    ["perl", `echo "perl $3" >>"$CLANKERBOX_ROOT/calls"`],
    ["apt-get", `echo "apt-get $*" >>"$CLANKERBOX_ROOT/calls"`],
    [
      "useradd",
      [
        `echo "useradd $*" >>"$CLANKERBOX_ROOT/calls"`,
        "for user do :; done",
        'mkdir -p "$CLANKERBOX_ROOT/etc" "$CLANKERBOX_ROOT/home/$user"',
        'echo "$user:x:1000:1000::/home/$user:/bin/sh" >>"$CLANKERBOX_ROOT/etc/passwd"',
      ].join("\n"),
    ],
    [
      "networksetup",
      [
        `echo "networksetup $*" >>"$CLANKERBOX_ROOT/calls"`,
        'if [ "$1" = -listallnetworkservices ]; then',
        "  echo 'An asterisk (*) denotes that a network service is disabled.'",
        "  echo Ethernet",
        "fi",
      ].join("\n"),
    ],
    ["systemsetup", `echo "systemsetup $*" >>"$CLANKERBOX_ROOT/calls"`],
    ["sntp", "echo '+0.000123 +/- 0.010000 time.apple.com 17.253.4.125'"],
    ["brew", `echo "brew $*" >>"$CLANKERBOX_ROOT/calls"`],
    [
      "systemctl",
      [
        'if [ "$1" = cat ]; then [ -e "$CLANKERBOX_ROOT/lib/systemd/system/$2" ]; exit; fi',
        'echo "systemctl $*" >>"$CLANKERBOX_ROOT/calls"',
      ].join("\n"),
    ],
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
    const file = path.join(bin, name);

    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }

  return bin;
};

export const baseResolver = "192.168.64.1";

export const tailnetResolver = "100.100.100.100";

export const writeTailscaleStubs = (bin: string): void => {
  mkdirSync(bin, { recursive: true });

  const running = String.raw`{\n  "BackendState": "Running",\n  "Self": {\n    "ID": "n2",\n    "DNSName": "linux-dev.example.ts.net.",\n    "Online": true\n  }\n}\n`;
  const offline = String.raw`{\n  "BackendState": "Running",\n  "Self": {\n    "ID": "n2",\n    "DNSName": "linux-dev.example.ts.net.",\n    "Online": false\n  }\n}\n`;
  const needsLogin = String.raw`{\n  "BackendState": "NeedsLogin",\n  "Self": {\n    "ID": "n1",\n    "DNSName": ""\n  }\n}\n`;

  const stubs: ReadonlyArray<readonly [string, string]> = [
    [
      "tailscaled",
      [
        'echo "tailscaled $*" >>"$CLANKERBOX_ROOT/calls"',
        'env >"$CLANKERBOX_ROOT/tailscaled.env"',
        ': >"$CLANKERBOX_ROOT/daemon"',
        'mkdir -p "$CLANKERBOX_ROOT/proc/$$"',
        'echo tailscaled >"$CLANKERBOX_ROOT/proc/$$/comm"',
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
        '    rm -f "$CLANKERBOX_ROOT/node-removed"',
        '    mkdir -p "$CLANKERBOX_ROOT/etc"',
        `    echo 'nameserver ${tailnetResolver}' >"$CLANKERBOX_ROOT/etc/resolv.conf"`,
        "    ;;",
        '  *" logout "*)',
        '    echo "tailscale $*" >>"$CLANKERBOX_ROOT/calls"',
        '    rm -f "$CLANKERBOX_ROOT/status.json"',
        "    ;;",
        '  *" set "*)',
        '    echo "tailscale $*" >>"$CLANKERBOX_ROOT/calls"',
        "    ;;",
        '  *" status "*)',
        '    if [ ! -e "$CLANKERBOX_ROOT/daemon" ]; then',
        '      cat "$CLANKERBOX_ROOT/var/lib/clankerbox/tailscale/tailscaled.pid" 2>/dev/null >>"$CLANKERBOX_ROOT/refused" || echo none >>"$CLANKERBOX_ROOT/refused"',
        "      exit 1",
        "    fi",
        '    if [ ! -e "$CLANKERBOX_ROOT/status.json" ]; then',
        `      printf '${needsLogin}'`,
        '    elif [ -e "$CLANKERBOX_ROOT/node-removed" ] && [ -e "$CLANKERBOX_ROOT/var/lib/clankerbox/tailscale/state/tailscaled.state" ]; then',
        `      echo 'Received error: PollNetMap: initial fetch failed 404: node not found' >>"$CLANKERBOX_ROOT/var/lib/clankerbox/tailscale/tailscaled.log"`,
        `      printf '${offline}'`,
        '    elif [ -e "$CLANKERBOX_ROOT/control-unreachable" ]; then',
        `      printf '${offline}'`,
        "    else",
        '      cat "$CLANKERBOX_ROOT/status.json"',
        "    fi",
        "    ;;",
        "esac",
      ].join("\n"),
    ],
  ];

  for (const [name, body] of stubs) {
    const file = path.join(bin, name);

    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
};

interface FakeMachine {
  state: MachineState;
  sizes: Sizing;
  readonly name: string;
  readonly root: string;
  readonly instance: string;
  readonly handle: Handle;
  readonly marked: boolean;
}

interface FakeCheckpoint {
  readonly name: string;
  readonly instance: string;
  readonly marked: boolean;
  readonly of: Handle | undefined;
}

const minted = (prefix: string): Handle =>
  Handle.make(`${prefix}-${randomUUID().slice(0, 13)}`);

const sizesOf = ({ cpu, ramMib, diskGib }: Sizes): Sizes => ({
  cpu,
  ramMib,
  diskGib,
});

type Injection<O extends Operation> =
  | { readonly kind: "fail"; readonly error: FailureOf<O> }
  | { readonly kind: "die"; readonly message: string }
  | {
      readonly kind: "hold";
      readonly entered: Deferred.Deferred<undefined>;
      readonly until: Deferred.Deferred<undefined>;
      readonly runsOn: boolean;
    };

type Injections = { readonly [O in Operation]: Array<Injection<O>> };

type Calls = Omit<Interface, "admission" | "files"> &
  Admission &
  CheckpointFiles &
  Record<"create" | "restore" | "fork", Interface["make"]>;

type FailureOf<O extends Operation> = Calls[O] extends (
  ...args: never
) => Effect.Effect<unknown, infer E, unknown>
  ? E
  : never;

const keyOf = async (file: string) => {
  const bytes = await readFile(file);

  return `fake/${createHash("sha256").update(bytes).digest("hex")}`;
};

const filesIn = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await filesIn(file)));
    } else if (entry.isFile()) {
      found.push(file);
    }
  }

  return found;
};

const uninterruptibleWrite = <A>(write: () => Promise<A>) =>
  Effect.uninterruptible(Effect.promise(write));

const unknownOutcome = (what: string) =>
  new Internal({
    message: `the provider's answer to ${what} was lost, and nothing it holds tells the outcome`,
  });

class ByName {
  readonly #held: Map<Handle, FakeMachine>;

  constructor(held: Map<Handle, FakeMachine>) {
    this.#held = held;
  }

  get size(): number {
    return this.#held.size;
  }

  get(name: string): FakeMachine | undefined {
    return this.#held
      .values()
      .toArray()
      .findLast((machine) => machine.name === name);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  keys(): IterableIterator<string> {
    return this.#held.values().map(({ name }) => name);
  }

  values(): IterableIterator<FakeMachine> {
    return this.#held.values();
  }

  clear(): void {
    this.#held.clear();
  }
}

export const fakeRuntime = (options: FakeOptions) => {
  const machines = new Map<Handle, FakeMachine>();
  const images = new Map<string, string>();
  const calls: string[] = [];
  const activations: Activation[] = [];
  const observed: Array<readonly string[]> = [];

  const injections: Injections = {
    admit: [],
    capacity: [],
    create: [],
    start: [],
    stop: [],
    pause: [],
    resize: [],
    sizes: [],
    delete: [],
    exec: [],
    capture: [],
    restore: [],
    fork: [],
    deleteCheckpoint: [],
    install: [],
  };

  const observeFailures: Array<RuntimeError | "hang" | "die"> = [];
  const findFailures = new Map<string, RuntimeError>();
  const searches: string[] = [];
  const partialResizes: RuntimeError[] = [];
  const sizableRefusals: Unsizable[] = [];
  const sized: Array<readonly [string, Sizes, Sizes, boolean]> = [];
  const removals: Array<readonly [string, ReadonlySet<Handle>]> = [];
  const starts: Array<readonly [string, ReadonlySet<Handle>]> = [];

  const observeHolds: Array<{
    readonly entered: Deferred.Deferred<undefined>;
    readonly until: Deferred.Deferred<undefined>;
  }> = [];

  const preset: Preset = presets[options.as ?? "smolvm"];
  const traits = options.traits ?? preset.traits;
  const owned = options.owned ?? preset.owned;
  const lateMakes = lateLandings();
  const dropped = new Set<Dropped>();
  let quotaOn = false;
  let pin = options.pin ?? preset.pin;

  const record = (entry: string) => {
    calls.push(entry);
    options.onCall?.(entry);
  };

  let stubs: string | undefined;

  const inject = <O extends Operation>(
    operation: O,
    injection: Injection<O>
  ) => {
    injections[operation].push(injection);
  };

  const call = <O extends Operation, A, E, R>(
    operation: O,
    resource: { readonly name: string },
    body: Effect.Effect<A, E, R>,
    leftByFailure?: () => void
  ): Effect.Effect<A, E | FailureOf<O>, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend((): Effect.Effect<A, E | FailureOf<O>, R> => {
        record(`${operation} ${resource.name}`);

        const injection = injections[operation].shift();

        if (injection === undefined) {
          return restore(body);
        }

        if (injection.kind === "hold") {
          const held = Effect.andThen(
            Effect.andThen(
              Deferred.succeed(injection.entered, undefined),
              Deferred.await(injection.until)
            ),
            body
          );

          return injection.runsOn ? held : restore(held);
        }

        if (injection.kind === "die") {
          return Effect.die(new Error(injection.message));
        }

        leftByFailure?.();

        return Effect.fail(injection.error);
      })
    );

  const machineOf = (target: Target): FakeMachine | undefined =>
    machines.get(target.handle);

  const checkpoints = new Map<Handle, FakeCheckpoint>();

  const kept = (
    what: Parameters<Interface["find"]>[0],
    ref: Identity
  ): Handle | undefined => {
    if (what === "checkpoint") {
      return owned?.checkpoints === "held"
        ? undefined
        : [...checkpoints].find(
            ([, held]) =>
              held.name === ref.name && held.instance === ref.instance
          )?.[0];
    }

    return machines
      .values()
      .find((held) => held.name === ref.name && held.instance === ref.instance)
      ?.handle;
  };

  const checkpointRoot = ({ instance }: Identity) =>
    path.join(options.dir, "checkpoints", instance);

  const heldBy = (machine: Handle) =>
    owned?.checkpoints === "held"
      ? [...checkpoints].filter(([, held]) => held.of === machine)
      : [];

  const pruned = async (machine: Handle, keep: ReadonlySet<Handle>) => {
    for (const [handle, held] of heldBy(machine)) {
      if (!keep.has(handle)) {
        checkpoints.delete(handle);
        await rm(checkpointRoot(held), { recursive: true, force: true });
      }
    }
  };

  const heldCheckpoint = (checkpoint: Target) => {
    const held = checkpoints.get(checkpoint.handle);

    return held === undefined
      ? path.join(options.dir, "checkpoints", `none-${checkpoint.handle}`)
      : checkpointRoot(held);
  };

  const keptCheckpoint = (
    checkpoint: Identity,
    of: Handle | undefined
  ): Handle => {
    const handle = minted("ckpt");

    checkpoints.set(handle, {
      name: checkpoint.name,
      instance: checkpoint.instance,
      marked: true,
      of,
    });

    return handle;
  };

  const madeOf = (
    machine: Identity & Sizes,
    root: string,
    state: MachineState = "running"
  ): Made => {
    const handle = minted("mach");

    machines.set(handle, {
      state,
      sizes: sizesOf(machine),
      name: machine.name,
      root,
      instance: machine.instance,
      handle,
      marked: true,
    });

    return { handle, sizes: sizesOf(machine) };
  };

  const leftOf = (machine: Identity & Sizes) => () => {
    madeOf(
      machine,
      path.join(options.dir, "roots", machine.instance),
      "stopped"
    );
  };

  const landed = (machine: Identity & Sizes, image: string) => {
    const root = path.join(options.dir, "roots", machine.instance);

    mkdirSync(path.join(root, "etc"), { recursive: true });
    madeOf(machine, root);
    images.set(machine.name, image);
    record(`landed ${machine.name}`);
  };

  const lost = <A, E, E2>(
    dropping: Dropped,
    work: Effect.Effect<A, E>,
    reread: Effect.Effect<A, E2>
  ): Effect.Effect<A, E | E2> =>
    Effect.suspend(() => {
      if (!dropped.delete(dropping)) {
        return work;
      }

      return Effect.andThen(
        work,
        Effect.andThen(
          Effect.sync(() => {
            record(`lost the answer of ${dropping}`);
          }),
          reread
        )
      );
    });

  const states = (refs: readonly Target[]): Effect.Effect<Observed> =>
    Effect.sync(() => {
      observed.push(refs.map(({ name }) => name));

      return new Map(
        refs.map((machine) => [
          machine.name,
          machineOf(machine)?.state ?? "missing",
        ])
      );
    });

  const observe = (refs: readonly Target[]) =>
    Effect.suspend(() => {
      const held = observeHolds.shift();

      if (held !== undefined) {
        return Effect.tap(states(refs), () =>
          Effect.andThen(
            Deferred.succeed(held.entered, undefined),
            Deferred.await(held.until)
          )
        );
      }

      const failure = observeFailures.shift();

      if (failure === undefined) {
        return states(refs);
      }

      if (failure === "hang") {
        return Effect.never;
      }

      return failure === "die"
        ? Effect.die(new Error("observe blew up"))
        : Effect.fail(failure);
    });

  const capacity = (held: readonly Held[]) =>
    call(
      "capacity",
      { name: "host" },
      Effect.map(inUse(held, states), ({ running, unread }) =>
        allotted(running, unread, options.ramBudgetMib)
      )
    );

  const copyInto = (from: string, machine: Identity & Sizes) =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: async () => {
          const root = path.join(options.dir, "roots", machine.instance);

          await access(from);
          await cp(from, root, { recursive: true });

          return madeOf(machine, root);
        },
        catch: (cause) =>
          new Internal({
            message: `copy into ${machine.name}: ${String(cause)}`,
          }),
      })
    );

  const copyable = (machine: Target) => {
    const state = machineOf(machine)?.state ?? "missing";

    if (state === traits.captureFrom) {
      return Effect.void;
    }

    return Effect.fail(
      state === "missing"
        ? missing(traits.runtime, machine)
        : new WrongState({
            message: `${machine.name} is ${state}: ${traits.captureFrom === "stopped" ? "stop" : "start"} it first`,
            machine: machine.name,
            state,
          })
    );
  };

  const rootOf = (machine: Target) => {
    const found = machineOf(machine);

    return found === undefined
      ? Effect.fail(new Internal({ message: `no machine ${machine.name}` }))
      : Effect.succeed(found.root);
  };

  const commands = new Map<
    string,
    Set<ChildProcessSpawner.ChildProcessHandle>
  >();

  const endCommands = (machine: Target) =>
    Effect.forEach(
      commands.get(machine.name) ?? [],
      (handle) => Effect.ignore(handle.kill()),
      {
        discard: true,
      }
    );

  const madeAgain = (machine: Identity & Sizes, what: string) =>
    Effect.suspend(() => {
      const handle = kept("machine", machine);
      const held = handle === undefined ? undefined : machines.get(handle);

      return held === undefined
        ? Effect.fail(unknownOutcome(what))
        : Effect.succeed<Made>({
            handle: held.handle,
            sizes: sizedBy(machine, held.sizes),
          });
    });

  const layer = Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bin = yield* Effect.sync(() => writeStubs(options.dir));

      stubs = bin;

      const room = Effect.suspend(() =>
        quotaOn
          ? Effect.fail(
              new Capacity({
                message: `the ${traits.runtime} provider's quota is spent`,
              })
            )
          : Effect.void
      );

      const created = (machine: Identity & Sizes, image: string) =>
        call(
          "create",
          machine,
          Effect.andThen(
            room,
            lost(
              "make",
              uninterruptibleWrite(async () => {
                images.set(machine.name, image);
                const root = path.join(options.dir, "roots", machine.instance);

                await mkdir(path.join(root, "dev"), { recursive: true });
                await mkdir(path.join(root, "etc"), { recursive: true });
                await writeFile(
                  path.join(root, "etc", "resolv.conf"),
                  `nameserver ${baseResolver}\n`
                );
                furnish(root, bin);

                if (preset.guest === "macos") {
                  await writeFile(path.join(root, "etc", "passwd"), macLogin);
                }

                return madeOf(machine, root);
              }),
              madeAgain(machine, `create ${machine.name}`)
            )
          ),
          leftOf(machine)
        );

      return Runtime.of({
        version: "fake",
        get pin() {
          return pin;
        },
        prepares: preset.prepares,
        reach:
          options.relayed === true
            ? {
                _tag: "relayed",
                address: "127.0.0.1",
                dial: (machine) => {
                  record(`relay ${machine.name}`);

                  return (input) => input;
                },
              }
            : { _tag: "published", address: "127.0.0.1" },
        admission: preset.admits
          ? {
              admit: (activation: Activation) =>
                Effect.andThen(
                  Effect.sync(() => activations.push(activation)),
                  call(
                    "admit",
                    activation.machine,
                    options.ramBudgetMib === undefined
                      ? Effect.void
                      : checkRamBudget(
                          options.ramBudgetMib,
                          activation,
                          states,
                          0
                        )
                  )
                ),
            }
          : undefined,
        owned:
          owned === undefined
            ? undefined
            : {
                machines: Effect.sync(() => {
                  record("marked machines");

                  return machines
                    .values()
                    .filter(({ marked }) => marked)
                    .map((machine): MarkedMachine => ({
                      instance: machine.instance,
                      handle: machine.handle,
                      checkpoints: heldBy(machine.handle).map(
                        ([handle]) => handle
                      ),
                    }))
                    .toArray();
                }),
                checkpoints: Effect.sync(() =>
                  owned.checkpoints === "held"
                    ? []
                    : checkpoints
                        .entries()
                        .filter(([, { marked }]) => marked)
                        .map(([handle, held]): Marked => ({
                          instance: held.instance,
                          handle,
                        }))
                        .toArray()
                ),
              },
        files:
          preset.files === undefined
            ? undefined
            : {
                checkpointFiles: (checkpoint) =>
                  Effect.promise(async () => {
                    const root = heldCheckpoint(checkpoint);
                    const found = await filesIn(root);

                    return await Promise.all(
                      found.map(async (file) => ({
                        path: path.relative(root, file),
                        file,
                        ...(preset.files?.keyed === true
                          ? { key: await keyOf(file) }
                          : {}),
                      }))
                    );
                  }),
                held: (key) =>
                  Effect.promise(async () => {
                    const all = path.join(options.dir, "checkpoints");

                    for (const file of existsSync(all)
                      ? await filesIn(all)
                      : []) {
                      if (
                        !file.includes(".fetching") &&
                        (await keyOf(file)) === key
                      ) {
                        return file;
                      }
                    }

                    return undefined;
                  }),
                staging: (checkpoint) =>
                  `${checkpointRoot(checkpoint)}.fetching`,
                install: (checkpoint, staged) =>
                  call(
                    "install",
                    checkpoint,
                    uninterruptibleWrite(async () => {
                      const root = checkpointRoot(checkpoint);

                      await rename(staged, root);
                      await mkdir(path.join(root, "dev"), { recursive: true });
                      furnish(root, bin);

                      return keptCheckpoint(checkpoint, undefined);
                    })
                  ),
              },
        traits,
        guest: preset.guest,
        sizable: (machine, from, to, live) => {
          sized.push([machine.name, sizesOf(from), sizesOf(to), live]);

          const refusal = sizableRefusals.shift();

          return refusal === undefined ? Effect.void : Effect.fail(refusal);
        },
        startup: Effect.sync(() => {
          record("startup");
        }),
        find: (what, ref) =>
          Effect.suspend(() => {
            searches.push(`${what} ${ref.name}`);
            options.onCall?.(`find ${what} ${ref.name}`);
            const failure = findFailures.get(ref.name);

            return failure === undefined
              ? Effect.succeed(kept(what, ref))
              : Effect.fail(failure);
          }),
        observe,
        capacity,
        make: (machine, origin, bind) => {
          if ((options.relayed === true) !== (bind._tag === "none")) {
            return Effect.die(
              new Error(
                `make ${machine.name}: a ${options.relayed === true ? "relayed" : "published"} reach was given a ${bind._tag} bind`
              )
            );
          }

          const held = lateMakes.next();

          if (held !== undefined) {
            return Effect.andThen(
              Effect.promise(async () => {
                record(`make ${machine.name}`);
                await held(() => {
                  landed(machine, origin._tag === "image" ? origin.image : "");
                });
              }),
              Effect.fail(
                new Internal({
                  message: `the ${traits.runtime} provider didn't answer the make of ${machine.name}`,
                })
              )
            );
          }

          switch (origin._tag) {
            case "image": {
              return created(machine, origin.image);
            }

            case "checkpoint": {
              return call(
                "restore",
                machine,
                Effect.andThen(
                  room,
                  lost(
                    "make",
                    copyInto(heldCheckpoint(origin.checkpoint), machine),
                    madeAgain(machine, `restore ${machine.name}`)
                  )
                ),
                leftOf(machine)
              );
            }

            case "machine": {
              const source = origin.machine;

              return call(
                "fork",
                machine,
                Effect.andThen(
                  room,
                  Effect.andThen(
                    copyable(source),
                    Effect.flatMap(rootOf(source), (root) =>
                      lost(
                        "make",
                        copyInto(root, machine),
                        madeAgain(machine, `fork ${machine.name}`)
                      )
                    )
                  )
                ),
                leftOf(machine)
              );
            }
          }
        },
        start: (machine, keep) =>
          Effect.andThen(
            Effect.sync(() => starts.push([machine.name, keep])),
            call(
              "start",
              machine,
              Effect.suspend(() => {
                const found = machineOf(machine);

                if (found === undefined) {
                  return Effect.fail(missing(traits.runtime, machine));
                }

                found.state = "running";

                return uninterruptibleWrite(async () => {
                  await pruned(found.handle, keep);
                });
              })
            )
          ),
        stop: (machine) =>
          call(
            "stop",
            machine,
            Effect.andThen(
              endCommands(machine),
              Effect.sync(() => {
                const found = machineOf(machine);

                if (found !== undefined) {
                  found.state = "stopped";
                }
              })
            )
          ),
        pause: (machine) =>
          call(
            "pause",
            machine,
            Effect.suspend((): Effect.Effect<void, StateError> => {
              const found = machineOf(machine);

              if (found === undefined) {
                return Effect.fail(missing(traits.runtime, machine));
              }

              if (found.state === "stopped") {
                return Effect.fail(
                  new WrongState({
                    message: `${machine.name} is stopped: start it first`,
                    machine: machine.name,
                    state: found.state,
                  })
                );
              }

              found.state = traits.pause === "stops" ? "stopped" : "paused";

              return Effect.void;
            })
          ),
        resize: (machine, to) =>
          call(
            "resize",
            machine,
            Effect.suspend(() => {
              const found = machineOf(machine);

              if (found === undefined) {
                return Effect.fail(
                  new Internal({ message: `no machine ${machine.name}` })
                );
              }

              const had = found.sizes;

              const partial = partialResizes.shift();

              const given = {
                cpu: to.cpu ?? had.cpu,
                ramMib: to.ramMib ?? had.ramMib,
                diskGib: to.diskGib ?? had.diskGib,
              };

              if (partial !== undefined) {
                found.sizes = { ...had, ramMib: given.ramMib };

                return Effect.fail(partial);
              }

              found.sizes = given;

              return Effect.void;
            })
          ),
        sizes: (machine) =>
          call(
            "sizes",
            machine,
            Effect.suspend(() => {
              const found = machineOf(machine);

              return found === undefined
                ? Effect.fail(
                    new Internal({ message: `no machine ${machine.name}` })
                  )
                : Effect.succeed(found.sizes);
            })
          ),
        delete: (machine, keep) =>
          Effect.andThen(
            Effect.sync(() => removals.push([machine.name, keep])),
            call(
              "delete",
              machine,
              lost(
                "delete",
                Effect.andThen(
                  endCommands(machine),
                  uninterruptibleWrite(async () => {
                    const found = machineOf(machine);

                    if (found === undefined) {
                      return;
                    }

                    machines.delete(found.handle);
                    await pruned(found.handle, keep);
                  })
                ),
                Effect.void
              )
            )
          ),
        capture: (machine, checkpoint) =>
          call(
            "capture",
            checkpoint,
            Effect.andThen(
              copyable(machine),
              Effect.flatMap(rootOf(machine), (root) =>
                uninterruptibleWrite(async () => {
                  await cp(root, checkpointRoot(checkpoint), {
                    recursive: true,
                  });

                  return keptCheckpoint(checkpoint, machine.handle);
                })
              )
            ),
            () => {
              keptCheckpoint(checkpoint, machine.handle);
            }
          ),
        deleteCheckpoint: (checkpoint) =>
          call(
            "deleteCheckpoint",
            checkpoint,
            uninterruptibleWrite(async () => {
              const root = heldCheckpoint(checkpoint);

              checkpoints.delete(checkpoint.handle);
              await rm(root, { recursive: true, force: true });
            })
          ),
        exec: (machine, command) =>
          call(
            "exec",
            machine,
            Effect.gen(function* () {
              const found = machineOf(machine);

              if (found?.state !== "running" && found?.state !== "unknown") {
                return {
                  output: Stream.make(
                    new TextEncoder().encode(
                      `exec: ${machine.name} isn't running\n`
                    )
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
                        : Stream.make(new TextEncoder().encode(command.stdin)),
                  })
                )
                .pipe(
                  Effect.mapError(
                    (error) => new Internal({ message: error.message })
                  )
                );

              const running = commands.get(machine.name) ?? new Set();

              commands.set(machine.name, running.add(handle));
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => running.delete(handle))
              );

              return {
                output: Stream.mapError(
                  handle.all,
                  (error) => new Internal({ message: error.message })
                ),
                exitCode: Effect.orElseSucceed(handle.exitCode, () => 137),
              };
            })
          ),
      });
    })
  );

  const byName = new ByName(machines);

  const faults: Faults = {
    drift: (instance) =>
      Effect.sync(() => {
        const found = [...machines.values()].find(
          (machine) => machine.instance === instance
        );

        if (found?.state === "running") {
          found.state = "stopped";
          record(`drift ${found.name}`);
        }
      }),
    landLate: lateMakes.arm,
    quota: (on) =>
      Effect.sync(() => {
        quotaOn = on;
      }),
    dropAnswer: (dropping) =>
      Effect.sync(() => {
        dropped.add(dropping);
      }),
  };

  return {
    layer,
    faults,
    calls,
    activations,
    observed,
    root: (name: string) => byName.get(name)?.root,
    images,
    machines: byName,
    hold: (machine: Omit<FakeMachine, "marked" | "sizes">) => {
      machines.set(machine.handle, {
        ...machine,
        marked: true,
        sizes: { cpu: 1, ramMib: 1024, diskGib: 10 },
      });
    },
    unmarked: Effect.sync(() => {
      const handle = minted("mach");
      const instance = randomUUID().replaceAll("-", "");

      machines.set(handle, {
        state: "running",
        sizes: { cpu: 1, ramMib: 1024, diskGib: 10 },
        name: instance,
        root: path.join(options.dir, "roots", instance),
        instance,
        handle,
        marked: false,
      });
      checkpoints.set(minted("ckpt"), {
        name: instance,
        instance,
        marked: false,
        of: owned?.checkpoints === "held" ? handle : undefined,
      });
    }),
    resizedTo: (name: string, sizing: Sizing) => {
      const found = byName.get(name);

      if (found !== undefined) {
        found.sizes = sizing;
      }
    },
    sized,
    searches,
    removals,
    starts,
    stubs: () => stubs,
    failNext: <O extends Operation>(operation: O, error: FailureOf<O>) => {
      inject(operation, { kind: "fail", error });
    },
    dieNext: (operation: Operation, message: string) => {
      inject(operation, { kind: "die", message });
    },
    giveOnlyRamThenFailNextResize: (error: RuntimeError) => {
      partialResizes.push(error);
    },
    refuseNextSizes: (error: Unsizable) => {
      sizableRefusals.push(error);
    },
    repin: (next: string | undefined) => {
      pin = next;
    },
    failFind: (name: string, error: RuntimeError) => {
      findFailures.set(name, error);
    },
    mendFind: (name: string) => {
      findFailures.delete(name);
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
      const until = Deferred.makeUnsafe<undefined>();
      const entered = Deferred.makeUnsafe<undefined>();

      observeHolds.push({ entered, until });

      return {
        release: Deferred.succeed(until, undefined),
        entered: Deferred.await(entered),
      };
    },
    holdNext: (operation: Operation, hold?: { readonly runsOn?: boolean }) => {
      const until = Deferred.makeUnsafe<undefined>();
      const entered = Deferred.makeUnsafe<undefined>();

      inject(operation, {
        kind: "hold",
        entered,
        until,
        runsOn: hold?.runsOn ?? false,
      });

      return {
        release: Deferred.succeed(until, undefined),
        entered: Deferred.await(entered),
      };
    },
  };
};

export type FakeRuntime = ReturnType<typeof fakeRuntime>;
