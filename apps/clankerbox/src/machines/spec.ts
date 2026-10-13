/**
 * What a create and a prebuild are of: a profile, and the flags that override its fields, decoded
 * into the spec and host a create asks for.
 */
import {
  describeIssues,
  Invalid,
  type LoadedProfile,
  loadProfile,
  MachineSpec,
  readSetup,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option, Path, Predicate, Record, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { parsed } from "../command.ts";
import type { LoadedConfig } from "../config.ts";
import { profileFile } from "../profiles.ts";
import { parseGib, parseMib, parseSeconds } from "../units.ts";

/** What a create and a prebuild are of: a profile, and the flags that override its fields. */
export const specArguments = {
  host: Flag.String("host").pipe(
    Flag.withDescription(
      "The host to create on. Without it, the profile's host, or else the first host that offers the base.",
    ),
    Flag.optional,
  ),
  profile: Flag.String("profile").pipe(
    Flag.withDescription(
      "A profile file's path, or a name in the config's profiles directory. The other flags override its fields.",
    ),
    Flag.optional,
  ),
  base: Flag.String("base").pipe(Flag.withDescription("The base to create from."), Flag.optional),
  cpu: Flag.Int("cpu").pipe(Flag.withDescription("vCPUs."), Flag.optional),
  ram: Flag.String("ram").pipe(
    Flag.withMetavar("SIZE"),
    Flag.withDescription("RAM, such as 512M or 8G."),
    Flag.optional,
  ),
  disk: Flag.String("disk").pipe(
    Flag.withMetavar("SIZE"),
    Flag.withDescription("Disk, in whole GiB, such as 60G."),
    Flag.optional,
  ),
  setup: Flag.String("setup").pipe(
    Flag.withDescription(
      "A setup script, or a recipe directory holding setup.sh. A base alone authorizes no SSH key: a setup does.",
    ),
    Flag.optional,
  ),
  setupTimeout: Flag.String("setup-timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "How long setup may run, such as 90s or 15m. Default: the profile's, or else the host's.",
    ),
    Flag.optional,
  ),
};

export type SpecFlags = Command.Command.Config.Infer<typeof specArguments>;

/**
 * The setup a create runs, if any: the profile's, with its path and its timeout each overridden
 * by its flag, and no timeout when neither says, which leaves it to the host. `--setup` is
 * resolved against the cwd.
 */
const setupSource = (flags: SpecFlags, profile: LoadedProfile | undefined) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    const file = Option.match(flags.setup, {
      onNone: () => profile?.setup?.path,
      onSome: (given) => path.resolve(given),
    });

    const timed = yield* parsed(flags.setupTimeout, "--setup-timeout", parseSeconds);

    if (file === undefined) {
      return Option.isNone(timed)
        ? undefined
        : yield* new Invalid({
            message: "--setup-timeout needs a setup: pass --setup, or a profile that has one",
          });
    }

    const timeoutSeconds = Option.getOrElse(timed, () => profile?.setup?.timeoutSeconds);

    return { path: file, timeout: timeoutSeconds === undefined ? {} : { timeoutSeconds } };
  });

const decodeSpec = Schema.decodeUnknownEffect(MachineSpec);

/** The flag that sets each of a spec's fields, which is how a refusal names the field. */
const specFlags = new Map<PropertyKey, string>([
  ["base", "--base"],
  ["cpu", "--cpu"],
  ["ramMib", "--ram"],
  ["diskGib", "--disk"],
]);

/**
 * The spec and host a create or a prebuild asks for: the profile's fields, setup and host, each
 * overridden by its flag. The decode refuses a field that neither sets, as it does one out of
 * range, naming `command`.
 */
export const specRequest = (command: string, flags: SpecFlags, config: LoadedConfig) =>
  Effect.gen(function* () {
    const profile = Option.isSome(flags.profile)
      ? yield* loadProfile(yield* profileFile(config, flags.profile.value))
      : undefined;

    const source = yield* setupSource(flags, profile);

    const ram = yield* parsed(flags.ram, "--ram", parseMib);
    const disk = yield* parsed(flags.disk, "--disk", parseGib);

    const fields = {
      base: Option.getOrElse(flags.base, () => profile?.base),
      cpu: Option.getOrElse(flags.cpu, () => profile?.cpu),
      ramMib: Option.getOrElse(ram, () => profile?.ramMib),
      diskGib: Option.getOrElse(disk, () => profile?.diskGib),
      setup:
        source === undefined
          ? undefined
          : { script: yield* readSetup(source.path), ...source.timeout },
      profile: profile?.label,
    };

    // A field nobody set is left out, so the decode calls it missing.
    const spec = yield* decodeSpec(Record.filter(fields, Predicate.isNotUndefined), {
      onExcessProperty: "error",
      errors: "all",
    }).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `${command}: ${describeIssues(error, specFlags)}` }),
      ),
    );

    return { spec, host: Option.getOrElse(flags.host, () => profile?.host) };
  });
