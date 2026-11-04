import {
  actionsByName,
  Build,
  formatGib,
  formatMib,
  readSetup,
  Template,
} from "@gjermundgaraba/clankerbox-sdk";
import type { DateTime } from "effect";
import { Effect, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  clientFlags,
  deleted,
  listCommand,
  mutationFlags,
  newId,
  parsed,
  printResource,
  table,
  withClient,
} from "./command.ts";
import { flagSizes, sizeArguments } from "./machines/spec.ts";
import { age, formatSeconds, parseSeconds } from "./units.ts";

const templateArgument = Argument.String("template").pipe(
  Argument.withDescription("The template's name.")
);

const encodeTemplate = Schema.encodeSync(Template);

const encodeBuild = Schema.encodeSync(Build);

const failure = (error: Build["error"]) =>
  error === undefined ? "-" : `${error._tag}: ${error.message}`;

export const templateRows = (templates: readonly Template[]) => [
  ["NAME", "BASE", "CURRENT", "STATE"],
  ...templates.map((template) => [
    template.id,
    template.base,
    template.current ?? "-",
    template.state,
  ]),
];

const templateText = (template: Template, now: DateTime.Utc) =>
  [
    table([
      ["NAME", template.id],
      ["BASE", template.base],
      ["CPU", String(template.cpu)],
      ["RAM", formatMib(template.ramMib)],
      ["DISK", formatGib(template.diskGib)],
      [
        "SETUP_TIMEOUT",
        template.setupTimeoutSeconds === undefined
          ? "-"
          : formatSeconds(template.setupTimeoutSeconds),
      ],
      ["CURRENT", template.current ?? "-"],
      ["STATE", template.state],
    ]),
    "",
    table([
      ["BUILD", "PHASE", "HOST", "IMAGE", "AGE", "ERROR"],
      ...template.builds.map((build) => [
        build.id,
        build.phase,
        build.host,
        build.image,
        age(build.createdAt, now),
        failure(build.error),
      ]),
    ]),
  ].join("\n");

export const buildTemplate = Command.make(
  "build",
  {
    ...mutationFlags,
    template: templateArgument,
    setup: Argument.String("path").pipe(
      Argument.withDescription(
        "A setup script, or a recipe directory holding setup.sh. The server runs it and keeps only the machine it made."
      )
    ),
    base: Flag.String("base").pipe(
      Flag.withDescription(
        "The base to build on. Default: the template's, which a first build names."
      ),
      Flag.optional
    ),
    ...sizeArguments,
    setupTimeout: Flag.String("setup-timeout").pipe(
      Flag.withMetavar("DURATION"),
      Flag.withDescription(
        "How long setup may run, such as 90s or 15m. Default: the template's, or else the host's."
      ),
      Flag.optional
    ),
  },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sizes = yield* flagSizes(flags);

          const timeout = yield* parsed(
            flags.setupTimeout,
            "--setup-timeout",
            parseSeconds
          );

          const script = yield* readSetup(path.resolve(flags.setup));

          return yield* client.buildTemplate({
            template: flags.template,
            base: Option.getOrUndefined(flags.base),
            ...sizes,
            setup: Option.match(timeout, {
              onNone: () => ({ script }),
              onSome: (timeoutSeconds) => ({ script, timeoutSeconds }),
            }),
          });
        }),
      encode: encodeBuild,
      text: newId,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.buildTemplate.description} A first build needs --base, --cpu, --ram and --disk, and a rebuild reuses each one it leaves out. Waits until the build ends, unless --no-wait, and prints its ID, such as web@1.`
  )
);

export const listTemplates = listCommand({
  name: "list",
  description: `${actionsByName.listTemplates.description} Prints each one's base, current build and state.`,
  key: "templates",
  read: (client) => client.templates,
  encode: encodeTemplate,
  rows: templateRows,
});

export const getTemplate = Command.make(
  "get",
  { ...clientFlags, template: templateArgument },
  (flags) =>
    printResource(flags, {
      call: (client) => client.getTemplate({ id: flags.template }),
      encode: encodeTemplate,
      text: templateText,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.getTemplate.description} Prints the sizes a create takes at least, and each build kept, with why one failed.`
  )
);

export const deleteTemplate = Command.make(
  "delete",
  { ...mutationFlags, template: templateArgument },
  (flags) =>
    withClient(flags, (client) =>
      deleted(
        flags.json,
        flags.template,
        client.deleteTemplate({ id: flags.template })
      )
    )
).pipe(
  Command.withDescription(
    `${actionsByName.deleteTemplate.description} A template that is already gone counts as deleted.`
  )
);

export const template = Command.make("template").pipe(
  Command.withDescription(
    "Build, list, read and delete templates: machines the server built from a setup, which a create clones."
  ),
  Command.withSubcommands([
    buildTemplate,
    listTemplates,
    getTemplate,
    deleteTemplate,
  ])
);
