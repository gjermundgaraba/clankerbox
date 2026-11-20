import type { BuildRequest } from "@gjermundgaraba/clankerbox-sdk";
import {
  describeFileError,
  describeIssues,
  Invalid,
  Name,
  readSetup,
  RuntimeName,
  Size,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Path, Predicate, Schema } from "effect";
import { Yaml } from "effect/encoding";

import { parseGib, parseMib, parseSeconds } from "./units.ts";

const TemplateFile = Schema.Struct({
  base: Schema.String,
  runtime: RuntimeName,
  cpu: Size,
  ram: Schema.String,
  disk: Schema.String,
  setupTimeout: Schema.optionalKey(Schema.String),
  setup: Schema.String,
  tailnet: Schema.optionalKey(Schema.Boolean),
});

const decodeTemplateFile = Schema.decodeUnknownEffect(TemplateFile);

const decodeName = Schema.decodeUnknownEffect(Name);

const extensions = new Set([".yaml", ".yml"]);

/**
 * The build a template file asks for, from `base` on `runtime`: the template is the file's stem,
 * and `setup` is read from its path against the file's directory. With `tailnet: true`, its setup
 * runs on the control plane's tailnet and each clone of the build joins it.
 */
export const readTemplateFile = (
  file: string
): Effect.Effect<BuildRequest, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const invalid = (message: string) =>
      new Invalid({ message: `template file ${file}: ${message}`, file });

    const extension = path.extname(file);

    if (!extensions.has(extension)) {
      return yield* invalid("a template file's name ends .yaml or .yml");
    }

    const template = yield* decodeName(path.basename(file, extension)).pipe(
      Effect.mapError((error) =>
        invalid(`its stem names the template: ${describeIssues(error)}`)
      )
    );

    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((error) => invalid(describeFileError(error))));

    const parsed = yield* Effect.try({
      try: () => Yaml.parse(text),
      catch: (error) =>
        invalid(Predicate.isError(error) ? error.message : String(error)),
    });

    const fields = yield* decodeTemplateFile(parsed, {
      onExcessProperty: "error",
      errors: "all",
    }).pipe(Effect.mapError((error) => invalid(describeIssues(error))));

    const units = Effect.mapError(({ message }: Invalid) => invalid(message));

    const ramMib = yield* units(parseMib("ram", fields.ram));
    const diskGib = yield* units(parseGib("disk", fields.disk));

    const timeoutSeconds =
      fields.setupTimeout === undefined
        ? undefined
        : yield* units(parseSeconds("setupTimeout", fields.setupTimeout));

    const script = yield* readSetup(
      path.resolve(path.dirname(file), fields.setup)
    );

    return {
      template,
      base: fields.base,
      runtime: fields.runtime,
      cpu: fields.cpu,
      ramMib,
      diskGib,
      setup:
        timeoutSeconds === undefined ? { script } : { script, timeoutSeconds },
      ...(fields.tailnet === true ? { tailnet: true } : {}),
    };
  });
