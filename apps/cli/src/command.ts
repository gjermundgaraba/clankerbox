import {
  Client,
  clankerboxErrors,
  Invalid,
  retryable,
} from "@gjermundgaraba/clankerbox-sdk";
import type { ClankerboxError, Labels } from "@gjermundgaraba/clankerbox-sdk";
import type { FileSystem, Path } from "effect";
import {
  Console,
  Data,
  DateTime,
  Duration,
  Effect,
  Match,
  Option,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import { loadConfig } from "./config.ts";
import { syncSshConfig } from "./ssh-config.ts";
import { parseSeconds } from "./units.ts";

export class Exited extends Data.TaggedError("Exited")<{
  readonly code: number;
}> {
  override readonly [Runtime.errorReported] = false;

  override get [Runtime.errorExitCode](): number {
    return this.code;
  }
}

export class SpawnFailed extends Schema.TaggedError<
  SpawnFailed,
  { readonly brand: unique symbol }
>()("SpawnFailed", {
  message: Schema.String,
  program: Schema.String,
}) {}

const failures = [...clankerboxErrors, SpawnFailed] as const;

const Failure = Schema.Union(failures);

export type Failure = typeof Failure.Type;

const encodeFailure = Schema.encodeSync(Failure);

export const ErrorDocument = Schema.Union(
  failures.map(({ fields: { _tag, ...fields } }) =>
    Schema.Struct({ ...fields, tag: _tag, retryable: Schema.Boolean })
  )
);

const errorDocument = (error: Failure) => {
  const { _tag, ...fields } = encodeFailure(error);

  return {
    ...fields,
    tag: _tag,
    retryable: Match.value(error).pipe(
      Match.tag("SpawnFailed", () => false),
      Match.orElse(retryable)
    ),
  };
};

export const failText = (error: {
  readonly _tag: string;
  readonly message: string;
}) =>
  Effect.andThen(
    Console.error(`clankerbox: ${error._tag}: ${error.message}`),
    Effect.fail(new Exited({ code: 1 }))
  );

export const fail = (json: boolean) => (error: Failure) =>
  json
    ? Effect.andThen(
        Console.log(JSON.stringify({ error: errorDocument(error) })),
        Effect.fail(new Exited({ code: 1 }))
      )
    : failText(error);

export const table = (rows: ReadonlyArray<readonly string[]>): string => {
  const widths: number[] = [];

  for (const row of rows) {
    for (const [column, cell] of row.entries()) {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    }
  }

  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)
        )
        .join("  ")
    )
    .join("\n");
};

export const clientFlags = {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription(
      "Print JSON: the result, or {error}: the error's fields, its tag and whether it is retryable."
    ),
    Flag.withDefault(false)
  ),
  config: Flag.String("config").pipe(
    Flag.withDescription(
      "The client config file. Default: $XDG_CONFIG_HOME/clankerbox/config.json."
    ),
    Flag.optional
  ),
};

export const mutationFlags = {
  ...clientFlags,
  timeout: Flag.String("timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "Stop waiting for the machine, checkpoint or build to rest after this long, such as 90s or 10m; unbounded by default. The request stays saved and still acts."
    ),
    Flag.optional
  ),
  noWait: Flag.Boolean("no-wait").pipe(
    Flag.withDescription(
      "Answer once the control plane has recorded the request, without waiting for it to act."
    ),
    Flag.withDefault(false)
  ),
};

export type ClientFlags = Command.Command.Config.Infer<typeof clientFlags> & {
  readonly timeout?: Option.Option<string>;
  readonly noWait?: boolean;
};

export const parsed = <A>(
  flag: Option.Option<string>,
  name: string,
  parse: (name: string, text: string) => Effect.Effect<A, Invalid>
) => Effect.transposeOption(Option.map(flag, (text) => parse(name, text)));

const pairPattern = /^(?<key>[^=]+)=(?<value>.*)$/su;

export const parsePairs = (
  flag: string,
  texts: readonly string[]
): Effect.Effect<Record<string, string> | undefined, Invalid> =>
  Effect.gen(function* () {
    if (texts.length === 0) {
      return undefined;
    }

    const pairs: Record<string, string> = {};

    for (const text of texts) {
      const { key, value } = pairPattern.exec(text)?.groups ?? {};

      if (key === undefined || value === undefined) {
        return yield* new Invalid({
          message: `${flag} ${JSON.stringify(text)} isn't a KEY=VALUE pair`,
        });
      }

      pairs[key] = value;
    }

    return pairs;
  });

export const labelFlag = Flag.String("label").pipe(
  Flag.withMetavar("KEY=VALUE"),
  Flag.withDescription(
    "A label to carry, to find it by; repeat for more. Labels are set when the resource is made."
  ),
  Flag.atLeast(0)
);

export const labelFilterFlag = Flag.String("label").pipe(
  Flag.withMetavar("KEY=VALUE"),
  Flag.withDescription(
    "List only what carries this label, with this value; repeat to require more."
  ),
  Flag.atLeast(0)
);

export const labelled = (
  texts: readonly string[]
): Effect.Effect<{ readonly labels?: Labels }, Invalid> =>
  Effect.map(parsePairs("--label", texts), (labels) =>
    labels === undefined ? {} : { labels }
  );

