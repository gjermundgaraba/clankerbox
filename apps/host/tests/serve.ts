import { appendFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
  Schema,
} from "effect";

import { BuildsSettings } from "../src/platform/s3.ts";
import { Tailnet } from "../src/tailnet.ts";
import type { FakeRuntimeName } from "./fake-runtime.ts";
import { image as ubuntu, startHost, writeTailscaleStubs } from "./support.ts";

const usage =
  "usage: serve.ts <run-dir> <host-id> [smolvm|tart] [ram-budget-mib], with CLANKERBOX_FAKE_BUILDS, CLANKERBOX_FAKE_PIN and CLANKERBOX_FAKE_UBUNTU_IMAGE optional";

const [runArg, idArg, runtimeArg = "smolvm", budgetArg] = process.argv.slice(2);

const offered = {
  smolvm: ["ubuntu", process.env["CLANKERBOX_FAKE_UBUNTU_IMAGE"] ?? ubuntu],
  tart: ["macos", "registry.example/macos@sha256:00"],
} as const satisfies Record<FakeRuntimeName, readonly [string, string]>;

const isFaked = (text: string): text is FakeRuntimeName =>
  Object.hasOwn(offered, text);

const parsed = () => {
  const budget = budgetArg === undefined ? undefined : Number(budgetArg);

  if (
    runArg === undefined ||
    idArg === undefined ||
    !isFaked(runtimeArg) ||
    (budget !== undefined && !Number.isInteger(budget))
  ) {
    throw new Error(usage);
  }

  return {
    run: path.resolve(runArg),
    id: idArg,
    runtime: runtimeArg,
    ramBudgetMib: budget,
  };
};

const fakeTailnet = process.env["CLANKERBOX_FAKE_TAILNET"] === "1";

const slowKey = Effect.as(
  Effect.sleep(Duration.seconds(1)),
  Redacted.make("tskey-auth-fake")
);

const mintingAsSlowlyAsTailscale = Layer.succeed(Tailnet, {
  mint: slowKey,
  mintBuild: slowKey,
});

const decodeBuilds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BuildsSettings)
);

const buildsSetting = Effect.gen(function* () {
  const file = process.env["CLANKERBOX_FAKE_BUILDS"];

  return file === undefined
    ? undefined
    : yield* decodeBuilds(
        yield* (yield* FileSystem.FileSystem).readFileString(file)
      );
});

const serve = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { run, id, runtime, ramBudgetMib } = yield* Effect.try(parsed);
  const [base, image] = offered[runtime];
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

  const builds = yield* buildsSetting;

  const host = yield* startHost(dir, {
    id,
    ...(fakeTailnet ? { tailnet: mintingAsSlowlyAsTailscale } : {}),
    as: runtime,
    bases: new Map([[base, image]]),
    ...(previous === undefined ? {} : { port: Number(previous.port) }),
    logger: Logger.consolePretty({ colors: false }),
    ...(builds === undefined ? {} : { buildsSettings: builds }),
    http: NodeHttpClient.layerNodeHttp,
    runtime: {
      ramBudgetMib,
      pin: process.env["CLANKERBOX_FAKE_PIN"],
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
  yield* Console.log(`ready ${runtime} host ${id} at ${host.url}`);
  yield* write(`${url}.part`, `${host.url}\n`);
  yield* fs.rename(`${url}.part`, url);
  yield* write(pid, `${process.pid}\n`);

  return yield* Effect.never;
});

NodeRuntime.runMain(
  serve.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
