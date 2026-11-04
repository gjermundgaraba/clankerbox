import { describeIssues, Invalid } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, FileSystem, Schema } from "effect";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

/** The sizes an orb type gets. */
export const Sizes = Schema.Struct({
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
});

export type Sizes = typeof Sizes.Type;

/** The orb type a thread gets when it picks none, and whose sizes an unknown type gets too. */
export const defaultType = "default";

/** The image's login user, who runs `amp orb bootstrap`: `user` in Amp's own image. */
export const defaultUser = "user";

export const defaultSnapshotExpiry = Duration.days(14);

/**
 * The dispatch program's settings file: the control plane's URL, the sizes of each orb type, with
 * a `default` entry, the user bootstrap runs as, and how long a saved project snapshot is kept,
 * such as `"14 days"`.
 */
export const Settings = Schema.Struct({
  server: Schema.String,
  sizes: Schema.Record(Schema.String, Sizes),
  user: Schema.optionalKey(Schema.NonEmptyString),
  snapshotExpiry: Schema.optionalKey(Schema.DurationFromString),
});

export interface Loaded {
  readonly server: string;
  readonly sizes: Readonly<Record<string, Sizes>>;
  readonly fallback: Sizes;
  readonly user: string;
  readonly snapshotExpiry: Duration.Duration;
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Settings));

export const loadSettings = Effect.fn("loadSettings")(function* (
  file: string
): Effect.fn.Return<Loaded, Invalid, FileSystem.FileSystem> {
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
    sizes: settings.sizes,
    fallback,
    user: settings.user ?? defaultUser,
    snapshotExpiry: settings.snapshotExpiry ?? defaultSnapshotExpiry,
  };
});
