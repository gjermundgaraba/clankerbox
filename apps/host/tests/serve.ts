import { appendFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { Caller, Tls } from "@gjermundgaraba/clankerbox-sdk/node";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, FileSystem, Logger, Schema } from "effect";

import { loadConfig } from "../src/composition/config.ts";
import * as NodeBox from "../src/platform/box.ts";
import * as S3 from "../src/platform/bucket/s3.ts";
import { publishAddress } from "../src/settings.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import type { FakeRuntimeName } from "./fake-runtime.ts";
import {
  fakeTailnet,
  tailscaleRefuses,
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
  "usage: serve.ts <run-dir> <host-id> [smolvm|tart|fixed] [ram-budget-mib], with CLANKERBOX_FAKE_BUILDS, CLANKERBOX_FAKE_FAIL_FIND (names whose search fails), CLANKERBOX_FAKE_PIN, CLANKERBOX_FAKE_UBUNTU_IMAGE and CLANKERBOX_HOST_CONFIG (a host config whose listen, publish, callers and tls the host takes) optional";

const [runArg, idArg, runtimeArg = "smolvm", budgetArg] = process.argv.slice(2);

const offered = {
  smolvm: ["ubuntu", process.env["CLANKERBOX_FAKE_UBUNTU_IMAGE"] ?? ubuntu],
  tart: ["macos", "registry.example/macos@sha256:00"],
  fixed: ["ubuntu", ubuntu],
  copiesRunning: ["ubuntu", ubuntu],
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
  Schema.fromJsonString(S3.BuildsSettings)
);

interface Configured {
  readonly address?: string;
  readonly port?: number;
  readonly publishAddress?: string;
  readonly callers?: readonly Caller[];
  readonly tls?: Tls;
}

const configured = Effect.gen(function* () {
  const file = process.env["CLANKERBOX_HOST_CONFIG"];

  if (file === undefined) {
    const none: Configured = {};

    return none;
  }

  const config = yield* loadConfig(file).pipe(
    Effect.provide(NodeBox.layer),
    Effect.orDie
  );

  const read: Configured = {
    address: config.listen.address,
    port: config.listen.port,
    publishAddress: publishAddress(config),
    ...(config.callers === undefined ? {} : { callers: config.callers }),
    ...(config.tls === undefined ? {} : { tls: config.tls }),
  };

  return read;
});

const bucket = Effect.gen(function* () {
  const file = process.env["CLANKERBOX_FAKE_BUILDS"];

  return file === undefined
    ? undefined
    : yield* S3.make(
        yield* decodeBuilds(
          yield* (yield* FileSystem.FileSystem).readFileString(file)
        )
      ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
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
          writeTailscaleStubs(path.join(kept, "bin"), tailscaleRefuses);
        }

        const builds = yield* bucket;
        const { publishAddress: published, ...listening } = yield* configured;

        const host = yield* startHost(dir, {
          id,
          tailnet: fakeTailnet,
          as: runtime,
          bases: new Map([[base, image]]),
          ...(port === undefined ? {} : { port }),
          ...listening,
          logger: Logger.consolePretty({ colors: false }),
          http: NodeHttpClient.layerNodeHttp,
          fake: fakeRuntime({
            dir: kept,
            as: runtime,
            ramBudgetMib,
            pin: process.env["CLANKERBOX_FAKE_PIN"],
            probesPorts: true,
            publishAddress: published,
            builds,
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
