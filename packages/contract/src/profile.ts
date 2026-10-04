/** Turns a profile file into what `create` needs. Hosts never see a profile. */
import { Effect, FileSystem, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Invalid } from "./errors.ts";
import { Profile, type MachineSpec } from "./resources.ts";
import { readSetup } from "./setup.ts";

/** What a profile file asks for: the machine's spec, and the host it names, if any. */
export interface ProfileRequest {
  readonly spec: MachineSpec;
  readonly host?: string | undefined;
}

/** Profile files are JSON, decoded with closed input like every call: unknown keys are refused. */
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(Profile));

/**
 * Reads the profile file at `file`. Its name, the file name without `.json`, becomes the
 * machine's `profile` label, and its `setup` is read relative to the file.
 */
export const loadProfile = (
  file: string,
): Effect.Effect<
  ProfileRequest,
  Invalid,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
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

    const sizes = {
      base: profile.base,
      cpu: profile.cpu,
      ramMib: profile.ramMib,
      diskGib: profile.diskGib,
    };

    if (profile.setup === undefined || profile.setupTimeoutSeconds === undefined) {
      return { spec: { ...sizes, profile: label }, host: profile.host };
    }

    const setup = yield* readSetup(path.resolve(path.dirname(file), profile.setup));

    return {
      spec: { ...sizes, setup, setupTimeoutSeconds: profile.setupTimeoutSeconds, profile: label },
      host: profile.host,
    };
  });
