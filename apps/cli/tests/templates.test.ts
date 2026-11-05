import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { mkdir, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { loginSetup, running } from "@gjermundgaraba/clankerbox-server/testing";
import { Effect, Schema } from "effect";
import { expect, vi } from "vite-plus/test";

import { ErrorDocument } from "../src/command.ts";
import { cli } from "./support.ts";

vi.setConfig({ testTimeout: 30_000 });

const http = NodeHttpClient.layerNodeHttp;

const decodeFailure = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ error: ErrorDocument }))
);

const TemplateJson = Schema.fromJsonString(
  Schema.Struct({
    base: Schema.String,
    cpu: Schema.Int,
    ramMib: Schema.Int,
    diskGib: Schema.Int,
    setupTimeoutSeconds: Schema.optionalKey(Schema.Int),
    current: Schema.String,
    builds: Schema.Array(Schema.Struct({ id: Schema.String })),
  })
);

const decodeTemplate = Schema.decodeSync(TemplateJson);

const home = (dir: string, name: string, url: string) =>
  Effect.gen(function* () {
    const root = path.join(dir, name);

    yield* mkdir(path.join(root, ".config", "clankerbox"));
    yield* write(
      path.join(root, ".config", "clankerbox", "config.json"),
      JSON.stringify({ server: url })
    );

    return (args: readonly string[]) =>
      cli(args, { http, env: { HOME: root } });
  });

const webFile = (cpu: number) =>
  `base: ubuntu\ncpu: ${cpu}\nram: 1G\ndisk: 10G\nsetupTimeout: 90s\nsetup: ../recipes/web\n`;

const writeTemplate = (dir: string, contents: string) =>
  Effect.gen(function* () {
    const recipe = path.join(dir, "recipes", "web");
    const file = path.join(dir, "templates", "web.yaml");

    yield* mkdir(recipe);
    yield* mkdir(path.dirname(file));
    yield* write(
      path.join(recipe, "setup.sh"),
      `#!/bin/sh\nset -eu\n${loginSetup}`
    );
    yield* write(file, contents);

    return file;
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a build reads its template, base, sizes and setup from a file, and a rebuild reads the file again",
    () =>
      Effect.gen(function* () {
        const { dir, url } = yield* Effect.orDie(running());
        const run = yield* home(dir, "client", url);
        const file = yield* writeTemplate(dir, webFile(1));

        const first = yield* run(["template", "build", file]);

        yield* write(file, webFile(2));

        const rebuilt = yield* run(["template", "build", file]);
        const got = yield* run(["template", "get", "web", "--json"]);

        expect(
          [first, rebuilt].map(({ code, stdout }) => [code, stdout])
        ).toStrictEqual([
          [0, "web@1"],
          [0, "web@2"],
        ]);
        expect(decodeTemplate(got.stdout)).toStrictEqual({
          base: "ubuntu",
          cpu: 2,
          ramMib: 1024,
          diskGib: 10,
          setupTimeoutSeconds: 90,
          current: "web@2",
          builds: [{ id: "web@1" }, { id: "web@2" }],
        });
      })
  );

  it.effect(
    "a file missing a field is Invalid with its file, and the build's old flags are refused, each before a request",
    () =>
      Effect.gen(function* () {
        const { dir, url } = yield* Effect.orDie(running());
        const run = yield* home(dir, "client", url);

        const file = yield* writeTemplate(
          dir,
          "base: ubuntu\ncpu: 1\nram: 1G\nsetup: ../recipes/web\n"
        );

        const missing = yield* run(["template", "build", file, "--json"]);

        const flagged = yield* run([
          "template",
          "build",
          "--base",
          "ubuntu",
          file,
        ]);

        const listed = yield* run(["template", "list"]);

        expect(missing.code).toBe(1);
        expect(decodeFailure(missing.stdout).error).toMatchObject({
          tag: "Invalid",
          file,
          message: `template file ${file}: disk: missing`,
        });
        expect(flagged.code).not.toBe(0);
        expect(flagged.stderr).toContain("--base");
        expect(listed.stderr).toBe("clankerbox: no templates to list");
      })
  );

  it.effect("template list reads the server, from any client home", () =>
    Effect.gen(function* () {
      const { dir, url } = yield* Effect.orDie(running());
      const builder = yield* home(dir, "builder", url);
      const other = yield* home(dir, "other", url);
      const file = yield* writeTemplate(dir, webFile(1));

      const empty = yield* other(["template", "list"]);
      const built = yield* builder(["template", "build", file]);

      const listed = yield* other(["template", "list"]);
      const deleted = yield* other(["template", "delete", "web"]);
      const after = yield* builder(["template", "list"]);

      expect(empty).toMatchObject({
        code: 0,
        stdout: "",
        stderr: "clankerbox: no templates to list",
      });
      expect(built).toMatchObject({ code: 0, stdout: "web@1" });
      expect(listed.stdout.split("\n")).toStrictEqual([
        expect.stringMatching(/^NAME\s+BASE\s+CURRENT\s+STATE$/u),
        expect.stringMatching(/^web\s+ubuntu\s+web@1\s+ready$/u),
      ]);
      expect(deleted).toMatchObject({ code: 0, stdout: "web" });
      expect(after.stderr).toBe("clankerbox: no templates to list");
    })
  );
});
