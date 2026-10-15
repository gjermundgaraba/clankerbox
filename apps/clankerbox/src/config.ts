import { Client, describeFileError, describeIssues, Invalid } from "@gjermundgaraba/clankerbox-sdk";
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";

const ClientConfig = Schema.Struct({
  hosts: Schema.Array(Client.HostEntry),
  profiles: Schema.optionalKey(Schema.String),
});

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientConfig));

export interface LoadedConfig {
  readonly file: string;
  readonly hosts: ReadonlyArray<Client.HostEntry>;
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

    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't read client config ${file}: ${describeFileError(error)}`,
            file,
          }),
      ),
    );

    const config = yield* decodeConfig(text, { onExcessProperty: "error", errors: "all" }).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({ message: `client config ${file}: ${describeIssues(error)}`, file }),
      ),
    );

    return {
      file,
      hosts: config.hosts,
      profiles:
        config.profiles === undefined
          ? undefined
          : path.resolve(path.dirname(file), config.profiles),
    };
  });
