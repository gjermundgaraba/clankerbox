/**
 * Setup scripts for create. A host receives one script: a file is sent as its text, and a
 * recipe directory (a `setup.sh` and the files it needs) is packed into one self-extracting
 * script. Nothing here logs a script or a packed recipe: a recipe can carry secrets.
 */
import { Effect, FileSystem, Option, type PlatformError, Predicate } from "effect";
import { Invalid } from "./errors.ts";
import { describeFileError } from "./text.ts";

const lineLength = 76;

/** base64 has no `_`, so no line of a file's payload can end its here-document early. */
const terminator = "CLANKERBOX_RECIPE";

const wrap = (base64: string): string => {
  const lines: Array<string> = [];

  for (let at = 0; at < base64.length; at += lineLength) {
    lines.push(base64.slice(at, at + lineLength));
  }

  return lines.join("\n");
};

/** A string as one single-quoted shell word, whatever it holds. */
const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * An entry's path as a command's argument: under `./`, so a name that starts with `-` is never
 * read as an option.
 */
const argument = (entry: string): string => quote(`./${entry}`);

/** Any execute bit, which is the one bit of a mode a recipe carries, as git does. */
const executable = 0o111;

/**
 * Makes the recipe's files in a fresh directory, then runs `./setup.sh` from there: its `#!`
 * line picks the interpreter, as for a single-file setup, and the unpacker marks it executable
 * whatever mode it was packed with. The directory is under `/var/tmp`, as a single-file setup
 * is, which nothing mounts `noexec`, and is removed however setup ends. Setup runs as a child
 * rather than through `exec`, so the cleanup trap still runs after it.
 */
const selfExtracting = (steps: ReadonlyArray<string>): string =>
  [
    "#!/bin/sh",
    "set -eu",
    "recipe=$(mktemp -d /var/tmp/clankerbox-recipe.XXXXXX)",
    `trap 'rm -rf "$recipe"' EXIT`,
    "trap 'exit 1' HUP INT TERM",
    'cd "$recipe"',
    ...steps,
    "chmod +x setup.sh",
    "./setup.sh",
    "",
  ].join("\n");

/**
 * Packs a recipe directory into one self-extracting script, which makes each of its entries
 * with plain shell: a directory with `mkdir`, a symlink with `ln -s` as it is, and a file from
 * base64, made executable when any of its execute bits is set. A symlink is never walked into,
 * so nothing outside the recipe is packed, and in the guest nothing is written through one.
 * Of a mode only the execute bit is kept, as git keeps it, so a checkout's umask changes
 * nothing. Entries go in sorted order and nothing records a time or an owner, so the same
 * files pack into the same script: a prebuild is named after it.
 */
export const packRecipe = (
  directory: string,
): Effect.Effect<string, Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const noSetup = new Invalid({ message: `recipe ${directory} has no setup.sh` });

    const setup = yield* fs
      .stat(`${directory}/setup.sh`)
      .pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error.reason, "NotFound") ? noSetup : error,
        ),
      );

    if (setup.type !== "File") {
      return yield* noSetup;
    }

    const steps: Array<string> = [];

    /** Packs the entries of the recipe's directory `under`, `""` being the recipe itself. */
    const walk = (under: string): Effect.Effect<void, Invalid | PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(under === "" ? directory : `${directory}/${under}`);

        for (const name of names.toSorted()) {
          const entry = under === "" ? name : `${under}/${name}`;
          const path = `${directory}/${entry}`;
          const link = yield* Effect.option(fs.readLink(path));

          if (Option.isSome(link)) {
            steps.push(`ln -s -- ${quote(link.value)} ${argument(entry)}`);
            continue;
          }

          const info = yield* fs.stat(path);

          if (info.type === "Directory") {
            steps.push(`mkdir ${argument(entry)}`);
            yield* walk(entry);
          } else if (info.type === "File") {
            steps.push(
              `base64 -d >${argument(entry)} <<'${terminator}'`,
              wrap(Buffer.from(yield* fs.readFile(path)).toString("base64")),
              terminator,
            );

            if ((info.mode & executable) !== 0) {
              steps.push(`chmod +x ${argument(entry)}`);
            }
          } else {
            return yield* new Invalid({
              message: `recipe ${directory} holds ${entry}, a ${info.type}: a recipe packs only files, directories and symlinks`,
            });
          }
        }
      });

    yield* walk("");

    return selfExtracting(steps);
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new Invalid({
          message: `couldn't pack recipe ${directory}: ${describeFileError(error)}`,
        }),
      ),
    ),
  );

/** Reads a setup: a script file's text, or a recipe directory packed into one script. */
export const readSetup = (path: string): Effect.Effect<string, Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);

    if (info.type === "Directory") {
      return yield* packRecipe(path);
    }

    return yield* fs.readFileString(path);
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new Invalid({ message: `couldn't read setup ${path}: ${describeFileError(error)}` }),
      ),
    ),
  );
