/**
 * The CLI's commands. Every command takes IDs, except `create`, which takes a name or a full
 * ID. A mutation returns when its action has finished; its `--timeout` only stops waiting.
 */
import {
  type ClankerboxError,
  Client,
  Invalid,
  loadProfile,
  MachineSpec,
  readSetup,
} from "@gjermundgaraba/clankerbox-sdk";
import { Console, DateTime, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { type LoadedConfig, loadConfig, profileFile } from "./config.ts";
import {
  checkpointRows,
  encodeCheckpoint,
  encodeHost,
  encodeMachine,
  Exited,
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
  config: Flag.String("config").pipe(
    Flag.withDescription(
      "The client config file. Default: $XDG_CONFIG_HOME/clankerbox/config.json.",
    ),
    Flag.optional,
  ),
};

/** A mutation's flags: a read gives up after 10 s of its own, and takes no `--timeout`. */
const mutationFlags = {
  ...clientFlags,
  timeout: Flag.Int("timeout").pipe(
    Flag.withDescription(
      "Stop waiting for the mutation's reply after SECONDS; unbounded by default. It cancels nothing on the host.",
    ),
    Flag.filter(
      (seconds) => seconds > 0,
      () => "a positive number of seconds",
    ),
    Flag.optional,
  ),
};

type ClientFlags = Command.Command.Config.Infer<typeof clientFlags> & {
  readonly timeout?: Option.Option<number>;
};

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

/**
 * Runs a command against the configured hosts. Its failure is printed, and the process exits
 * 1. A mutation's `--timeout` bounds the wait for its reply, and ends only the wait: the
 * host's action runs on.
 */
export const withClient = <A, R>(
  flags: ClientFlags,
  body: (client: Client.Interface, config: LoadedConfig) => Effect.Effect<A, ClankerboxError, R>,
): Effect.Effect<A, Exited, R | Services> =>
  Effect.gen(function* () {
    const config = yield* loadConfig(flags.config);

    const client = yield* Client.make(config.hosts, {
      timeout: Option.getOrUndefined(Option.map(flags.timeout ?? Option.none(), Duration.seconds)),
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
 * didn't answer go to stderr, or to `unreachable` with `--json`. When no host answered, the
 * command exits 1, as a failed call does; a partial answer exits 0.
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
    Effect.gen(function* () {
      const failed = yield* withClient(flags, (client, config) =>
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

          return unreachable.length === config.hosts.length;
        }),
      );

      if (failed) {
        return yield* new Exited({ code: 1 });
      }
    }),
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

/**
 * The body of a command that makes one client call and prints the resource it replies with:
 * its JSON document with `--json`, or else `text`.
 */
const printResource = <A, Encoded extends object, R>(
  flags: ClientFlags,
  resource: {
    readonly call: (
      client: Client.Interface,
      config: LoadedConfig,
    ) => Effect.Effect<A, ClankerboxError, R>;
    readonly encode: (resource: A) => Encoded;
    readonly text: (resource: A, now: DateTime.Utc) => string;
  },
) =>
  withClient(flags, (client, config) =>
    Effect.gen(function* () {
      const replied = yield* resource.call(client, config);
      const now = yield* DateTime.now;

      yield* print(
        flags.json,
        () => resource.encode(replied),
        () => resource.text(replied, now),
      );
    }),
  );

/** What a command that makes a resource prints without `--json`: the new ID. */
const newId = ({ id }: { readonly id: string }) => id;

const createArguments = {
  target: Argument.String("target").pipe(
    Argument.withDescription(
      "A name, placed on the profile's host or the first host that offers the base, or a full ID <host>_<name>.",
    ),
  ),
  profile: Flag.String("profile").pipe(
    Flag.withDescription(
      "A profile file's path, or a name in the config's profiles directory. The other flags override its fields.",
    ),
    Flag.optional,
  ),
  base: Flag.String("base").pipe(Flag.withDescription("The base to create from."), Flag.optional),
  cpu: Flag.Int("cpu").pipe(Flag.withDescription("vCPUs."), Flag.optional),
  ramMib: Flag.Int("ram-mib").pipe(Flag.withDescription("RAM in MiB."), Flag.optional),
  diskGib: Flag.Int("disk-gib").pipe(Flag.withDescription("Disk in GiB."), Flag.optional),
  setup: Flag.String("setup").pipe(
    Flag.withDescription(
      "A setup script, or a recipe directory holding setup.sh. With --setup-timeout, it replaces the profile's setup.",
    ),
    Flag.optional,
  ),
  setupTimeout: Flag.Int("setup-timeout").pipe(
    Flag.withDescription("How long setup may run, in seconds. Goes with --setup."),
    Flag.optional,
  ),
};

type CreateFlags = Command.Command.Config.Infer<typeof mutationFlags & typeof createArguments>;

/** `--setup` and `--setup-timeout`, which go together, with the path resolved against the cwd. */
const flagSetup = (flags: CreateFlags) =>
  Effect.gen(function* () {
    if (Option.isNone(flags.setup) && Option.isNone(flags.setupTimeout)) {
      return undefined;
    }

    if (Option.isNone(flags.setup) || Option.isNone(flags.setupTimeout)) {
      return yield* new Invalid({ message: "--setup and --setup-timeout go together" });
    }

    const path = yield* Path.Path;

    return { path: path.resolve(flags.setup.value), timeoutSeconds: flags.setupTimeout.value };
  });

const decodeSpec = Schema.decodeUnknownEffect(MachineSpec);

/**
 * The spec and host a create asks for: the profile's fields, each overridden by its flag, and
 * the profile's setup, replaced as a unit by `--setup` with `--setup-timeout`.
 */
const createRequest = (flags: CreateFlags, config: LoadedConfig) =>
  Effect.gen(function* () {
    const replacement = yield* flagSetup(flags);

    const profile = Option.isSome(flags.profile)
      ? yield* loadProfile(yield* profileFile(config, flags.profile.value))
      : undefined;

    const source = replacement ?? profile?.setup;

    const fields = {
      base: Option.getOrElse(flags.base, () => profile?.base),
      cpu: Option.getOrElse(flags.cpu, () => profile?.cpu),
      ramMib: Option.getOrElse(flags.ramMib, () => profile?.ramMib),
      diskGib: Option.getOrElse(flags.diskGib, () => profile?.diskGib),
    };

    const withSetup =
      source === undefined
        ? fields
        : {
            ...fields,
            setup: { script: yield* readSetup(source.path), timeoutSeconds: source.timeoutSeconds },
          };

    const spec = yield* decodeSpec(
      profile === undefined ? withSetup : { ...withSetup, profile: profile.label },
      { onExcessProperty: "error", errors: "all" },
    ).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `create's spec, from --profile and --base, --cpu, --ram-mib and --disk-gib, is invalid: ${error.message}`,
          }),
      ),
    );

    return { spec, host: profile?.host };
  });

