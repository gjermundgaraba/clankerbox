import { appendFileSync } from "node:fs";
import path from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { requirements } from "@gjermundgaraba/clankerbox-sdk";
import type { Kind } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { Console, Duration, Effect, FileSystem, Logger } from "effect";

import { loginSetup, startHost } from "./support.ts";

const usage = "usage: serve.ts <run-dir> [linux|mac] [ram-budget-mib]";

const [runArg, kindArg = "linux", budgetArg] = process.argv.slice(2);

const isKind = (text: string): text is Kind =>
  text === "linux" || text === "mac";

const parsed = () => {
  const budget = budgetArg === undefined ? undefined : Number(budgetArg);

  if (
    runArg === undefined ||
    !isKind(kindArg) ||
    (budget !== undefined && !Number.isInteger(budget))
  ) {
    throw new Error(usage);
  }

  return { run: path.resolve(runArg), kind: kindArg, ramBudgetMib: budget };
};

const offered = {
  linux: ["ubuntu", requirements.bases.linux.ubuntu],
  mac: ["macos", requirements.bases.mac.macos],
} as const;

const webRecipe = `#!/bin/sh
set -eu
${loginSetup}echo web-recipe >"$CLANKERBOX_ROOT/recipe-ran"
`;

const serve = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { run, kind, ramBudgetMib } = yield* Effect.try(parsed);
  const [base, image] = offered[kind];
  const evidence = path.join(run, "evidence");
  const dir = yield* scratch;
  const home = path.join(dir, "home");
  const client = path.join(home, ".config", "clankerbox");

  const served = ["ready", "home", "host.pid"].map((file) =>
    path.join(run, file)
  );

  yield* Effect.forEach([evidence, path.join(client, "profiles")], mkdir);

  const host = yield* startHost(path.join(dir, "host"), {
    kind,
    bases: new Map([[base, image]]),
    logger: Logger.consolePretty({ colors: false }),
    recheck: Duration.seconds(5),
    runtime: {
      ramBudgetMib,
      onCall: (call) => {
        appendFileSync(path.join(evidence, "runtime-calls.txt"), `${call}\n`);
      },
    },
  });

  yield* write(path.join(client, "id.pub"), `${operatorKey}\n`);
  yield* write(
    path.join(client, "config.json"),
    JSON.stringify({
      hosts: [{ id: kind, url: host.url }],
      authorizedKeys: "id.pub",
      profiles: "profiles",
    })
  );
  yield* write(
    path.join(client, "profiles", "web.json"),
    JSON.stringify({
      base,
      cpu: 1,
      ramMib: 1024,
      diskGib: 10,
      setup: { path: "web-recipe.sh", timeoutSeconds: 60 },
    })
  );
  yield* write(path.join(client, "profiles", "web-recipe.sh"), webRecipe);

  yield* Effect.addFinalizer(() =>
    Effect.forEach(served, (file) => fs.remove(file, { force: true })).pipe(
      Effect.ignore
    )
  );
  yield* write(path.join(run, "home"), `${home}\n`);
  yield* write(path.join(run, "host.pid"), `${process.pid}\n`);
  yield* Console.log(`ready ${kind} host at ${host.url}`);
  yield* write(path.join(run, "ready.part"), `${host.url}\n`);
  yield* fs.rename(path.join(run, "ready.part"), path.join(run, "ready"));

  return yield* Effect.never;
});

NodeRuntime.runMain(
  serve.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
