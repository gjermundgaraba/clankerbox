import { loadProfile, specRequest } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option, Path } from "effect";
import type { Command } from "effect/cli";
import { Flag } from "effect/cli";

import { parsed } from "../command.ts";
import { configPath } from "../config.ts";
import type { LoadedConfig } from "../config.ts";
import { profileFile } from "../profiles.ts";
import { parseGib, parseMib, parseSeconds } from "../units.ts";

export const sizeArguments = {
  cpu: Flag.Int("cpu").pipe(Flag.withDescription("vCPUs."), Flag.optional),
  ram: Flag.String("ram").pipe(
    Flag.withMetavar("SIZE"),
    Flag.withDescription("RAM, such as 512M or 8G."),
    Flag.optional
  ),
  disk: Flag.String("disk").pipe(
    Flag.withMetavar("SIZE"),
    Flag.withDescription("Disk, in whole GiB, such as 60G."),
    Flag.optional
  ),
};

type SizeFlags = Command.Command.Config.Infer<typeof sizeArguments>;

export const flagSizes = (flags: SizeFlags) =>
  Effect.gen(function* () {
    const ram = yield* parsed(flags.ram, "--ram", parseMib);
    const disk = yield* parsed(flags.disk, "--disk", parseGib);

    return {
      cpu: Option.getOrUndefined(flags.cpu),
      ramMib: Option.getOrUndefined(ram),
      diskGib: Option.getOrUndefined(disk),
    };
  });

export const specArguments = {
  host: Flag.String("host").pipe(
    Flag.withDescription(
      "The host to create on. Without it, the profile's host, or else the first host that offers the base."
    ),
    Flag.optional
  ),
  profile: Flag.String("profile").pipe(
    Flag.withDescription(
      "A profile file's path, or a name in the config's profiles directory. The other flags override its fields."
    ),
    Flag.optional
  ),
  base: Flag.String("base").pipe(
    Flag.withDescription("The base to create from."),
    Flag.optional
  ),
  ...sizeArguments,
  setup: Flag.String("setup").pipe(
    Flag.withDescription(
      "A setup script, or a recipe directory holding setup.sh. After it, the host installs the config's authorizedKeys for the login user; a base alone authorizes no SSH key."
    ),
    Flag.optional
  ),
  setupTimeout: Flag.String("setup-timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "How long setup may run, such as 90s or 15m. Default: the profile's, or else the host's."
    ),
    Flag.optional
  ),
};

export type SpecFlags = Command.Command.Config.Infer<typeof specArguments>;

const specNames = new Map<PropertyKey, string>([
  ["base", "--base"],
  ["cpu", "--cpu"],
  ["ramMib", "--ram"],
  ["diskGib", "--disk"],
  ["setupTimeoutSeconds", "--setup-timeout"],
  ["authorizedKeys", "the client config's authorizedKeys"],
]);

export const flagsRequest = (
  command: string,
  flags: SpecFlags,
  config: LoadedConfig
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    const profile = Option.isSome(flags.profile)
      ? yield* loadProfile(yield* profileFile(config, flags.profile.value))
      : undefined;

    const sizes = yield* flagSizes(flags);

    const timeout = yield* parsed(
      flags.setupTimeout,
      "--setup-timeout",
      parseSeconds
    );

    return yield* specRequest(
      command,
      profile,
      {
        base: Option.getOrUndefined(flags.base),
        ...sizes,
        setup: Option.getOrUndefined(
          Option.map(flags.setup, (given) => path.resolve(given))
        ),
        setupTimeoutSeconds: Option.getOrUndefined(timeout),
        host: Option.getOrUndefined(flags.host),
        authorizedKeys:
          config.authorizedKeys === undefined
            ? undefined
            : yield* configPath(config, config.authorizedKeys),
      },
      specNames
    );
  });
