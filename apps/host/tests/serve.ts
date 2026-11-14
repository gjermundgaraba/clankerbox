import { appendFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, FileSystem, Logger, Schema } from "effect";

import { BuildsSettings } from "../src/platform/s3.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import type { FakeRuntimeName } from "./fake-runtime.ts";
import {
  fakeTailnet,
  mintingAsSlowlyAsTailscale,
  runServe,
  serveHost,
  taking,
} from "./serving.ts";
import {
  presets,
  image as ubuntu,
  startHost,
  writeTailscaleStubs,
} from "./support.ts";

const usage =
  "usage: serve.ts <run-dir> <host-id> [smolvm|tart|fixed] [ram-budget-mib], with CLANKERBOX_FAKE_BUILDS, CLANKERBOX_FAKE_FAIL_FIND (names whose search fails), CLANKERBOX_FAKE_PIN and CLANKERBOX_FAKE_UBUNTU_IMAGE optional";

const [runArg, idArg, runtimeArg = "smolvm", budgetArg] = process.argv.slice(2);

const offered = {
  smolvm: ["ubuntu", process.env["CLANKERBOX_FAKE_UBUNTU_IMAGE"] ?? ubuntu],
  tart: ["macos", "registry.example/macos@sha256:00"],
  fixed: ["ubuntu", ubuntu],
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

const failingFinds = (process.env["CLANKERBOX_FAKE_FAIL_FIND"] ?? "")
  .split(",")
  .filter((name) => name !== "");

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

runServe(
  Effect.gen(function* () {
    const { run, id, runtime, ramBudgetMib } = yield* Effect.try(parsed);
    const [base, image] = offered[runtime];
    const evidence = path.join(run, "evidence");

    return yield* serveHost(run, id, (port) =>
      Effect.gen(function* () {
        const dir = path.join(yield* scratch, "host");
        const kept = path.join(run, "runtimes", id);

        if (fakeTailnet) {
          writeTailscaleStubs(path.join(kept, "bin"));
        }

        const builds = yield* buildsSetting;

        const host = yield* startHost(dir, {
          id,
          ...(fakeTailnet ? { tailnet: mintingAsSlowlyAsTailscale } : {}),
          as: runtime,
          bases: new Map([[base, image]]),
          ...(port === undefined ? {} : { port }),
          logger: Logger.consolePretty({ colors: false }),
          ...(builds === undefined ? {} : { buildsSettings: builds }),
          http: NodeHttpClient.layerNodeHttp,
          fake: fakeRuntime({
            dir: kept,
            as: runtime,
            ramBudgetMib,
            pin: process.env["CLANKERBOX_FAKE_PIN"],
            onCall: (call) => {
              appendFileSync(
                path.join(evidence, "runtime-calls.txt"),
                `${call}\n`
              );
            },
          }),
        });

        for (const name of failingFinds) {
          host.fake.failFind(
            name,
            new Internal({
              message: `fake find ${name} failed: database is locked`,
            })
          );
        }

        const { stopsOnItsOwn, owned } = presets[runtime];

        return {
          url: host.url,
          runtime,
          take: taking({
            name: `host ${id}`,
            faults: host.fake.faults,
            holdCapture: Effect.sync(() => {
              host.fake.holdNext("capture");
            }),
            drift: stopsOnItsOwn
              ? {
                  _tag: "by-name",
                  running: (machine) => {
                    const found = host.fake.machines.get(machine);

                    return found?.state === "running"
                      ? found.instance
                      : undefined;
                  },
                }
              : {
                  _tag: "never",
                  because: `host ${id} fakes ${runtime}, whose machines never stop on their own`,
                },
            sweeps: owned,
            repin: (pin) =>
              Effect.sync(() => {
                host.fake.repin(pin);
              }),
          }),
        };
      })
    );
  })
);
