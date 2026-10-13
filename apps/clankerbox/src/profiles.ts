/** Profile files: where `--profile` finds them, and `clankerbox profiles`, which lists them. */
import {
  describeFileError,
  formatGib,
  formatMib,
  Invalid,
  InvalidFile,
  type LoadedProfile,
  loadProfile,
  Profile,
} from "@gjermundgaraba/clankerbox-sdk";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { Command } from "effect/cli";
import { clientFlags, fail, print, table } from "./command.ts";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { formatSeconds } from "./units.ts";

/**
 * The profile file `--profile` names: a path when it has a `/` or ends in `.json`, or else a
 * name looked up as `NAME.json` in the config's profiles directory.
 */
export const profileFile = (
  config: LoadedConfig,
  profile: string,
): Effect.Effect<string, Invalid, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    if (profile.includes("/") || profile.endsWith(".json")) {
      return path.resolve(profile);
    }

    if (config.profiles === undefined) {
      return yield* new Invalid({
        message: `profile ${profile} is a name, and the client config has no profiles directory; pass a path`,
      });
    }

    return path.join(config.profiles, `${profile}.json`);
  });

/**
 * The config's profiles directory and the profile files in it, `NAME.json` each, in name
 * order.
 */
export const profileFiles = (
  config: LoadedConfig,
): Effect.Effect<
  { readonly directory: string; readonly files: Array<string> },
  InvalidFile,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = config.profiles;

    if (directory === undefined) {
      return yield* new InvalidFile({
        message: "the client config has no profiles directory",
        file: config.file,
      });
    }

    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError(
        (error) =>
          new InvalidFile({
            message: `couldn't read profiles directory ${directory}: ${describeFileError(error)}`,
            file: directory,
          }),
      ),
    );

    const files = entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => path.join(directory, entry));

    return { directory, files };
  });

/** Each profile's fields, with its setup path as `setupPath` shows it. */
export const profileRows = (
  profiles: ReadonlyArray<LoadedProfile>,
  setupPath: (path: string) => string,
) => [
  ["NAME", "BASE", "CPU", "RAM", "DISK", "SETUP", "TIMEOUT", "HOST"],
  ...profiles.map(({ label, base, cpu, ramMib, diskGib, setup, host }) => [
    label,
    base,
    String(cpu),
    formatMib(ramMib),
    formatGib(diskGib),
    setup === undefined ? "-" : setupPath(setup.path),
    setup?.timeoutSeconds === undefined ? "-" : formatSeconds(setup.timeoutSeconds),
    host ?? "-",
  ]),
];

const encodeProfileFields = Schema.encodeSync(Profile);

/** A loaded profile as JSON: its name, then its fields, with `setup.path` resolved. */
export const encodeProfile = (profile: LoadedProfile) => ({
  name: profile.label,
  ...encodeProfileFields(profile),
});

/**
 * The profiles in the config's profiles directory, read on the client: no host is asked. A
 * profile file that doesn't decode fails the command, naming the file.
 */
export const profiles = Command.make("profiles", clientFlags, (flags) =>
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
