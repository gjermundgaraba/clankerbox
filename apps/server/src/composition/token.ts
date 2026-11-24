import {
  callerNameRefusal,
  describeFileError,
  Invalid,
  NotFound,
  tokenRows,
} from "@gjermundgaraba/clankerbox-sdk";
import { mintToken, parseCallers } from "@gjermundgaraba/clankerbox-sdk/node";
import {
  Console,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Redacted,
} from "effect";
import type { PlatformError } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import * as Sqlite from "../platform/sqlite.ts";
import type { TokenRow } from "../store.ts";
import { loadConfig } from "./config.ts";
import { minted, tokenOf } from "./tokens.ts";

/**
 * Mints a token for `name`, appends its line to the callers file, made if absent, and answers the
 * token, which nothing keeps. A name already in the file, or a file that doesn't read as one, is
 * `Invalid` and changes nothing. It appends rather than rewrites, so adds run at once keep each line.
 */
export const addCaller = (
  callers: string,
  name: string
): Effect.Effect<Redacted.Redacted, Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const misnamed = callerNameRefusal(name);

    if (misnamed !== undefined) {
      return yield* new Invalid({ message: misnamed });
    }

    const unreadable = (error: PlatformError.PlatformError) =>
      new Invalid({
        message: `couldn't read callers ${callers}: ${describeFileError(error)}`,
        file: callers,
      });

    const text = (yield* fs.exists(callers).pipe(Effect.mapError(unreadable)))
      ? yield* fs.readFileString(callers).pipe(Effect.mapError(unreadable))
      : "";

    const named = yield* parseCallers(callers, text);

    if (named.some((caller) => caller.name === name)) {
      return yield* new Invalid({
        message: `callers ${callers} already names ${name}: delete its line first to give it a new token`,
        file: callers,
      });
    }

    const { token, line } = mintToken("host", name);
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";

    yield* fs
      .writeFileString(callers, `${separator}${line}\n`, { flag: "a" })
      .pipe(
        Effect.mapError(
          (error) =>
            new Invalid({
              message: `couldn't write callers ${callers}: ${describeFileError(error)}`,
              file: callers,
            })
        )
      );

    return token;
  });

const stoppedStore = (config: string, made: "made if absent" | "must exist") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stateDir } = yield* loadConfig(config);
    const file = `${stateDir}/${Sqlite.databaseFile}`;

    if (
      made === "must exist" &&
      !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* new Invalid({
        message: `${file} doesn't exist, so ${config} names no control plane that has run or had a token added: check --config`,
      });
    }

    return yield* Sqlite.open({ stateDir }).pipe(
      Effect.catchTag("CannotStart", (error) =>
        Effect.fail(
          new Invalid({
            message:
              error.held === true
                ? `${error.message}: stop it first, as token add, list and revoke --config each need it stopped, or manage the running one with \`clankerbox token\``
                : error.message,
          })
        )
      )
    );
  });

/** Mints a token for `name` into a stopped control plane's store, and answers it. */
export const addToken = (config: string, name: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const misnamed = callerNameRefusal(name);

      if (misnamed !== undefined) {
        return yield* new Invalid({ message: misnamed });
      }

      const store = yield* stoppedStore(config, "made if absent");
      const { row, token } = yield* minted(name, undefined);

      yield* store.insertToken(row);

      return token;
    })
  );

/** Every token in a stopped control plane's store, revoked ones included. */
export const listTokensOffline = (config: string) =>
  Effect.scoped(
    Effect.flatMap(stoppedStore(config, "must exist"), (store) => store.tokens)
  );

/** Revokes a token in a stopped control plane's store, and answers its row. */
export const revokeTokenOffline = (config: string, name: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* stoppedStore(config, "must exist");
      const revoked = yield* store.revokeToken(name, yield* DateTime.now);

      return yield* Effect.fromOption(revoked).pipe(
        Effect.mapError(
          () => new NotFound({ message: `no token ${name}`, id: name })
        )
      );
    })
  );

const configFlag = Flag.String("config").pipe(
  Flag.withDescription(
    "The control plane's config, whose store holds its tokens. The control plane must be stopped."
  )
);

const printTokens = (rows: readonly TokenRow[]) =>
  Effect.forEach(
    tokenRows(rows.map(tokenOf)),
    (cells) => Console.log(cells.join("\t")),
    { discard: true }
  );

const list = Command.make("list", { config: configFlag }, ({ config }) =>
  Effect.gen(function* () {
    yield* printTokens(yield* listTokensOffline(config));
  }).pipe(Effect.catch((error) => Effect.die(error.message)))
).pipe(
  Command.withDescription(
    "List every token in a stopped control plane's store, revoked ones and who minted each included."
  )
);

const revoke = Command.make(
  "revoke",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("The name of the token to revoke.")
    ),
    config: configFlag,
  },
  ({ name, config }) =>
    Effect.gen(function* () {
      yield* printTokens([yield* revokeTokenOffline(config, name)]);
    }).pipe(Effect.catch((error) => Effect.die(error.message)))
).pipe(
  Command.withDescription(
    "Revoke a token in a stopped control plane's store, so it is refused once the control plane starts."
  )
);

const add = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription(
        "The caller's name: a person, laptop or provider."
      )
    ),
    config: Flag.String("config").pipe(
      Flag.withDescription(
        "The control plane's config: the token goes into its store. The control plane must be stopped."
      ),
      Flag.optional
    ),
    callers: Flag.String("callers").pipe(
      Flag.withDescription(
        "A host's callers file, made if absent: the token's hash is appended to it."
      ),
      Flag.optional
    ),
  },
  ({ name, config, callers }) =>
    Effect.gen(function* () {
      if (Option.isSome(config) === Option.isSome(callers)) {
        return yield* new Invalid({
          message:
            "give token add either --config, for a control plane's caller, or --callers, for a host's",
        });
      }

      if (Option.isSome(config)) {
        const token = yield* addToken(config.value, name);

        yield* Console.log(Redacted.value(token));

        return yield* Console.error(
          `added ${name} to the control plane ${config.value} configures. The token above is shown once: put it in a file the caller's config names as "token".`
        );
      }

      const file = Option.getOrThrow(callers);
      const token = yield* addCaller(file, name);

      yield* Console.log(Redacted.value(token));
      yield* Console.error(
        `added ${name} to ${file}. The token above is shown once: put it in a file the control plane's config names as this host's "token", and restart the host to take it.`
      );
    }).pipe(Effect.catch((error) => Effect.die(error.message)))
).pipe(
  Command.withDescription(
    "Mint a token, and print it once: for a control plane's caller into its store, or for a host into its callers file."
  )
);

export const token = Command.make("token").pipe(
  Command.withDescription(
    "Mint the tokens a control plane and its hosts take, and list and revoke a stopped control plane's."
  ),
  Command.withSubcommands([add, list, revoke])
);
