/**
 * Setup scripts for create. A host receives one script: a file is sent as its text, and a
 * recipe directory (a `setup.sh` and the files it needs) is packed into one self-extracting
 * script. Nothing here logs a script or a packed recipe: a recipe can carry secrets.
 */
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Invalid } from "./errors.ts";

const lineLength = 76;

/** base64 has no `_`, so no line of the payload can end the here-document early. */
const terminator = "CLANKERBOX_RECIPE";

const wrap = (base64: string): string => {
  const lines: Array<string> = [];

  for (let at = 0; at < base64.length; at += lineLength) {
    lines.push(base64.slice(at, at + lineLength));
  }

  return lines.join("\n");
};

/**
 * Unpacks into a fresh temporary directory, runs `/bin/sh ./setup.sh` from there, and
 * removes the directory however setup ends. Setup runs as a child rather than through
 * `exec`, so the cleanup trap still runs after it. `--no-same-owner` keeps the packer's
 * uid off the files when root unpacks them in the guest.
 */
const selfExtracting = (archive: string): string =>
  [
    "#!/bin/sh",
    "set -eu",
    "recipe=$(mktemp -d)",
    `trap 'rm -rf "$recipe"' EXIT`,
    "trap 'exit 1' HUP INT TERM",
    `base64 -d >"$recipe/recipe.tar" <<'${terminator}'`,
    wrap(archive),
    terminator,
    'tar -x -f "$recipe/recipe.tar" --no-same-owner -C "$recipe"',
    'rm "$recipe/recipe.tar"',
    'cd "$recipe"',
    "/bin/sh ./setup.sh",
    "",
  ].join("\n");

/**
 * Packs a recipe directory into one self-extracting script: a base64 tar that unpacks into a
 * temporary directory, then runs `setup.sh` from there. `COPYFILE_DISABLE=1` and
 * `--no-xattrs` keep macOS `tar` from adding `._*` files and provenance headers.
 */
export const packRecipe = (
  directory: string,
): Effect.Effect<
  string,
  Invalid,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const setup = yield* fs
      .stat(`${directory}/setup.sh`)
      .pipe(Effect.mapError(() => new Invalid({ message: `recipe ${directory} has no setup.sh` })));

    if (setup.type !== "File" || setup.size === 0n) {
      return yield* new Invalid({
        message: `recipe ${directory}'s setup.sh must be a nonempty file`,
      });
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const tar = yield* spawner.spawn(
      ChildProcess.make("tar", ["--no-xattrs", "-c", "-f", "-", "-C", directory, "."], {
        env: { COPYFILE_DISABLE: "1" },
        extendEnv: true,
        stdin: "ignore",
      }),
    );

    const [archive, errors, code] = yield* Effect.all(
      [
        Stream.mkUint8Array(tar.stdout),
        Stream.mkString(Stream.decodeText(tar.stderr)),
        tar.exitCode,
      ],
      { concurrency: "unbounded" },
    );

    if (code !== 0) {
      return yield* new Invalid({
        message: `tar couldn't pack recipe ${directory} (exit ${code}): ${errors.trim()}`,
      });
    }

    return selfExtracting(
      Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength).toString("base64"),
    );
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new Invalid({ message: `couldn't pack recipe ${directory}: ${error.message}` })),
    ),
  );

/** Reads a setup: a script file's text, or a recipe directory packed into one script. */
export const readSetup = (
  path: string,
): Effect.Effect<
  string,
  Invalid,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);

    if (info.type === "Directory") {
      return yield* packRecipe(path);
    }

    return yield* fs.readFileString(path);
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new Invalid({ message: `couldn't read setup ${path}: ${error.message}` })),
    ),
  );
