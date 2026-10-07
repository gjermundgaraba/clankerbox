/**
 * The client config: one JSON file holding the host list, in placement order, and an
 * optional profiles directory. It is read from `--config PATH`, or else from
 * `$XDG_CONFIG_HOME/clankerbox/config.json` (`~/.config` when that is unset).
 */
import { Client, Invalid } from "@gjermundgaraba/clankerbox-sdk";
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";

/** The client library refuses a host ID that appears twice. */
const ClientConfig = Schema.Struct({
  hosts: Schema.NonEmptyArray(Client.HostEntry),
  /** Where `--profile NAME` looks for `NAME.json`, relative to the config file. */
  profiles: Schema.optionalKey(Schema.String),
});

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientConfig));

export interface LoadedConfig {
  readonly hosts: ReadonlyArray<Client.HostEntry>;
  /** The profiles directory, resolved against the config file's directory. */
  readonly profiles: string | undefined;
}

const defaultPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const xdg = yield* Config.option(Config.String("XDG_CONFIG_HOME"));

  const base = yield* Option.match(xdg, {
    onSome: Effect.succeed,
    onNone: () => Effect.map(Config.String("HOME"), (home) => path.join(home, ".config")),
  });

  return path.join(base, "clankerbox", "config.json");
}).pipe(
  Effect.mapError(
    () =>
      new Invalid({
        message: "no client config: pass --config PATH, or set XDG_CONFIG_HOME or HOME",
      }),
  ),
);

export const loadConfig = (
  flag: Option.Option<string>,
): Effect.Effect<LoadedConfig, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.resolve(Option.isSome(flag) ? flag.value : yield* defaultPath);

    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError(
          (error) =>
            new Invalid({ message: `couldn't read client config ${file}: ${error.message}` }),
        ),
      );

    const config = yield* decodeConfig(text, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `client config ${file}: ${error.message}` }),
      ),
    );

    return {
      hosts: config.hosts,
      profiles:
        config.profiles === undefined
          ? undefined
          : path.resolve(path.dirname(file), config.profiles),
    };
  });

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
  Invalid,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = config.profiles;

    if (directory === undefined) {
      return yield* new Invalid({ message: "the client config has no profiles directory" });
    }

    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't read profiles directory ${directory}: ${error.message}`,
          }),
      ),
    );

    const files = entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => path.join(directory, entry));

    return { directory, files };
  });
