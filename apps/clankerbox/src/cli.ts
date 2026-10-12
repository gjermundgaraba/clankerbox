/**
 * The CLI's commands. Every command takes IDs, except `create`, which takes a name or a full
 * ID. A mutation returns when its action has finished; its `--timeout` only stops waiting.
 */
import {
  type ClankerboxError,
  Client,
  describeIssues,
  Invalid,
  type LoadedProfile,
  loadProfile,
  MachineSpec,
  readSetup,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Console,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Record,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { type LoadedConfig, loadConfig, profileFile, profileFiles } from "./config.ts";
import {
  checkpointFields,
  checkpointRows,
  encodeCheckpoint,
  encodeHost,
  encodeLimit,
  encodeMachine,
  encodeProfile,
  Exited,
  fail,
  hostRows,
  limitRows,
  machineFields,
  machineRows,
  profileRows,
  table,
  unreachableDocument,
  warnUnreachable,
} from "./output.ts";
import { parseGib, parseMib, parseSeconds } from "./units.ts";

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
  timeout: Flag.String("timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "Stop waiting for the mutation's reply after this long, such as 90s or 10m; unbounded by default. It cancels nothing on the host.",
    ),
    Flag.optional,
  ),
};

type ClientFlags = Command.Command.Config.Infer<typeof clientFlags> & {
  readonly timeout?: Option.Option<string>;
};

/** A flag's value, parsed when the flag was given. */
const parsed = <A>(
  flag: Option.Option<string>,
  name: string,
  parse: (name: string, text: string) => Effect.Effect<A, Invalid>,
) => Effect.transposeOption(Option.map(flag, (text) => parse(name, text)));

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
    const timeout = yield* parsed(flags.timeout ?? Option.none(), "--timeout", parseSeconds);
    const config = yield* loadConfig(flags.config);

    const client = yield* Client.make(config.hosts, {
      timeout: Option.getOrUndefined(Option.map(timeout, Duration.seconds)),
    });

    return yield* body(client, config);
  }).pipe(Effect.catch(fail(flags.json)));

const print = (json: boolean, document: () => object, text: () => string) =>
  json ? Console.log(JSON.stringify(document())) : Console.log(text());

const machineArgument = Argument.String("machine").pipe(
  Argument.withDescription("The machine's ID, <host>_<name>."),
);

const checkpointArgument = Argument.String("checkpoint").pipe(
  Argument.withDescription("The checkpoint's ID, <host>_<name>."),
);

const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("The new resource's name, on the same host."),
);

/**
 * A list over every host: a table, or with `--json` the answers under `key`. With nothing to
 * list, stdout stays empty and stderr says so. The hosts that didn't answer go to stderr,
 * or to `unreachable` with `--json`. When every host failed, the command exits 1, as a failed
 * call does; a partial answer exits 0.
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
          const failed = unreachable.length === config.hosts.length;

          if (flags.json) {
            yield* Console.log(
              JSON.stringify({
                [options.key]: answers.map((answer) => options.encode(answer)),
                unreachable: unreachableDocument(unreachable),
              }),
            );

            return failed;
          }

          if (answers.length > 0) {
            yield* Console.log(table(options.rows(answers, now)));
          } else if (!failed) {
            yield* Console.error(`clankerbox: no ${options.key} to list`);
          }

          yield* warnUnreachable(unreachable);

          return failed;
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

const capacity = listCommand({
  name: "capacity",
  description:
    "List every host's limits and how much of each is in use. A host refuses an action that would pass one.",
  key: "capacity",
  read: (client) => client.capacity,
  encode: encodeLimit,
  rows: (answers) => limitRows(answers),
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
 * The profiles in the config's profiles directory, read on the client: no host is asked. A
 * profile file that doesn't decode fails the command, naming the file.
 */
const profiles = Command.make("profiles", clientFlags, (flags) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* loadConfig(flags.config);
    const { directory, files } = yield* profileFiles(config);
    const loaded = yield* Effect.forEach(files, loadProfile);

    if (loaded.length === 0 && !flags.json) {
      return yield* Console.error(`clankerbox: no profiles in ${directory}`);
    }

    yield* print(
      flags.json,
      () => ({ profiles: loaded.map(encodeProfile) }),
      () => table(profileRows(loaded, (setup) => path.relative(directory, setup))),
    );
  }).pipe(Effect.catch(fail(flags.json))),
).pipe(
  Command.withDescription(
    "List the profiles in the config's profiles directory, with each one's base, sizes, setup and host.",
  ),
);

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

const getMachine = Command.make("get", { ...clientFlags, machine: machineArgument }, (flags) =>
  printResource(flags, {
    call: (client) => client.machine(flags.machine),
    encode: encodeMachine,
    text: (machine, now) => table(machineFields(machine, now)),
  }),
).pipe(
  Command.withDescription(
    "Read one machine: its state, its last action and the error it failed with, its SSH login and its host key.",
  ),
);

/** What a command that makes a resource prints without `--json`: the new ID. */
const newId = ({ id }: { readonly id: string }) => id;

