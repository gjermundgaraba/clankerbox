/**
 * The CLI's commands. Every command takes IDs, except `create`, which takes a name or a full
 * ID. A mutation returns when its action has finished; `--timeout` only stops waiting.
 */
import {
  type Access,
  type ClankerboxError,
  Client,
  Invalid,
  isId,
  loadProfile,
  type MachineSpec,
  readSetup,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { Console, DateTime, Duration, Effect, FileSystem, Option, Path } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { type LoadedConfig, loadConfig, profileFile } from "./config.ts";
import {
  checkpointRows,
  encodeCheckpoint,
  encodeHost,
  encodeMachine,
  type Exited,
  fail,
  hostRows,
  machineRows,
  table,
  unreachableDocument,
  warnUnreachable,
} from "./output.ts";

export const clientFlags = {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print JSON: the result, or {error: {message, tag, retryable}}."),
    Flag.withDefault(false),
  ),
  timeout: Flag.Int("timeout").pipe(
    Flag.withDescription("Stop waiting after SECONDS. The action keeps running on its host."),
    Flag.optional,
  ),
  config: Flag.String("config").pipe(
    Flag.withDescription(
      "The client config file. Default: $XDG_CONFIG_HOME/clankerbox/config.json.",
    ),
    Flag.optional,
  ),
};

export interface ClientFlags {
  readonly json: boolean;
  readonly timeout: Option.Option<number>;
  readonly config: Option.Option<string>;
}

/** What a command waits for, for the message when `--timeout` stops the wait. */
export interface Waiting {
  readonly access: Access;
  readonly action: string;
  /** What to read to see how a mutation ends. */
  readonly read: string;
}

export type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

const timedOut = (seconds: number, waiting: Waiting): ClankerboxError =>
  waiting.access === "read"
    ? new Unavailable({
        message: `stopped waiting for ${waiting.action} after ${seconds}s`,
        access: "read",
      })
    : new Unavailable({
        message: `stopped waiting after ${seconds}s; ${waiting.action} is still running: read ${waiting.read} to see how it ends`,
        access: "write",
      });

/**
 * Runs a command against the configured hosts. Its failure is printed, and the process exits
 * 1. `--timeout` ends only the wait: the host's action runs on.
 */
export const withClient = <A, R>(
  flags: ClientFlags,
  waiting: Waiting,
  body: (client: Client.Interface, config: LoadedConfig) => Effect.Effect<A, ClankerboxError, R>,
): Effect.Effect<A, Exited, R | Services> => {
  const work = Effect.gen(function* () {
    const config = yield* loadConfig(flags.config);
    const client = yield* Client.make(config.hosts);

    return yield* body(client, config);
  });

  const bounded = Option.match(flags.timeout, {
    onNone: () => work,
    onSome: (seconds) =>
      work.pipe(
        Effect.timeoutOption(Duration.seconds(seconds)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(timedOut(seconds, waiting)),
            onSome: Effect.succeed,
          }),
        ),
      ),
  });

  return Effect.catch(bounded, fail(flags.json));
};

const print = (json: boolean, document: () => object, text: () => string) =>
  json ? Console.log(JSON.stringify(document())) : Console.log(text());

const machineArgument = Argument.String("machine").pipe(
  Argument.withDescription("The machine's ID, <host>_<name>."),
);

const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("The new resource's name, on the same host."),
);

const hosts = Command.make("hosts", clientFlags, (flags) =>
  withClient(flags, { access: "read", action: "hosts", read: "" }, (client) =>
    Effect.gen(function* () {
      const { answers, unreachable } = yield* client.hosts;

      yield* print(
        flags.json,
        () => ({
          hosts: answers.map((host) => encodeHost(host)),
          unreachable: unreachableDocument(unreachable),
        }),
        () => table(hostRows(answers)),
      );

      if (!flags.json) {
        yield* warnUnreachable(unreachable);
      }
    }),
  ),
).pipe(Command.withDescription("List every host, with its runtime, versions and bases."));

const machines = Command.make("machines", clientFlags, (flags) =>
  withClient(flags, { access: "read", action: "machines", read: "" }, (client) =>
    Effect.gen(function* () {
      const { answers, unreachable } = yield* client.machines;
      const now = yield* DateTime.now;

      yield* print(
        flags.json,
        () => ({
          machines: answers.map((machine) => encodeMachine(machine)),
          unreachable: unreachableDocument(unreachable),
        }),
        () => table(machineRows(answers, now)),
      );

      if (!flags.json) {
        yield* warnUnreachable(unreachable);
      }
    }),
  ),
).pipe(Command.withDescription("List every host's machines, with each machine's age."));

