/** Reads a profile file for `create`. Hosts never see a profile. */
import { Effect, FileSystem, Path, Schema } from "effect";
import { Invalid } from "./errors.ts";
import { HostId } from "./ids.ts";
import { MachineSpec, Setup } from "./resources.ts";
import { describeFileError, describeIssues } from "./text.ts";

/**
 * A profile file: a client-side file that fills in a create request. `setup.path` is a script
 * file or a recipe directory, relative to the profile file; without a `timeoutSeconds` the host's
 * default applies. `host` places the create on that host instead of by base.
 */
export const Profile = Schema.Struct({
  base: MachineSpec.fields.base,
  cpu: MachineSpec.fields.cpu,
  ramMib: MachineSpec.fields.ramMib,
  diskGib: MachineSpec.fields.diskGib,
  setup: Schema.optionalKey(
    Schema.Struct({ path: Schema.String, timeoutSeconds: Setup.fields.timeoutSeconds }),
  ),
  host: Schema.optionalKey(HostId),
});

export type Profile = typeof Profile.Type;

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
          (error) =>
            new Invalid({ message: `couldn't read profile ${file}: ${describeFileError(error)}` }),
        ),
      );

    const profile = yield* decodeProfile(text, { onExcessProperty: "error", errors: "all" }).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `profile ${file}: ${describeIssues(error)}` }),
      ),
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
