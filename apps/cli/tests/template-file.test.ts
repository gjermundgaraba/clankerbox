import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Invalid, readSetup } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect } from "effect";
import { expect } from "vite-plus/test";

import { readTemplateFile } from "../src/template-file.ts";

const script = "#!/bin/sh\necho set up\n";

const fields = {
  base: "base: ubuntu",
  cpu: "cpu: 8",
  ram: "ram: 16G",
  disk: "disk: 100G",
  setup: "setup: gg-linux-dev",
};

const yaml = (lines: Record<string, string>) =>
  `${Object.values(lines).join("\n")}\n`;

const written = (name: string, contents: string) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const recipe = path.join(dir, "gg-linux-dev");

    yield* mkdir(recipe);
    yield* write(path.join(recipe, "setup.sh"), script);
    yield* mkdir(path.join(dir, "empty"));

    const file = path.join(dir, name);

    yield* write(file, contents);

    return { dir, file };
  });

const refusal = (name: string, contents: string) =>
  Effect.gen(function* () {
    const { dir, file } = yield* written(name, contents);
    const error = yield* Effect.flip(readTemplateFile(file));

    return { dir, file, error };
  });

const fileRefusals = [
  {
    case: "a missing field",
    name: "web.yaml",
    contents: yaml({ ...fields, disk: "" }),
    message: "disk: missing",
  },
  {
    case: "an unknown key",
    name: "web.yaml",
    contents: yaml({ ...fields, typo: "setup_timeout: 15m" }),
    message: "setup_timeout: not a known field",
  },
  {
    case: "an unknown unit",
    name: "web.yaml",
    contents: yaml({ ...fields, ram: "ram: 16T" }),
    message:
      'ram "16T" isn\'t a size: write a number and M or G, such as 512M or 8G',
  },
  {
    case: "a duration it can't read",
    name: "web.yaml",
    contents: yaml({ ...fields, setupTimeout: "setupTimeout: soon" }),
    message:
      'setupTimeout "soon" isn\'t a duration: write it in d, h, m and s, such as 90s or 1h30m',
  },
  {
    case: "a stem that isn't a name",
    name: "Bad_Name.yaml",
    contents: yaml(fields),
    message:
      "its stem names the template: a name is 1 to 62 characters: it starts with a letter, then letters, digits and '-', with no '--' and no '-' at the end",
  },
  {
    case: "a name that isn't YAML's",
    name: "web.json",
    contents: yaml(fields),
    message: "a template file's name ends .yaml or .yml",
  },
  {
    case: "broken YAML",
    name: "web.yaml",
    contents: "base: ubuntu\n\tcpu: 8\n",
    message: "Tabs cannot be used for YAML indentation at line 2",
  },
  {
    case: "YAML that isn't a mapping",
    name: "web.yaml",
    contents: "- ubuntu\n",
    message: "Expected object",
  },
];

const setupRefusals = [
  {
    case: "a setup path that isn't there",
    setup: "missing",
    message: (setup: string) =>
      `couldn't read setup ${setup}: no such file or directory`,
  },
  {
    case: "a recipe directory without setup.sh",
    setup: "empty",
    message: (setup: string) => `recipe ${setup} has no setup.sh`,
  },
];

layer(NodeServices.layer)((it) => {
  it.effect(
    "a file builds the template its stem names, from its base and sizes, with its setup read against its directory",
    () =>
      Effect.gen(function* () {
        const { dir, file } = yield* written(
          "gg-linux-dev.yaml",
          yaml({ ...fields, setupTimeout: "setupTimeout: 15m" })
        );

        expect(yield* readTemplateFile(file)).toStrictEqual({
          template: "gg-linux-dev",
          base: "ubuntu",
          cpu: 8,
          ramMib: 16_384,
          diskGib: 100,
          setup: {
            script: yield* readSetup(path.join(dir, "gg-linux-dev")),
            timeoutSeconds: 900,
          },
        });
      })
  );

  it.effect(
    "a .yml file naming a script, with no setupTimeout, sends no timeout",
    () =>
      Effect.gen(function* () {
        const { dir, file } = yield* written(
          "web.yml",
          yaml({ ...fields, setup: "setup: scripts/web.sh" })
        );

        yield* mkdir(path.join(dir, "scripts"));
        yield* write(path.join(dir, "scripts", "web.sh"), script);

        expect(yield* readTemplateFile(file)).toStrictEqual({
          template: "web",
          base: "ubuntu",
          cpu: 8,
          ramMib: 16_384,
          diskGib: 100,
          setup: { script },
        });
      })
  );

  for (const { case: what, name, contents, message } of fileRefusals) {
    it.effect(`${what} is Invalid with the file`, () =>
      Effect.gen(function* () {
        const { file, error } = yield* refusal(name, contents);

        expect(error).toStrictEqual(
          new Invalid({ message: `template file ${file}: ${message}`, file })
        );
      })
    );
  }

  it.effect("a file that isn't there is Invalid with the file", () =>
    Effect.gen(function* () {
      const file = path.join(yield* scratch, "web.yaml");

      expect(yield* Effect.flip(readTemplateFile(file))).toStrictEqual(
        new Invalid({
          message: `template file ${file}: no such file or directory`,
          file,
        })
      );
    })
  );

  for (const { case: what, setup, message } of setupRefusals) {
    it.effect(`${what} is Invalid with the setup's path`, () =>
      Effect.gen(function* () {
        const { dir, error } = yield* refusal(
          "web.yaml",
          yaml({ ...fields, setup: `setup: ${setup}` })
        );

        const resolved = path.join(dir, setup);

        expect(error).toStrictEqual(
          new Invalid({ message: message(resolved), file: resolved })
        );
      })
    );
  }
});