const createArguments = {
  name: Argument.String("name").pipe(
    Argument.withDescription("The new machine's name. Its ID is <host>_<name>."),
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription(
      "The host to create on. Without it, the profile's host, or else the first host that offers the base.",
    ),
    Flag.optional,
  ),
  profile: Flag.String("profile").pipe(
    Flag.withDescription(
      "A profile file's path, or a name in the config's profiles directory. The other flags override its fields.",
    ),
    Flag.optional,
  ),
  base: Flag.String("base").pipe(Flag.withDescription("The base to create from."), Flag.optional),
  cpu: Flag.Int("cpu").pipe(Flag.withDescription("vCPUs."), Flag.optional),
  ram: Flag.String("ram").pipe(
    Flag.withMetavar("SIZE"),
    Flag.withDescription("RAM, such as 512M or 8G."),
    Flag.optional,
  ),
  disk: Flag.String("disk").pipe(
    Flag.withMetavar("SIZE"),
    Flag.withDescription("Disk, in whole GiB, such as 60G."),
    Flag.optional,
  ),
  setup: Flag.String("setup").pipe(
    Flag.withDescription(
      "A setup script, or a recipe directory holding setup.sh. A base alone authorizes no SSH key: a setup does.",
    ),
    Flag.optional,
  ),
  setupTimeout: Flag.String("setup-timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "How long setup may run, such as 90s or 15m. Default: the profile's, or else the host's.",
    ),
    Flag.optional,
  ),
};

type CreateFlags = Command.Command.Config.Infer<typeof mutationFlags & typeof createArguments>;

/**
 * The setup a create runs, if any: the profile's, with its path and its timeout each overridden
 * by its flag, and no timeout when neither says, which leaves it to the host. `--setup` is
 * resolved against the cwd.
 */
const setupSource = (flags: CreateFlags, profile: LoadedProfile | undefined) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    const file = Option.match(flags.setup, {
      onNone: () => profile?.setup?.path,
      onSome: (given) => path.resolve(given),
    });

    const timed = yield* parsed(flags.setupTimeout, "--setup-timeout", parseSeconds);

    if (file === undefined) {
      return Option.isNone(timed)
        ? undefined
        : yield* new Invalid({
            message: "--setup-timeout needs a setup: pass --setup, or a profile that has one",
          });
    }

    const timeoutSeconds = Option.getOrElse(timed, () => profile?.setup?.timeoutSeconds);

    return { path: file, timeout: timeoutSeconds === undefined ? {} : { timeoutSeconds } };
  });

const decodeSpec = Schema.decodeUnknownEffect(MachineSpec);

/** The flag that sets each of a spec's fields, which is how a refusal names the field. */
const specFlags = new Map<PropertyKey, string>([
  ["base", "--base"],
  ["cpu", "--cpu"],
  ["ramMib", "--ram"],
  ["diskGib", "--disk"],
]);

/**
 * The spec and host a create asks for: the profile's fields, setup and host, each overridden by
 * its flag. The decode refuses a field that neither sets, as it does one out of range.
 */
const createRequest = (flags: CreateFlags, config: LoadedConfig) =>
  Effect.gen(function* () {
    const profile = Option.isSome(flags.profile)
      ? yield* loadProfile(yield* profileFile(config, flags.profile.value))
      : undefined;

    const source = yield* setupSource(flags, profile);

    const ram = yield* parsed(flags.ram, "--ram", parseMib);
    const disk = yield* parsed(flags.disk, "--disk", parseGib);

    const fields = {
      base: Option.getOrElse(flags.base, () => profile?.base),
      cpu: Option.getOrElse(flags.cpu, () => profile?.cpu),
      ramMib: Option.getOrElse(ram, () => profile?.ramMib),
      diskGib: Option.getOrElse(disk, () => profile?.diskGib),
      setup:
        source === undefined
          ? undefined
          : { script: yield* readSetup(source.path), ...source.timeout },
      profile: profile?.label,
    };

    // A field nobody set is left out, so the decode calls it missing.
    const spec = yield* decodeSpec(Record.filter(fields, Predicate.isNotUndefined), {
      onExcessProperty: "error",
      errors: "all",
    }).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `create: ${describeIssues(error, specFlags)}` }),
      ),
    );

    return { spec, host: Option.getOrElse(flags.host, () => profile?.host) };
  });

const create = Command.make("create", { ...mutationFlags, ...createArguments }, (flags) =>
  printResource(flags, {
    call: (client, config) =>
      Effect.flatMap(createRequest(flags, config), ({ spec, host }) =>
        client.create(flags.name, spec, { host }),
      ),
    encode: encodeMachine,
    text: newId,
  }),
).pipe(
  Command.withDescription(
    "Create a machine from a profile, from a base with sizes and an optional setup, or from both: each flag overrides the profile's field. A create that fails can leave its machine behind, unmade: get shows why, and delete removes it. Prints the new ID.",
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
).pipe(
  Command.withDescription(
    "Stop a machine: a power-off that keeps its disk and ends its processes. A stopped machine stays stopped, and the stop is still its last action.",
  ),
);

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
      text: (checkpoint, now) => table(checkpointFields(checkpoint, now)),
    }),
).pipe(
  Command.withDescription(
    "Read one checkpoint: its machine, the sizes a restore gives, its last action and the error it failed with.",
  ),
);

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
  capacity,
  machines,
  getMachine,
  profiles,
  create,
  start,
  stop,
  deleteMachine,
  fork,
  checkpoint,
  restore,
] as const;
