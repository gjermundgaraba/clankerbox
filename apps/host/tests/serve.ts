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
import { Console, Effect, FileSystem, Logger } from "effect";

import { startHost } from "./support.ts";

const usage =
  "usage: serve.ts <run-dir> <host-id> [linux|mac] [ram-budget-mib]";

const [runArg, idArg, kindArg = "linux", budgetArg] = process.argv.slice(2);

const isKind = (text: string): text is Kind =>
  text === "linux" || text === "mac";

const parsed = () => {
  const budget = budgetArg === undefined ? undefined : Number(budgetArg);

  if (
    runArg === undefined ||
    idArg === undefined ||
    !isKind(kindArg) ||
    (budget !== undefined && !Number.isInteger(budget))
  ) {
    throw new Error(usage);
  }

  return {
    run: path.resolve(runArg),
    id: idArg,
    kind: kindArg,
    ramBudgetMib: budget,
  };
};

const offered = {
  linux: ["ubuntu", requirements.bases.linux.ubuntu],
  mac: ["macos", requirements.bases.mac.macos],
} as const;

const serve = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { run, id, kind, ramBudgetMib } = yield* Effect.try(parsed);
  const [base, image] = offered[kind];
  const evidence = path.join(run, "evidence");
  const hosts = path.join(run, "hosts");
  const url = path.join(hosts, `${id}.url`);
  const pid = path.join(hosts, `${id}.pid`);

  yield* Effect.forEach([evidence, hosts], mkdir);

  const previous = (yield* fs.exists(url))
    ? new URL((yield* fs.readFileString(url)).trim())
    : undefined;

  const host = yield* startHost(path.join(yield* scratch, "host"), {
    id,
    kind,
    bases: new Map([[base, image]]),
    ...(previous === undefined ? {} : { port: Number(previous.port) }),
    logger: Logger.consolePretty({ colors: false }),
    runtime: {
      ramBudgetMib,
      onCall: (call) => {
        appendFileSync(path.join(evidence, "runtime-calls.txt"), `${call}\n`);
      },
    },
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([url, pid], (file) => fs.remove(file, { force: true })).pipe(
      Effect.ignore
    )
  );
  process.on("SIGUSR2", () => {
    host.fake.holdNext("capture");
  });
  yield* Console.log(`ready ${kind} host ${id} at ${host.url}`);
  yield* write(`${url}.part`, `${host.url}\n`);
  yield* fs.rename(`${url}.part`, url);
  yield* write(pid, `${process.pid}\n`);

  return yield* Effect.never;
});

NodeRuntime.runMain(
  serve.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
