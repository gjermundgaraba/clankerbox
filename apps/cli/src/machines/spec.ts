import {
  BaseSpec,
  describeIssues,
  Invalid,
  TemplateSpec,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option, Predicate, Record, Schema } from "effect";
import type { Command } from "effect/cli";
import { Flag } from "effect/cli";

import { parsed } from "../command.ts";
import { parseGib, parseMib } from "../units.ts";

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

export const hostArgument = {
  host: Flag.String("host").pipe(
    Flag.withDescription(
      "The host to place it on, as clankerbox hosts lists them: only that host is tried."
    ),
    Flag.optional
  ),
};

export const specArguments = {
  template: Flag.String("template").pipe(
    Flag.withMetavar("NAME[@BUILD]"),
    Flag.withDescription(
      "The template to create from: its current build, or the build named, such as web@3. The machine takes the build's sizes, or the larger ones given."
    ),
    Flag.optional
  ),
  base: Flag.String("base").pipe(
    Flag.withDescription(
      "The base to create from, when there is no template. It runs no setup and authorizes no SSH key: build a template for that."
    ),
    Flag.optional
  ),
  ...sizeArguments,
  ...hostArgument,
};

export type SpecFlags = Command.Command.Config.Infer<typeof specArguments>;

const specNames = new Map<PropertyKey, string>([
  ["template", "--template"],
  ["base", "--base"],
  ["cpu", "--cpu"],
  ["ramMib", "--ram"],
  ["diskGib", "--disk"],
  ["host", "--host"],
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
    const sizes = yield* flagSizes(flags);
    const host = Option.getOrUndefined(flags.host);

    if (Option.isSome(flags.template)) {
      if (Option.isSome(flags.base)) {
        return yield* new Invalid({
          message: `${command}: a template's build has its base, so --template takes no --base`,
        });
      }

      return yield* decodeTemplateSpec(
        defined({ template: flags.template.value, ...sizes, host }),
        strictly
      ).pipe(Effect.mapError(refused(command)));
    }

    if (Option.isNone(flags.base)) {
      return yield* new Invalid({
        message: `${command}: give --template, or --base with --cpu, --ram and --disk`,
      });
    }

    return yield* decodeBaseSpec(
      defined({ base: flags.base.value, ...sizes, host }),
      strictly
    ).pipe(Effect.mapError(refused(command)));
  });
