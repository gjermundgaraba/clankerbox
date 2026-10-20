import { Effect, FileSystem, Option, type PlatformError, Predicate, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { Invalid } from "./errors.ts";
import { describeFileError, describeIssues } from "./describe.ts";
import { PublicKeys } from "./resources.ts";

const lineLength = 76;

const terminator = "CLANKERBOX_RECIPE";

const wrap = (base64: string): string => {
  const lines: Array<string> = [];

  for (let at = 0; at < base64.length; at += lineLength) {
    lines.push(base64.slice(at, at + lineLength));
  }

  return lines.join("\n");
};

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const argument = (entry: string): string => quote(`./${entry}`);

const executable = 0o111;

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
 * Packs a recipe directory, a `setup.sh` and the files it needs, into one self-extracting script.
 * Symlinks are recreated as they are and never walked into. The same files always pack into the
 * same script, as a prebuild is named after it.
 */
export const packRecipe = (
  directory: string,
): Effect.Effect<string, Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const noSetup = new Invalid({
      message: `recipe ${directory} has no setup.sh`,
      file: directory,
    });

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
              wrap(Base64.encode(yield* fs.readFile(path))),
              terminator,
            );

            if ((info.mode & executable) !== 0) {
              steps.push(`chmod +x ${argument(entry)}`);
            }
          } else {
            return yield* new Invalid({
              message: `recipe ${directory} holds ${entry}, a ${info.type}: a recipe packs only files, directories and symlinks`,
              file: path,
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
          file: directory,
        }),
      ),
    ),
  );

/** A script file's text, or a recipe directory packed into one script. */
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
        new Invalid({
          message: `couldn't read setup ${path}: ${describeFileError(error)}`,
          file: path,
        }),
      ),
    ),
  );

const decodePublicKeys = Schema.decodeUnknownEffect(PublicKeys);

/**
 * A public-key file's text, such as `~/.ssh/id_ed25519.pub`'s, for a setup's `authorizedKeys`, with
 * its line endings as `\n`.
 */
export const readAuthorizedKeys = (
  path: string,
): Effect.Effect<string, Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't read authorized keys ${path}: ${describeFileError(error)}`,
            file: path,
          }),
      ),
    );

    return yield* decodePublicKeys(text.replaceAll("\r\n", "\n")).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({ message: `authorized keys ${path}: ${describeIssues(error)}`, file: path }),
      ),
    );
  });
