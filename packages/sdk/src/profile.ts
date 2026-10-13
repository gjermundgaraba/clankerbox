/**
 * Profile files, and the create a profile asks for. Hosts never see a profile: it is a
 * client-side file that fills in a create's spec.
 */
import { Effect, FileSystem, Path, Predicate, Record, Schema } from "effect";
import { Invalid } from "./errors.ts";
import { HostId } from "./ids.ts";
import { MachineSpec, Setup } from "./resources.ts";
import { readSetup } from "./setup.ts";
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

/** What replaces a profile's fields in a create: each one given replaces the profile's. */
export interface Overrides {
  readonly base?: string | undefined;
  readonly cpu?: number | undefined;
  readonly ramMib?: number | undefined;
  readonly diskGib?: number | undefined;
  /** A setup script or recipe directory, already resolved. */
  readonly setup?: string | undefined;
  /** How long the setup may run; the host's default when neither this nor the profile says. */
  readonly setupTimeoutSeconds?: number | undefined;
  readonly host?: string | undefined;
}

/** What a create asks for: the spec, and the host it goes to instead of placement, if any. */
export interface SpecRequest {
  readonly spec: MachineSpec;
  readonly host: string | undefined;
}

const decodeSpec = Schema.decodeUnknownEffect(MachineSpec);

/**
 * The spec and host a create of `profile`, if any, asks for, with each field, the setup, its
 * timeout and the host replaced by the override that gives one. The setup is read here. A timeout
 * with no setup to time is refused, and so is a field neither gives, as one out of range is,
 * each refusal naming `what` and each field as `names` calls it.
 */
export const specRequest = (
  what: string,
  profile: LoadedProfile | undefined,
  overrides: Overrides,
  names?: ReadonlyMap<PropertyKey, string>,
): Effect.Effect<SpecRequest, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const file = overrides.setup ?? profile?.setup?.path;
    const timeoutSeconds = overrides.setupTimeoutSeconds ?? profile?.setup?.timeoutSeconds;

    if (file === undefined && overrides.setupTimeoutSeconds !== undefined) {
      return yield* new Invalid({
        message: `${what}: ${names?.get("setupTimeoutSeconds") ?? "the setup timeout"} needs a setup to time`,
      });
    }

    const script = file === undefined ? undefined : yield* readSetup(file);

    const fields = {
      base: overrides.base ?? profile?.base,
      cpu: overrides.cpu ?? profile?.cpu,
      ramMib: overrides.ramMib ?? profile?.ramMib,
      diskGib: overrides.diskGib ?? profile?.diskGib,
      setup:
        script === undefined
          ? undefined
          : Record.filter({ script, timeoutSeconds }, Predicate.isNotUndefined),
      profile: profile?.label,
    };

    const spec = yield* decodeSpec(Record.filter(fields, Predicate.isNotUndefined), {
      onExcessProperty: "error",
      errors: "all",
    }).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `${what}: ${describeIssues(error, names)}` }),
      ),
    );

    return { spec, host: overrides.host ?? profile?.host };
  });
