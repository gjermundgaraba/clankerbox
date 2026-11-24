import {
  callerNameRule,
  describeFileError,
  Invalid,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  isCallerName,
  mintToken,
  parseCallers,
} from "@gjermundgaraba/clankerbox-sdk/node";
import { Console, Effect, FileSystem, Option, Redacted } from "effect";
import type { PlatformError } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import * as Sqlite from "../platform/sqlite.ts";
import { loadConfig } from "./config.ts";
import { minted } from "./tokens.ts";

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

    if (!isCallerName(name)) {
      return yield* new Invalid({
        message: `the name ${name} isn't ${callerNameRule}`,
      });
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

    const { token, line } = mintToken(name);
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

/**
 * Mints a token for `name` into the store of the control plane `config` names,
 * and answers it. It opens the store as the control plane does, so it refuses while one runs: a
 * running control plane mints through any token it takes instead.
 */
export const addToken = (config: string, name: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!isCallerName(name)) {
        return yield* new Invalid({
          message: `the name ${name} isn't ${callerNameRule}`,
        });
      }

      const { stateDir } = yield* loadConfig(config);

      const store = yield* Sqlite.open({ stateDir }).pipe(
        Effect.catchTag("CannotStart", (error) =>
          Effect.fail(
            new Invalid({
              message: `${error.message}: stop it to add a token here, or mint one with \`clankerbox token mint\` through a token it takes`,
            })
          )
        )
      );

      const { row, token } = yield* minted(name, undefined);

      yield* store.insertToken(row);

      return token;
    })
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
        "The control plane's config: the token goes into its store, managing tokens. The control plane must be stopped."
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
    "Mint the tokens a control plane and its hosts take."
  ),
  Command.withSubcommands([add])
);
