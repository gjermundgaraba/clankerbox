import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { hostKeySetup } from "@gjermundgaraba/clankerbox-host/testing";
import { readAuthorizedKeys } from "@gjermundgaraba/clankerbox-sdk";
import { mkdir, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { Console, Duration, Effect, FileSystem, Layer, Logger } from "effect";
import { HttpServer } from "effect/http";

import { serverLayer, stopsAtOnce } from "../src/composition/server.ts";
import {
  defaultFailedRowsLast,
  defaultHookTimeoutSeconds,
} from "../src/settings.ts";

const usage =
  "usage: serve.ts <run-dir>, with hosts in <run-dir>/hosts, each draining while <run-dir>/hosts/<id>.draining exists";

const [runArg] = process.argv.slice(2);

const parsed = () => {
  if (runArg === undefined) {
    throw new Error(usage);
  }

  return path.resolve(runArg);
};

const webRecipe = (run: string) => `#!/bin/sh
${hostKeySetup}echo web-recipe >"${run}/recipe-ran"
`;

const slowRecipe = (run: string) => `#!/bin/sh
${hostKeySetup}touch "${run}/setup-began"
while [ ! -e "${run}/setup-go" ]; do sleep 0.05; done
echo slow-recipe >"${run}/recipe-ran"
`;

const templates = {
  smolvm: "base: ubuntu\ncpu: 1\nram: 1G\ndisk: 10G\n",
  tart: "base: macos\ncpu: 1\nram: 1G\ndisk: 10G\n",
  boat: "base: ubuntu\ncpu: 2\nram: 4G\ndisk: 80G\n",
} as const;

const isTemplated = (runtime: string): runtime is keyof typeof templates =>
  Object.hasOwn(templates, runtime);

const memberOf = (run: string) => (file: string) => {
  const id = path.basename(file, ".url");

  return {
    id,
    url: readFileSync(path.join(run, "hosts", file), "utf8").trim(),
    get draining() {
      return existsSync(path.join(run, "hosts", `${id}.draining`));
    },
  };
};

const clientFiles = (run: string, url: string) =>
  Effect.gen(function* () {
    const home = path.join(run, "client-home");
    const client = path.join(home, ".config", "clankerbox");

    yield* mkdir(client);
    yield* write(
      path.join(client, "config.json"),
      JSON.stringify({ server: url })
    );

    const runtime = readFileSync(path.join(run, "runtime"), "utf8").trim();
    const template = templates[isTemplated(runtime) ? runtime : "smolvm"];

    for (const [name, recipe] of [
      ["web", webRecipe(run)],
      ["slow", slowRecipe(run)],
    ] as const) {
      yield* mkdir(path.join(run, "recipes", name));
      yield* write(path.join(run, "recipes", name, "setup.sh"), recipe);
      yield* write(
        path.join(run, "recipes", `${name}.yaml`),
        `${template}setup: ${name}\n`
      );
    }

    yield* write(path.join(run, "home"), `${home}\n`);
  });

const serve = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const run = yield* Effect.try(parsed);
  const urlFile = path.join(run, "server.url");

  const previous = (yield* fs.exists(urlFile))
    ? new URL((yield* fs.readFileString(urlFile)).trim())
    : undefined;

  const hosts = readdirSync(path.join(run, "hosts"))
    .filter((file) => file.endsWith(".url"))
    .map(memberOf(run));

  const keys = path.join(run, "server-keys.pub");

  if (!(yield* fs.exists(keys))) {
    yield* write(keys, `${operatorKey}\n`);
  }

  const settings = {
    listen: { address: "127.0.0.1", port: Number(previous?.port ?? 0) },
    stateDir: path.join(run, "server-state"),
    hosts,
    recheck: Duration.seconds(2),
    failedRowsLast: defaultFailedRowsLast,
    authorizedKeys: yield* readAuthorizedKeys(keys),
    hookTimeoutSeconds: defaultHookTimeoutSeconds,
  };

  return yield* Layer.launch(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const { address } = yield* HttpServer.HttpServer;
        const url = HttpServer.formatAddress(address);

        yield* clientFiles(run, url);
        yield* write(path.join(run, "server.pid"), `${process.pid}\n`);
        yield* write(urlFile, `${url}\n`);
        yield* Console.log(`ready control plane at ${url}`);
        yield* write(path.join(run, "server.ready.part"), `${url}\n`);
        yield* fs.rename(
          path.join(run, "server.ready.part"),
          path.join(run, "server.ready")
        );
      })
    ).pipe(
      Layer.provideMerge(
        serverLayer(
          settings,
          NodeHttpServer.layer(createServer, {
            host: settings.listen.address,
            port: settings.listen.port,
            ...stopsAtOnce,
          })
        )
      ),
      Layer.provide(NodeHttpClient.layerNodeHttp),
      Layer.provide(Logger.layer([Logger.consolePretty({ colors: false })]))
    )
  );
});

NodeRuntime.runMain(serve.pipe(Effect.provide(NodeServices.layer)));
