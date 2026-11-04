import {
  BaseSpec,
  describeIssues,
  Invalid,
  readSetup,
  TemplateSpec,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option, Path, Predicate, Record, Schema } from "effect";
import type { Command } from "effect/cli";
import { Flag } from "effect/cli";

import { parsed } from "../command.ts";
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
  template: Flag.String("template").pipe(
    Flag.withMetavar("NAME[@BUILD]"),
    Flag.withDescription(
      "The template to create from: its current build, or the build named, such as web@3. The machine takes the build's sizes, or the larger ones given."
    ),
    Flag.optional
  ),
  base: Flag.String("base").pipe(
    Flag.withDescription("The base to create from, when there is no template."),
    Flag.optional
  ),
  ...sizeArguments,
  setup: Flag.String("setup").pipe(
    Flag.withDescription(
      "A setup script, or a recipe directory holding setup.sh, run on a create from a base. After it, the host installs the server config's authorizedKeys for the login user; a base alone authorizes no SSH key."
    ),
    Flag.optional
  ),
  setupTimeout: Flag.String("setup-timeout").pipe(
    Flag.withMetavar("DURATION"),
    Flag.withDescription(
      "How long setup may run, such as 90s or 15m. Default: the host's."
    ),
    Flag.optional
  ),
};

export type SpecFlags = Command.Command.Config.Infer<typeof specArguments>;

const specNames = new Map<PropertyKey, string>([
  ["template", "--template"],
  ["base", "--base"],
  ["cpu", "--cpu"],
  ["ramMib", "--ram"],
  ["diskGib", "--disk"],
]);

const defined = (fields: Readonly<Record<string, unknown>>) =>
  Record.filter(fields, Predicate.isNotUndefined);

const decodeTemplateSpec = Schema.decodeUnknownEffect(TemplateSpec);

const decodeBaseSpec = Schema.decodeUnknownEffect(BaseSpec);

const strictly = { onExcessProperty: "error", errors: "all" } as const;

const refused = (command: string) => (error: Schema.SchemaError) =>
  new Invalid({ message: `${command}: ${describeIssues(error, specNames)}` });

export const flagsSpec = (command: string, flags: SpecFlags) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const sizes = yield* flagSizes(flags);

    const timeout = yield* parsed(
      flags.setupTimeout,
      "--setup-timeout",
      parseSeconds
    );

    if (Option.isSome(flags.template)) {
      const given = [
        ...(Option.isSome(flags.base) ? ["--base"] : []),
        ...(Option.isSome(flags.setup) ? ["--setup"] : []),
        ...(Option.isSome(timeout) ? ["--setup-timeout"] : []),
      ];

      if (given.length > 0) {
        return yield* new Invalid({
          message: `${command}: a template's build has its base and has run its setup, so --template takes no ${given.join(", ")}`,
        });
      }

      return yield* decodeTemplateSpec(
        defined({ template: flags.template.value, ...sizes }),
        strictly
      ).pipe(Effect.mapError(refused(command)));
    }

    if (Option.isNone(flags.base)) {
      return yield* new Invalid({
        message: `${command}: give --template, or --base with --cpu, --ram and --disk`,
      });
    }

    if (Option.isNone(flags.setup) && Option.isSome(timeout)) {
      return yield* new Invalid({
        message: `${command}: --setup-timeout needs a setup to time`,
      });
    }

    const setup = Option.isSome(flags.setup)
      ? defined({
          script: yield* readSetup(path.resolve(flags.setup.value)),
          timeoutSeconds: Option.getOrUndefined(timeout),
        })
      : undefined;

    return yield* decodeBaseSpec(
      defined({ base: flags.base.value, ...sizes, setup }),
      strictly
    ).pipe(Effect.mapError(refused(command)));
  });