const createFlags = {
  ...clientFlags,
  target: Argument.String("target").pipe(
    Argument.withDescription(
      "A name, placed on the profile's host or the first host that offers the base, or a full ID <host>_<name>.",
    ),
  ),
  profile: Flag.String("profile").pipe(
    Flag.withDescription("A profile file's path, or a name in the config's profiles directory."),
    Flag.optional,
  ),
  base: Flag.String("base").pipe(Flag.withDescription("The base to create from."), Flag.optional),
  cpu: Flag.Int("cpu").pipe(Flag.withDescription("vCPUs."), Flag.optional),
  ramMib: Flag.Int("ram-mib").pipe(Flag.withDescription("RAM in MiB."), Flag.optional),
  diskGib: Flag.Int("disk-gib").pipe(Flag.withDescription("Disk in GiB."), Flag.optional),
  setup: Flag.String("setup").pipe(
    Flag.withDescription("A setup script, or a recipe directory holding setup.sh."),
    Flag.optional,
  ),
  setupTimeout: Flag.Int("setup-timeout").pipe(
    Flag.withDescription("How long setup may run, in seconds. Required with --setup."),
    Flag.optional,
  ),
};

interface CreateFlags {
  readonly profile: Option.Option<string>;
  readonly base: Option.Option<string>;
  readonly cpu: Option.Option<number>;
  readonly ramMib: Option.Option<number>;
  readonly diskGib: Option.Option<number>;
  readonly setup: Option.Option<string>;
  readonly setupTimeout: Option.Option<number>;
}

/** The spec and host a create asks for, from a profile file or from the flags. */
const createRequest = (flags: CreateFlags, config: LoadedConfig) =>
  Effect.gen(function* () {
    const direct = [
      Option.isSome(flags.base),
      Option.isSome(flags.cpu),
      Option.isSome(flags.ramMib),
      Option.isSome(flags.diskGib),
      Option.isSome(flags.setup),
      Option.isSome(flags.setupTimeout),
    ];

    if (Option.isSome(flags.profile)) {
      if (direct.includes(true)) {
        return yield* new Invalid({
          message:
            "--profile doesn't mix with --base, --cpu, --ram-mib, --disk-gib, --setup or --setup-timeout",
        });
      }

      return yield* loadProfile(yield* profileFile(config, flags.profile.value));
    }

    if (
      Option.isNone(flags.base) ||
      Option.isNone(flags.cpu) ||
      Option.isNone(flags.ramMib) ||
      Option.isNone(flags.diskGib)
    ) {
      return yield* new Invalid({
        message: "create needs --profile, or --base, --cpu, --ram-mib and --disk-gib",
      });
    }

    const sizes = {
      base: flags.base.value,
      cpu: flags.cpu.value,
      ramMib: flags.ramMib.value,
      diskGib: flags.diskGib.value,
    };

    if (Option.isNone(flags.setup) && Option.isNone(flags.setupTimeout)) {
      return { spec: sizes, host: undefined };
    }

    if (Option.isNone(flags.setup) || Option.isNone(flags.setupTimeout)) {
      return yield* new Invalid({ message: "--setup and --setup-timeout go together" });
    }

    const path = yield* Path.Path;
    const setup = yield* readSetup(path.resolve(flags.setup.value));
    const spec: MachineSpec = { ...sizes, setup, setupTimeoutSeconds: flags.setupTimeout.value };

    return { spec, host: undefined };
  });

const create = Command.make("create", createFlags, (flags) =>
  withClient(
    flags,
    {
      access: "write",
      action: `create ${flags.target}`,
      read: isId(flags.target) ? flags.target : "`clankerbox machines`",
    },
    (client, config) =>
      Effect.gen(function* () {
        const { spec, host } = yield* createRequest(flags, config);
        const machine = yield* client.create(flags.target, spec, { host });

        yield* print(
          flags.json,
          () => encodeMachine(machine),
          () => machine.id,
        );
      }),
  ),
).pipe(
  Command.withDescription(
    "Create a machine from a profile, or from a base with sizes and an optional setup. Prints the new ID.",
  ),
);

/** A mutation on one machine that replies with the machine. */
const machineAction = (
  name: "start" | "stop",
  description: string,
  call: (client: Client.Interface, id: string) => ReturnType<Client.Interface["start"]>,
) =>
  Command.make(name, { ...clientFlags, machine: machineArgument }, (flags) =>
    withClient(
      flags,
      { access: "write", action: `${name} ${flags.machine}`, read: flags.machine },
      (client) =>
        Effect.flatMap(call(client, flags.machine), (machine) =>
          print(
            flags.json,
            () => encodeMachine(machine),
            () => `${machine.id} ${machine.state}`,
          ),
        ),
    ),
  ).pipe(Command.withDescription(description));

const start = machineAction(
  "start",
  "Start a machine. On a running machine, run preparation again.",
  (client, id) => client.start(id),
);

const stop = machineAction(
  "stop",
  "Stop a machine. Stopping a stopped machine does nothing.",
  (client, id) => client.stop(id),
);

/** Deleting what is already gone is done: the host answers NotFound, and the CLI exits 0. */
const deleted = (json: boolean, id: string, removal: Effect.Effect<void, ClankerboxError>) =>
  removal.pipe(
    Effect.andThen(
      print(
        json,
        () => ({ deleted: id }),
        () => id,
      ),
    ),
    Effect.catchTag("NotFound", () =>
      json
        ? Console.log(JSON.stringify({ deleted: id }))
        : Console.error(`clankerbox: ${id} was already gone`),
    ),
  );

