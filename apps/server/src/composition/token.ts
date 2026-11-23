import { Invalid } from "@gjermundgaraba/clankerbox-sdk";
import {
  isCallerName,
  mintToken,
  readCallers,
} from "@gjermundgaraba/clankerbox-sdk/node";
import { Console, Effect, FileSystem, Redacted } from "effect";
import { Argument, Command, Flag } from "effect/cli";

/**
 * Mints a token for `name`, appends its line to the callers file, made if absent, and answers the
 * token, which nothing keeps: a name already in the file, or a file that doesn't read as one, is
 * `Invalid` and changes nothing.
 */
export const addCaller = (
  callers: string,
  name: string
): Effect.Effect<Redacted.Redacted, Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!isCallerName(name)) {
      return yield* new Invalid({
        message: `the name ${name} isn't letters, digits, '.', '_' or '-', at most 64`,
      });
    }

    const text = (yield* fs
      .exists(callers)
      .pipe(Effect.orElseSucceed(() => false)))
      ? yield* fs.readFileString(callers).pipe(
          Effect.mapError(
            (error) =>
              new Invalid({
                message: `couldn't read callers ${callers}: ${error.message}`,
                file: callers,
              })
          )
        )
      : "";

    const holdsCallers = text
      .split("\n")
      .some((line) => line.trim() !== "" && !line.trim().startsWith("#"));

    if (holdsCallers) {
      const named = yield* readCallers(callers);

      if (named.some((caller) => caller.name === name)) {
        return yield* new Invalid({
          message: `callers ${callers} already names ${name}: delete its line first to give it a new token`,
          file: callers,
        });
      }
    }

    const { token, line } = mintToken(name);
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";

    yield* fs.writeFileString(callers, `${text}${separator}${line}\n`).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't write callers ${callers}: ${error.message}`,
            file: callers,
          })
      )
    );

    return token;
  });

const add = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription(
        "The caller's name, as the control plane's log names it: a person, laptop or provider."
      )
    ),
    callers: Flag.String("callers").pipe(
      Flag.withDescription(
        "The callers file the server config's `callers` names; made if absent."
      )
    ),
  },
  ({ name, callers }) =>
    Effect.gen(function* () {
      const token = yield* addCaller(callers, name);

      yield* Console.log(Redacted.value(token));
      yield* Console.error(
        `added ${name} to ${callers}. The token above is shown once: put it in a file the caller's config names as "token", and restart the control plane to take it.`
      );
    }).pipe(Effect.catch((error) => Effect.die(error.message)))
).pipe(
  Command.withDescription(
    "Mint a token for a caller, add its hash to a callers file, and print the token once."
  )
);

export const token = Command.make("token").pipe(
  Command.withDescription(
    "Manage the tokens of the callers a control plane takes."
  ),
  Command.withSubcommands([add])
);
