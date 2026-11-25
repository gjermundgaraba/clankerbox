import {
  describeIssues,
  Invalid,
  readToken,
  RuntimeName,
  Sizes,
} from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, FileSystem, Path, Schema } from "effect";
import type { Redacted } from "effect";

export const defaultType = "default";

/** The image's login user, who runs `amp orb bootstrap`: `user` in Amp's own image. */
export const defaultUser = "user";

export const defaultSnapshotExpiry = Duration.days(14);

/**
 * The dispatch program's settings file. `runtime` is the one every orb's machine is created on,
 * such as `smolvm`, of those that take an image reference. `snapshotExpiry` is a duration such as
 * `"14 days"`. `token` is a file holding the token the control plane takes from it, when its config
 * names callers, a path relative to the settings file.
 */
export const Settings = Schema.Struct({
  server: Schema.String,
  runtime: RuntimeName,
  sizes: Schema.Record(Schema.String, Sizes),
  user: Schema.optionalKey(Schema.NonEmptyString),
  snapshotExpiry: Schema.optionalKey(Schema.DurationFromString),
  token: Schema.optionalKey(Schema.String),
});

export interface Loaded {
  readonly server: string;
  readonly runtime: RuntimeName;
  readonly sizes: Readonly<Record<string, Sizes>>;
  readonly fallback: Sizes;
  readonly user: string;
  readonly snapshotExpiry: Duration.Duration;
  readonly token?: Redacted.Redacted | undefined;
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Settings));

export const loadSettings = Effect.fn("loadSettings")(function* (
  file: string
): Effect.fn.Return<Loaded, Invalid, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `settings: ${error.message}`, file })
      )
    );

  const settings = yield* decode(text).pipe(
    Effect.mapError(
      (error) =>
        new Invalid({ message: `settings: ${describeIssues(error)}`, file })
    )
  );

  const fallback = settings.sizes[defaultType];

  if (fallback === undefined) {
    return yield* new Invalid({
      message: `settings: sizes needs a "${defaultType}" entry, for a thread that picks no orb type`,
      file,
    });
  }

  return {
    server: settings.server,
    runtime: settings.runtime,
    sizes: settings.sizes,
    fallback,
    user: settings.user ?? defaultUser,
    snapshotExpiry: settings.snapshotExpiry ?? defaultSnapshotExpiry,
    ...(settings.token === undefined
      ? {}
      : {
          token: yield* readToken(
            (yield* Path.Path).resolve(
              (yield* Path.Path).dirname(file),
              settings.token
            ),
            "caller"
          ),
        }),
  };
});
