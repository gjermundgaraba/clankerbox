import { appendFileSync } from "node:fs";
import path from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Kind } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Redacted,
} from "effect";

import { Tailnet } from "../src/tailnet.ts";
import { image as ubuntu, startHost, writeTailscaleStubs } from "./support.ts";

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

const fakeTailnet = process.env["CLANKERBOX_FAKE_TAILNET"] === "1";

const mintingAsSlowlyAsTailscale = Layer.succeed(Tailnet, {
  mint: Effect.as(
    Effect.sleep(Duration.seconds(1)),
    Redacted.make("tskey-auth-fake")
  ),
});

const offered = {
  linux: ["ubuntu", ubuntu],
  mac: ["macos", "registry.example/macos@sha256:00"],
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

  const dir = path.join(yield* scratch, "host");

  if (fakeTailnet) {
    writeTailscaleStubs(path.join(dir, "bin"));
  }

  const host = yield* startHost(dir, {
    id,
    ...(fakeTailnet ? { tailnet: mintingAsSlowlyAsTailscale } : {}),
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
