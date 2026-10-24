import { Effect, FileSystem, Path, Predicate, Record, Schema } from "effect";
import { Invalid } from "./errors.ts";
import { HostId } from "./ids.ts";
import { MachineSpec, Setup } from "./resources.ts";
import { readAuthorizedKeys, readSetup } from "./setup.ts";
import { describeFileError, describeIssues } from "./describe.ts";

/**
 * A client-side file that fills in a create's spec; hosts never see it. `setup.path` is a script
 * file or a recipe directory, relative to the profile file. Without `base`, the create names it.
 */
export const Profile = Schema.Struct({
  base: Schema.optionalKey(MachineSpec.fields.base),
  cpu: MachineSpec.fields.cpu,
  ramMib: MachineSpec.fields.ramMib,
  diskGib: MachineSpec.fields.diskGib,
  setup: Schema.optionalKey(
    Schema.Struct({ path: Schema.String, timeoutSeconds: Setup.fields.timeoutSeconds }),
  ),
  host: Schema.optionalKey(HostId),
});

export type Profile = typeof Profile.Type;

/** `setup.path` resolved, and the file's name as `label`. */
export interface LoadedProfile extends Profile {
  readonly label: string;
}

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(Profile));

/**
 * Its file name without `.json` is the machine's `profile` label. Unknown keys are refused. The
 * setup itself is read by whoever sends it, with `readSetup`.
 */
export const loadProfile = (
  file: string,
): Effect.Effect<LoadedProfile, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't read profile ${file}: ${describeFileError(error)}`,
            file,
          }),
      ),
    );

    const profile = yield* decodeProfile(text, { onExcessProperty: "error", errors: "all" }).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `profile ${file}: ${describeIssues(error)}`, file }),
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

type Sizes = Omit<Profile, "setup" | "host">;

/** Each field given replaces the profile's. */
export type Overrides = { readonly [K in keyof Sizes]?: Sizes[K] | undefined } & {
  /** A setup script or recipe directory, already resolved. */
  readonly setup?: string | undefined;
  readonly setupTimeoutSeconds?: number | undefined;
  readonly host?: string | undefined;
  /** A public-key file, already resolved, which a setup needs and which is read only for one. */
  readonly authorizedKeys?: string | undefined;
};

export interface SpecRequest {
  readonly spec: MachineSpec;
  readonly host: string | undefined;
}

const decodeSpec = Schema.decodeUnknownEffect(MachineSpec);

/**
 * The spec and host a create of `profile` asks for, with the overrides applied and the setup
 * read. Each refusal names `what`, and each field as `names` calls it.
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

    const keys = overrides.authorizedKeys;

    const setup =
      file === undefined
        ? undefined
        : keys === undefined
          ? yield* new Invalid({
              message: `${what}: a setup needs ${names?.get("authorizedKeys") ?? "authorizedKeys"}, the public keys the host installs for the login user after it`,
            })
          : Record.filter(
              {
                script: yield* readSetup(file),
                timeoutSeconds,
                authorizedKeys: yield* readAuthorizedKeys(keys),
              },
              Predicate.isNotUndefined,
            );

    const fields = {
      base: overrides.base ?? profile?.base,
      cpu: overrides.cpu ?? profile?.cpu,
      ramMib: overrides.ramMib ?? profile?.ramMib,
      diskGib: overrides.diskGib ?? profile?.diskGib,
      setup,
      profile: profile?.label,
    } satisfies Record<keyof Sizes | "setup" | "profile", unknown>;

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
