/**
 * The CLI's own kit, which every command uses: the client flags, the run against the configured
 * hosts, and how results and failures print. Every command takes IDs, except `create`, which
 * takes a name or a full ID. A mutation returns when its action has finished; its `--timeout`
 * only stops waiting.
 */
import { type ClankerboxError, Client, ErrorTag, Invalid } from "@gjermundgaraba/clankerbox-sdk";
import {
  Console,
  Data,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Runtime,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { parseSeconds } from "./units.ts";

/** A failure the CLI has already printed. The process exits with `code`. */
export class Exited extends Data.TaggedError("Exited")<{ readonly code: number }> {
  readonly [Runtime.errorReported] = false;

  get [Runtime.errorExitCode](): number {
    return this.code;
  }
}

/** A failure as `--json` prints it. */
export const ErrorDocument = Schema.Struct({
  message: Schema.String,
  tag: ErrorTag,
  retryable: Schema.Boolean,
});

/** A host a fan-out couldn't read, as `--json` lists it under `unreachable`. */
export const UnreachableDocument = Schema.Struct({ host: Schema.String, error: ErrorDocument });

const errorDocument = (error: ClankerboxError): typeof ErrorDocument.Type => ({
  message: error.message,
  tag: error._tag,
  retryable: error.retryable,
});

/** Prints `error` (as `{error: {message, tag, retryable}}` with `--json`) and exits 1. */
export const fail = (json: boolean) => (error: ClankerboxError) =>
  Effect.andThen(
    json
      ? Console.log(JSON.stringify({ error: errorDocument(error) }))
      : Console.error(`clankerbox: ${error._tag}: ${error.message}`),
    Effect.fail(new Exited({ code: 1 })),
  );

/** Left-aligned columns, two spaces apart. */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths: Array<number> = [];

  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }

  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
};

/** The hosts a fan-out couldn't read, as JSON fields. */
export const unreachableDocument = (
  unreachable: ReadonlyArray<Client.Unreachable>,
): ReadonlyArray<typeof UnreachableDocument.Type> =>
  unreachable.map(({ host, error }) => ({ host, error: errorDocument(error) }));

/** Names the hosts a fan-out couldn't read, on stderr, under the table. */
export const warnUnreachable = (unreachable: ReadonlyArray<Client.Unreachable>) =>
  Effect.forEach(
    unreachable,
    ({ error }) => Console.error(`clankerbox: ${error._tag}: ${error.message}`),
    { discard: true },
  );

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
export const mutationFlags = {
  ...clientFlags,
  timeout: Flag.String("timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "Stop waiting for the mutation's reply after this long, such as 90s or 10m; unbounded by default. It cancels nothing on the host.",
    ),
    Flag.optional,
  ),
};

export type ClientFlags = Command.Command.Config.Infer<typeof clientFlags> & {
  readonly timeout?: Option.Option<string>;
};

/** A flag's value, parsed when the flag was given. */
export const parsed = <A>(
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

export const print = (json: boolean, document: () => object, text: () => string) =>
  json ? Console.log(JSON.stringify(document())) : Console.log(text());

export const machineArgument = Argument.String("machine").pipe(
  Argument.withDescription("The machine's ID, <host>_<name>."),
);

export const checkpointArgument = Argument.String("checkpoint").pipe(
  Argument.withDescription("The checkpoint's ID, <host>_<name>."),
);

export const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("The new resource's name, on the same host."),
);

/**
 * A list over every host: a table, or with `--json` the answers under `key`. With nothing to
 * list, stdout stays empty and stderr says so. The hosts that didn't answer go to stderr,
 * or to `unreachable` with `--json`. When every host failed, the command exits 1, as a failed
 * call does; a partial answer exits 0.
 */
export const listCommand = <A, Encoded>(options: {
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

/**
 * The body of a command that makes one client call and prints the resource it replies with:
 * its JSON document with `--json`, or else `text`.
 */
export const printResource = <A, Encoded extends object, R>(
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
export const newId = ({ id }: { readonly id: string }) => id;

/**
 * Deleting what is already gone is done: the host answers NotFound, the CLI says so on stderr,
 * and exits 0. Either way `--json` prints `{deleted: id}`.
 */
export const deleted = (json: boolean, id: string, removal: Effect.Effect<void, ClankerboxError>) =>
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
