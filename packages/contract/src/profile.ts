/** Reads a profile file for `create`. Hosts never see a profile. */
import { Effect, FileSystem, Path, Schema } from "effect";
import { Invalid } from "./errors.ts";
import { Profile } from "./resources.ts";

/** A profile file as read: its fields, with `setup.path` resolved, and its name as `label`. */
export interface LoadedProfile extends Profile {
  readonly label: string;
}

/** Profile files are JSON, decoded with closed input like every call: unknown keys are refused. */
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(Profile));

/**
 * Reads the profile file at `file`. Its name, the file name without `.json`, is the machine's
 * `profile` label, and its `setup.path` is resolved against the file's directory. The setup
 * itself is read by whoever sends it, with `readSetup`.
 */
export const loadProfile = (
  file: string,
): Effect.Effect<LoadedProfile, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError(
          (error) => new Invalid({ message: `couldn't read profile ${file}: ${error.message}` }),
        ),
      );

    const profile = yield* decodeProfile(text, { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) => new Invalid({ message: `profile ${file}: ${error.message}` })),
    );

    const label = path.basename(file, ".json");

    return profile.setup === undefined
      ? { ...profile, label }
      : {
          ...profile,
          setup: { ...profile.setup, path: path.resolve(path.dirname(file), profile.setup.path) },
          label,
        };
  });
