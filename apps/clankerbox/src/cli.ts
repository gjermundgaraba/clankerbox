/**
 * The CLI's commands. Every command takes IDs, except `create`, which takes a name or a full
 * ID. A mutation returns when its action has finished; `--timeout` only stops waiting.
 */
import {
  type ClankerboxError,
  Client,
  Invalid,
  loadProfile,
  type MachineSpec,
  readSetup,
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
    Flag.withDescription(
      "Stop waiting for a host's reply after SECONDS. The action keeps running on its host.",
    ),
    Flag.filter(
      (seconds) => seconds > 0,
      () => "a positive number of seconds",
    ),
    Flag.optional,
  ),
  config: Flag.String("config").pipe(
    Flag.withDescription(
      "The client config file. Default: $XDG_CONFIG_HOME/clankerbox/config.json.",
    ),
    Flag.optional,
  ),
};

type ClientFlags = Command.Command.Config.Infer<typeof clientFlags>;

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

/**
 * Runs a command against the configured hosts. Its failure is printed, and the process exits
 * 1. `--timeout` bounds the wait for each host's reply, and ends only the wait: the host's
 * action runs on.
 */
export const withClient = <A, R>(
  flags: ClientFlags,
  body: (client: Client.Interface, config: LoadedConfig) => Effect.Effect<A, ClankerboxError, R>,
): Effect.Effect<A, Exited, R | Services> =>
  Effect.gen(function* () {
    const config = yield* loadConfig(flags.config);

    const client = yield* Client.make(config.hosts, {
      timeout: Option.getOrUndefined(Option.map(flags.timeout, Duration.seconds)),
    });

    return yield* body(client, config);
  }).pipe(Effect.catch(fail(flags.json)));

const print = (json: boolean, document: () => object, text: () => string) =>
  json ? Console.log(JSON.stringify(document())) : Console.log(text());

export const machineArgument = Argument.String("machine").pipe(
  Argument.withDescription("The machine's ID, <host>_<name>."),
);

const checkpointArgument = Argument.String("checkpoint").pipe(
  Argument.withDescription("The checkpoint's ID, <host>_<name>."),
);

const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("The new resource's name, on the same host."),
);

/**
 * A list over every host: a table, or with `--json` the answers under `key`. The hosts that
 * didn't answer go to stderr, or to `unreachable` with `--json`.
 */
const listCommand = <A, Encoded>(options: {
  readonly name: string;
  readonly description: string;
  readonly key: string;
  readonly read: (client: Client.Interface) => Effect.Effect<Client.Gathered<A>>;
  readonly encode: (answer: A) => Encoded;
  readonly rows: (answers: ReadonlyArray<A>, now: DateTime.Utc) => Array<Array<string>>;
}) =>
  Command.make(options.name, clientFlags, (flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const { answers, unreachable } = yield* options.read(client);
        const now = yield* DateTime.now;

        yield* print(
          flags.json,
          () => ({
            [options.key]: answers.map((answer) => options.encode(answer)),
            unreachable: unreachableDocument(unreachable),
          }),
          () => table(options.rows(answers, now)),
        );

        if (!flags.json) {
          yield* warnUnreachable(unreachable);
        }
      }),
    ),
  ).pipe(Command.withDescription(options.description));

const hosts = listCommand({
  name: "hosts",
  description: "List every host, with its runtime, versions and bases.",
  key: "hosts",
  read: (client) => client.hosts,
  encode: encodeHost,
  rows: (answers) => hostRows(answers),
});

const machines = listCommand({
  name: "machines",
  description: "List every host's machines, with each machine's age.",
  key: "machines",
  read: (client) => client.machines,
  encode: encodeMachine,
  rows: machineRows,
});

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

type CreateFlags = Command.Command.Config.Infer<typeof createFlags>;

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
  withClient(flags, (client, config) =>
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
    withClient(flags, (client) =>
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
    withClient(flags, (client) => deleted(flags.json, flags.machine, client.delete(flags.machine))),
).pipe(
  Command.withDescription("Delete a machine. A machine that is already gone counts as deleted."),
);

const fork = Command.make(
  "fork",
  { ...clientFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    withClient(flags, (client) =>
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
    checkpoint: checkpointArgument,
    name: nameArgument,
  },
  (flags) =>
    withClient(flags, (client) =>
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

const capture = Command.make(
  "capture",
  { ...clientFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    withClient(flags, (client) =>
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

const listCheckpoints = listCommand({
  name: "list",
  description: "List every host's checkpoints.",
  key: "checkpoints",
  read: (client) => client.checkpoints,
  encode: encodeCheckpoint,
  rows: checkpointRows,
});

const getCheckpoint = Command.make(
  "get",
  { ...clientFlags, checkpoint: checkpointArgument },
  (flags) =>
    withClient(flags, (client) =>
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
    withClient(flags, (client) =>
      deleted(flags.json, flags.checkpoint, client.deleteCheckpoint(flags.checkpoint)),
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