const deleteMachine = Command.make(
  "delete",
  { ...clientFlags, machine: machineArgument },
  (flags) =>
    withClient(
      flags,
      { access: "write", action: `delete ${flags.machine}`, read: flags.machine },
      (client) => deleted(flags.json, flags.machine, client.delete(flags.machine)),
    ),
).pipe(
  Command.withDescription("Delete a machine. A machine that is already gone counts as deleted."),
);

const fork = Command.make(
  "fork",
  { ...clientFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    withClient(
      flags,
      {
        access: "write",
        action: `fork ${flags.machine}`,
        read: "`clankerbox machines`",
      },
      (client) =>
        Effect.flatMap(client.fork(flags.machine, flags.name), (machine) =>
          print(
            flags.json,
            () => encodeMachine(machine),
            () => machine.id,
          ),
        ),
    ),
).pipe(Command.withDescription("Copy a machine to a new name on its host. Prints the new ID."));

const restore = Command.make(
  "restore",
  {
    ...clientFlags,
    checkpoint: Argument.String("checkpoint").pipe(
      Argument.withDescription("The checkpoint's ID, <host>_<name>."),
    ),
    name: nameArgument,
  },
  (flags) =>
    withClient(
      flags,
      {
        access: "write",
        action: `restore ${flags.checkpoint}`,
        read: "`clankerbox machines`",
      },
      (client) =>
        Effect.flatMap(client.restore(flags.checkpoint, flags.name), (machine) =>
          print(
            flags.json,
            () => encodeMachine(machine),
            () => machine.id,
          ),
        ),
    ),
).pipe(
  Command.withDescription(
    "Create a machine from a checkpoint, on the checkpoint's host. Prints the new ID.",
  ),
);

const checkpointArgument = Argument.String("checkpoint").pipe(
  Argument.withDescription("The checkpoint's ID, <host>_<name>."),
);

const capture = Command.make(
  "capture",
  { ...clientFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    withClient(
      flags,
      {
        access: "write",
        action: `capture ${flags.machine}`,
        read: "`clankerbox checkpoint list`",
      },
      (client) =>
        Effect.flatMap(client.capture(flags.machine, flags.name), (checkpoint) =>
          print(
            flags.json,
            () => encodeCheckpoint(checkpoint),
            () => checkpoint.id,
          ),
        ),
    ),
).pipe(
  Command.withDescription(
    "Capture a checkpoint: ram from a running machine, disk from a stopped one. Prints its ID.",
  ),
);

const listCheckpoints = Command.make("list", clientFlags, (flags) =>
  withClient(flags, { access: "read", action: "checkpoint list", read: "" }, (client) =>
    Effect.gen(function* () {
      const { answers, unreachable } = yield* client.checkpoints;
      const now = yield* DateTime.now;

      yield* print(
        flags.json,
        () => ({
          checkpoints: answers.map((checkpoint) => encodeCheckpoint(checkpoint)),
          unreachable: unreachableDocument(unreachable),
        }),
        () => table(checkpointRows(answers, now)),
      );

      if (!flags.json) {
        yield* warnUnreachable(unreachable);
      }
    }),
  ),
).pipe(Command.withDescription("List every host's checkpoints."));

const getCheckpoint = Command.make(
  "get",
  { ...clientFlags, checkpoint: checkpointArgument },
  (flags) =>
    withClient(
      flags,
      { access: "read", action: `checkpoint get ${flags.checkpoint}`, read: "" },
      (client) =>
        Effect.gen(function* () {
          const checkpoint = yield* client.checkpoint(flags.checkpoint);
          const now = yield* DateTime.now;

          yield* print(
            flags.json,
            () => encodeCheckpoint(checkpoint),
            () => table(checkpointRows([checkpoint], now)),
          );
        }),
    ),
).pipe(Command.withDescription("Read one checkpoint."));

const deleteCheckpoint = Command.make(
  "delete",
  { ...clientFlags, checkpoint: checkpointArgument },
  (flags) =>
    withClient(
      flags,
      { access: "write", action: `delete ${flags.checkpoint}`, read: flags.checkpoint },
      (client) => deleted(flags.json, flags.checkpoint, client.deleteCheckpoint(flags.checkpoint)),
    ),
).pipe(
  Command.withDescription(
    "Delete a checkpoint. A checkpoint that is already gone counts as deleted.",
  ),
);

const checkpoint = Command.make("checkpoint").pipe(
  Command.withDescription("Capture, list, read and delete checkpoints."),
  Command.withSubcommands([capture, listCheckpoints, getCheckpoint, deleteCheckpoint]),
);

export const clientCommands = [
  hosts,
  machines,
  create,
  start,
  stop,
  deleteMachine,
  fork,
  checkpoint,
  restore,
] as const;