const create = Command.make("create", { ...mutationFlags, ...createArguments }, (flags) =>
  printResource(flags, {
    call: (client, config) =>
      Effect.flatMap(createRequest(flags, config), ({ spec, host }) =>
        client.create(flags.target, spec, { host }),
      ),
    encode: encodeMachine,
    text: newId,
  }),
).pipe(
  Command.withDescription(
    "Create a machine from a profile, from a base with sizes and an optional setup, or from both: each flag overrides the profile's field. Prints the new ID.",
  ),
);

/** What start and stop print without `--json`: the machine's ID and state. */
const machineState = (machine: { readonly id: string; readonly state: string }) =>
  `${machine.id} ${machine.state}`;

const start = Command.make("start", { ...mutationFlags, machine: machineArgument }, (flags) =>
  printResource(flags, {
    call: (client) => client.start(flags.machine),
    encode: encodeMachine,
    text: machineState,
  }),
).pipe(Command.withDescription("Start a machine. On a running machine, run preparation again."));

const stop = Command.make("stop", { ...mutationFlags, machine: machineArgument }, (flags) =>
  printResource(flags, {
    call: (client) => client.stop(flags.machine),
    encode: encodeMachine,
    text: machineState,
  }),
).pipe(Command.withDescription("Stop a machine. Stopping a stopped machine does nothing."));

/**
 * Deleting what is already gone is done: the host answers NotFound, the CLI says so on stderr,
 * and exits 0. Either way `--json` prints `{deleted: id}`.
 */
const deleted = (json: boolean, id: string, removal: Effect.Effect<void, ClankerboxError>) =>
  removal.pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.flatMap((gone) =>
      gone && !json
        ? Console.error(`clankerbox: ${id} was already gone`)
        : print(
            json,
            () => ({ deleted: id }),
            () => id,
          ),
    ),
  );

const deleteMachine = Command.make(
  "delete",
  { ...mutationFlags, machine: machineArgument },
  (flags) =>
    withClient(flags, (client) => deleted(flags.json, flags.machine, client.delete(flags.machine))),
).pipe(
  Command.withDescription("Delete a machine. A machine that is already gone counts as deleted."),
);

const fork = Command.make(
  "fork",
  { ...mutationFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.fork(flags.machine, flags.name),
      encode: encodeMachine,
      text: newId,
    }),
).pipe(Command.withDescription("Copy a machine to a new name on its host. Prints the new ID."));

const restore = Command.make(
  "restore",
  { ...mutationFlags, checkpoint: checkpointArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.restore(flags.checkpoint, flags.name),
      encode: encodeMachine,
      text: newId,
    }),
).pipe(
  Command.withDescription(
    "Create a machine from a checkpoint, on the checkpoint's host. Prints the new ID.",
  ),
);

const capture = Command.make(
  "capture",
  { ...mutationFlags, machine: machineArgument, name: nameArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.capture(flags.machine, flags.name),
      encode: encodeCheckpoint,
      text: newId,
    }),
).pipe(
  Command.withDescription(
    "Capture a checkpoint. Its kind follows the runtime: ram on smolvm, which captures only a running machine, and disk on Tart and boat. Prints its ID.",
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
    printResource(flags, {
      call: (client) => client.checkpoint(flags.checkpoint),
      encode: encodeCheckpoint,
      text: (checkpoint, now) => table(checkpointRows([checkpoint], now)),
    }),
).pipe(Command.withDescription("Read one checkpoint."));

const deleteCheckpoint = Command.make(
  "delete",
  { ...mutationFlags, checkpoint: checkpointArgument },
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
