/**
 * What a create and a prebuild are of: a profile, and the flags that override its fields, decoded
 * into the spec and host a create asks for.
 */
import { loadProfile, specRequest } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option, Path } from "effect";
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

/** The flag that sets each of a spec's fields, which is how a refusal names the field. */
const specFlags = new Map<PropertyKey, string>([
  ["base", "--base"],
  ["cpu", "--cpu"],
  ["ramMib", "--ram"],
  ["diskGib", "--disk"],
  ["setupTimeoutSeconds", "--setup-timeout"],
]);

/**
 * The spec and host a create or a prebuild asks for: the profile's, with each flag given
 * overriding its field. `--setup` is resolved against the cwd.
 */
export const flagsRequest = (command: string, flags: SpecFlags, config: LoadedConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    const profile = Option.isSome(flags.profile)
      ? yield* loadProfile(yield* profileFile(config, flags.profile.value))
      : undefined;

    const ram = yield* parsed(flags.ram, "--ram", parseMib);
    const disk = yield* parsed(flags.disk, "--disk", parseGib);
    const timeout = yield* parsed(flags.setupTimeout, "--setup-timeout", parseSeconds);

    return yield* specRequest(
      command,
      profile,
      {
        base: Option.getOrUndefined(flags.base),
        cpu: Option.getOrUndefined(flags.cpu),
        ramMib: Option.getOrUndefined(ram),
        diskGib: Option.getOrUndefined(disk),
        setup: Option.getOrUndefined(Option.map(flags.setup, (given) => path.resolve(given))),
        setupTimeoutSeconds: Option.getOrUndefined(timeout),
        host: Option.getOrUndefined(flags.host),
      },
      specFlags,
    );
  });