export const expiresFlag = Flag.String("expires").pipe(
  Flag.withMetavar("DURATION"),
  Flag.withDescription(
    "Delete the checkpoint this long after now, such as 7d or 12h, once it is ready."
  ),
  Flag.optional
);

export const expiring = (
  flag: Option.Option<string>
): Effect.Effect<{ readonly expiresAt?: DateTime.Utc }, Invalid> =>
  Effect.gen(function* () {
    const seconds = yield* parsed(flag, "--expires", parseSeconds);

    if (Option.isNone(seconds)) {
      return {};
    }

    return {
      expiresAt: DateTime.addDuration(
        yield* DateTime.now,
        Duration.seconds(seconds.value)
      ),
    };
  });

export const pairsText = (
  pairs: Readonly<Record<string, string>> | undefined
): string =>
  pairs === undefined || Object.keys(pairs).length === 0
    ? "-"
    : Object.entries(pairs)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");

export const readStdin: Effect.Effect<string, Invalid, Stdio.Stdio> =
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    return yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({ message: `couldn't read stdin: ${error.message}` })
      )
    );
  });

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

export const withClient = <A, R>(
  flags: ClientFlags,
  body: (
    client: Client.Interface
  ) => Effect.Effect<A, ClankerboxError | Invalid, R>
): Effect.Effect<A, Exited, R | Services> =>
  Effect.gen(function* () {
    const timeout = yield* parsed(
      flags.timeout ?? Option.none(),
      "--timeout",
      parseSeconds
    );

    const config = yield* loadConfig(flags.config);

    const client = yield* Client.make(config.server, {
      timeout: Option.getOrUndefined(Option.map(timeout, Duration.seconds)),
      noWait: flags.noWait,
    }).pipe(
      Effect.mapError(
        ({ message }) => new Invalid({ message, file: config.file })
      )
    );

    if (Option.isNone(flags.config)) {
      yield* syncSshConfig;
    }

    return yield* body(client);
  }).pipe(Effect.catch(fail(flags.json)));

export const print = (
  json: boolean,
  document: () => object,
  text: () => string
) => (json ? Console.log(JSON.stringify(document())) : Console.log(text()));

export const machineArgument = Argument.String("machine").pipe(
  Argument.withDescription("The machine's name.")
);

export const checkpointArgument = Argument.String("checkpoint").pipe(
  Argument.withDescription("The checkpoint's name.")
);

export const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("The new resource's name.")
);

interface Listing<A> {
  readonly key: string;
  readonly encode: (answer: A) => object;
  readonly rows: (answers: readonly A[], now: DateTime.Utc) => string[][];
}

export const printList = <A>(
  json: boolean,
  listing: Listing<A>,
  answers: readonly A[]
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;

    if (json) {
      yield* Console.log(
        JSON.stringify({
          [listing.key]: answers.map((answer) => listing.encode(answer)),
        })
      );
    } else if (answers.length > 0) {
      yield* Console.log(table(listing.rows(answers, now)));
    } else {
      yield* Console.error(`clankerbox: no ${listing.key} to list`);
    }
  });

export const listCommand = <A>(
  options: Listing<A> & {
    readonly name: string;
    readonly description: string;
    readonly read: (
      client: Client.Interface
    ) => Effect.Effect<readonly A[], ClankerboxError>;
  }
) =>
  Command.make(options.name, clientFlags, (flags) =>
    withClient(flags, (client) =>
      Effect.flatMap(options.read(client), (answers) =>
        printList(flags.json, options, answers)
      )
    )
  ).pipe(Command.withDescription(options.description));

export const filteredListCommand = <A>(
  options: Listing<A> & {
    readonly name: string;
    readonly description: string;
    readonly read: (
      client: Client.Interface,
      filter: { readonly labels?: Labels }
    ) => Effect.Effect<readonly A[], ClankerboxError>;
  }
) =>
  Command.make(
    options.name,
    { ...clientFlags, label: labelFilterFlag },
    (flags) =>
      withClient(flags, (client) =>
        Effect.gen(function* () {
          const filter = yield* labelled(flags.label);
          const answers = yield* options.read(client, filter);

          yield* printList(flags.json, options, answers);
        })
      )
  ).pipe(Command.withDescription(options.description));

export const printResource = <A, R>(
  flags: ClientFlags,
  resource: {
    readonly call: (
      client: Client.Interface
    ) => Effect.Effect<A, ClankerboxError | Invalid, R>;
    readonly encode: (resource: A) => object;
    readonly text: (resource: A, now: DateTime.Utc) => string;
  }
) =>
  withClient(flags, (client) =>
    Effect.gen(function* () {
      const replied = yield* resource.call(client);
      const now = yield* DateTime.now;

      yield* print(
        flags.json,
        () => resource.encode(replied),
        () => resource.text(replied, now)
      );
    })
  );

export const newId = ({ id }: { readonly id: string }) => id;

export const deleted = (
  json: boolean,
  id: string,
  removal: Effect.Effect<Client.Deleted, ClankerboxError>
) =>
  removal.pipe(
    Effect.flatMap((outcome) =>
      outcome === "absent" && !json
        ? Console.error(`clankerbox: ${id} was already gone`)
        : print(
            json,
            () => ({ deleted: id }),
            () => id
          )
    )
  );
