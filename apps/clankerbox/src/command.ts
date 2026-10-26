import {
  type ClankerboxError,
  Client,
  hostErrors,
  Invalid,
  retryable,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Console,
  Data,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  Runtime,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { syncSshConfig } from "./ssh-config.ts";
import { parseSeconds } from "./units.ts";

export class Exited extends Data.TaggedError("Exited")<{ readonly code: number }> {
  override readonly [Runtime.errorReported] = false;

  override get [Runtime.errorExitCode](): number {
    return this.code;
  }
}

export class SpawnFailed extends Schema.TaggedError<SpawnFailed>()("SpawnFailed", {
  message: Schema.String,
  program: Schema.String,
}) {}

const failures = [...hostErrors, Unavailable, SpawnFailed] as const;

const Failure = Schema.Union(failures);

export type Failure = typeof Failure.Type;

const encodeFailure = Schema.encodeSync(Failure);

export const ErrorDocument = Schema.Union(
  failures.map(({ fields: { _tag, ...fields } }) =>
    Schema.Struct({ ...fields, tag: _tag, retryable: Schema.Boolean }),
  ),
);

export const UnreachableDocument = Schema.Struct({ host: Schema.String, error: ErrorDocument });

const errorDocument = (error: Failure) => {
  const { _tag, ...fields } = encodeFailure(error);

  return {
    ...fields,
    tag: _tag,
    retryable: Match.value(error).pipe(
      Match.tag("SpawnFailed", () => false),
      Match.orElse(retryable),
    ),
  };
};

export const failText = (error: { readonly _tag: string; readonly message: string }) =>
  Effect.andThen(
    Console.error(`clankerbox: ${error._tag}: ${error.message}`),
    Effect.fail(new Exited({ code: 1 })),
  );

export const fail = (json: boolean) => (error: Failure) =>
  json
    ? Effect.andThen(
        Console.log(JSON.stringify({ error: errorDocument(error) })),
        Effect.fail(new Exited({ code: 1 })),
      )
    : failText(error);

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

export const unreachableDocument = (unreachable: ReadonlyArray<Client.Unreachable>) =>
  unreachable.map(({ host, error }) => ({ host, error: errorDocument(error) }));

export const warnUnreachable = (unreachable: ReadonlyArray<Client.Unreachable>) =>
  Effect.forEach(
    unreachable,
    ({ error }) => Console.error(`clankerbox: ${error._tag}: ${error.message}`),
    { discard: true },
  );

export const clientFlags = {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription(
      "Print JSON: the result, or {error}: the error's fields, its tag and whether it is retryable.",
    ),
    Flag.withDefault(false),
  ),
  config: Flag.String("config").pipe(
    Flag.withDescription(
      "The client config file. Default: $XDG_CONFIG_HOME/clankerbox/config.json.",
    ),
    Flag.optional,
  ),
};

export const mutationFlags = {
  ...clientFlags,
  timeout: Flag.String("timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "Stop waiting for the mutation's reply after this long, such as 90s or 10m; unbounded by default. A mutation under way still finishes on the host, except a command an exec runs, which ends with the wait.",
    ),
    Flag.optional,
  ),
};

export type ClientFlags = Command.Command.Config.Infer<typeof clientFlags> & {
  readonly timeout?: Option.Option<string>;
};

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

export const withClient = <A, R>(
  flags: ClientFlags,
  body: (
    client: Client.Interface,
    config: LoadedConfig,
  ) => Effect.Effect<A, ClankerboxError | Invalid, R>,
): Effect.Effect<A, Exited, R | Services> =>
  Effect.gen(function* () {
    const timeout = yield* parsed(flags.timeout ?? Option.none(), "--timeout", parseSeconds);
    const config = yield* loadConfig(flags.config);

    const client = yield* Client.make(config.hosts, {
      timeout: Option.getOrUndefined(Option.map(timeout, Duration.seconds)),
    }).pipe(Effect.mapError(({ message }) => new Invalid({ message, file: config.file })));

    if (Option.isNone(flags.config)) {
      yield* syncSshConfig(config);
    }

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

export const listCommand = <A, Encoded>(options: {
  readonly name: string;
  readonly description: string;
  readonly key: string;
  readonly read: (client: Client.Interface) => Effect.Effect<Client.Gathered<A>>;
  readonly encode: (answer: A) => Encoded;
  readonly rows: (answers: ReadonlyArray<A>, now: DateTime.Utc) => Array<Array<string>>;
  /** Printed to stderr under the table. */
  readonly notes?: (answers: ReadonlyArray<A>) => ReadonlyArray<string>;
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

          for (const note of options.notes?.(answers) ?? []) {
            yield* Console.error(`clankerbox: ${note}`);
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

export const printResource = <A, Encoded extends object, R>(
  flags: ClientFlags,
  resource: {
    readonly call: (
      client: Client.Interface,
      config: LoadedConfig,
    ) => Effect.Effect<A, ClankerboxError | Invalid, R>;
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

export const newId = ({ id }: { readonly id: string }) => id;

export const deleted = (
  json: boolean,
  id: string,
  removal: Effect.Effect<Client.Deleted, ClankerboxError>,
) =>
  removal.pipe(
    Effect.flatMap((outcome) =>
      outcome === "absent" && !json
        ? Console.error(`clankerbox: ${id} was already gone`)
        : print(
            json,
            () => ({ deleted: id }),
            () => id,
          ),
    ),
  );
