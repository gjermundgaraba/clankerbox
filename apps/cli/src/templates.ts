import {
  actionsByName,
  Build,
  formatGib,
  formatMib,
  Template,
} from "@gjermundgaraba/clankerbox-sdk";
import type { DateTime } from "effect";
import { Effect, Path, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import {
  clientFlags,
  deleted,
  listCommand,
  mutationFlags,
  newId,
  printResource,
  table,
  withClient,
} from "./command.ts";
import { readTemplateFile } from "./template-file.ts";
import { age, formatSeconds } from "./units.ts";

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
    template.builds.find(({ id }) => id === template.current)?.base ?? "-",
    template.current ?? "-",
    template.state,
  ]),
];

const templateText = (template: Template, now: DateTime.Utc) =>
  [
    table([
      ["NAME", template.id],
      ["CURRENT", template.current ?? "-"],
      ["STATE", template.state],
    ]),
    "",
    table([
      ["BUILD", "PHASE", "HOST", "BASE", "IMAGE", "AGE", "ERROR"],
      ...template.builds.map((build) => [
        build.id,
        build.phase,
        build.host,
        build.base,
        build.image,
        age(build.createdAt, now),
        failure(build.error),
      ]),
    ]),
    "",
    table([
      ["BUILD", "CPU", "RAM", "DISK", "SETUP_TIMEOUT"],
      ...template.builds.map((build) => [
        build.id,
        String(build.cpu),
        formatMib(build.ramMib),
        formatGib(build.diskGib),
        build.setupTimeoutSeconds === undefined
          ? "-"
          : formatSeconds(build.setupTimeoutSeconds),
      ]),
    ]),
    "",
    table([
      ["BUILD", "COPY", "PHASE", "REASON"],
      ...template.builds.flatMap((build) =>
        build.copies.map((copy) => [
          build.id,
          copy.host,
          copy.phase,
          copy.reason ?? failure(copy.error),
        ])
      ),
    ]),
  ].join("\n");

export const buildTemplate = Command.make(
  "build",
  {
    ...mutationFlags,
    file: Argument.String("file").pipe(
      Argument.withDescription(
        "A template file, such as web.yaml, which builds the template web: its base, cpu, ram and disk, its setup, a script or a recipe directory holding setup.sh, against the file's directory, and an optional setupTimeout. The server runs the setup once, on a machine it copies and then deletes, and never keeps it."
      )
    ),
  },
  (flags) =>
    printResource(flags, {
      call: (client) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;

          return yield* client.buildTemplate(
            yield* readTemplateFile(path.resolve(flags.file))
          );
        }),
      encode: encodeBuild,
      text: newId,
    })
).pipe(
  Command.withDescription(
    `${actionsByName.buildTemplate.description} Waits until the build ends, unless --no-wait, and prints its ID, such as web@1.`
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
    `${actionsByName.getTemplate.description} Prints each build kept, with its base, the sizes a create from it takes at least, and why it failed if it did.`
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
