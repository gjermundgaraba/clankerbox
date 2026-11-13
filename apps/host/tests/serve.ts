import { appendFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
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
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";

import { BuildsSettings } from "../src/platform/s3.ts";
import { Tailnet } from "../src/tailnet.ts";
import type { FakeRuntimeName } from "./fake-runtime.ts";
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

const fakeTailnet = process.env["CLANKERBOX_FAKE_TAILNET"] === "1";

const failingFinds = (process.env["CLANKERBOX_FAKE_FAIL_FIND"] ?? "")
  .split(",")
  .filter((name) => name !== "");

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

const Fault = Schema.TaggedUnion({
  "hold-capture": {},
  drift: { machine: Schema.String },
  "land-late": {},
});

const decodeFault = Schema.decodeUnknownEffect(Schema.fromJsonString(Fault));

const landsLateBy = Duration.seconds(5);

interface Answer {
  readonly took: boolean;
  readonly said: string;
}

const refused = (said: string): Answer => ({ took: false, said });

const doorbell = Stream.callback<undefined>((queue) => {
  const ring = () => {
    Queue.offerUnsafe(queue, undefined);
  };

  return Effect.acquireRelease(
    Effect.sync(() => process.on("SIGUSR2", ring)),
    () => Effect.sync(() => process.off("SIGUSR2", ring))
  );
});

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
      relayed: runtime === "tart",
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

  for (const name of failingFinds) {
    host.fake.failFind(
      name,
      new Internal({ message: `fake find ${name} failed: database is locked` })
    );
  }

  const { traits, owned } = presets[runtime];

  const take = (fault: typeof Fault.Type): Effect.Effect<Answer> =>
    Fault.match(fault, {
      "hold-capture": () =>
        Effect.sync(() => {
          host.fake.holdNext("capture");

          return { took: true, said: `host ${id} holds its next capture` };
        }),
      drift: ({ machine }) => {
        if (!traits.stopsOnItsOwn) {
          return Effect.succeed(
            refused(
              `host ${id} fakes ${runtime}, whose machines never stop on their own`
            )
          );
        }

        const found = host.fake.machines.get(machine);

        return found?.state === "running"
          ? Effect.as(host.fake.faults.drift(found.instance), {
              took: true,
              said: `host ${id} stopped ${machine} (${found.instance}) on its own`,
            })
          : Effect.succeed(
              refused(`host ${id} has no running machine ${machine}`)
            );
      },
      "land-late": () =>
        owned === undefined
          ? Effect.succeed(
              refused(
                `host ${id} fakes ${runtime}, which marks nothing it makes, so no sweep would find a machine that landed late`
              )
            )
          : Effect.as(host.fake.faults.landLate(landsLateBy), {
              took: true,
              said: `host ${id} fails its next make and lands its machine ${Duration.format(landsLateBy)} later`,
            }),
    });

  const request = path.join(hosts, `${id}.fault`);

  const answered = Effect.gen(function* () {
    const text = yield* fs.readFileString(request);

    yield* fs.remove(request);

    return yield* take(yield* decodeFault(text));
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        refused(`host ${id} couldn't read its fault: ${error.message}`)
      )
    ),
    Effect.tap(({ said }) => Effect.logInfo(`fault: ${said}`)),
    Effect.flatMap(({ took, said }) => {
      const answer = `${request}.${took ? "ok" : "refused"}`;

      return Effect.andThen(
        write(`${answer}.part`, `${said}\n`),
        fs.rename(`${answer}.part`, answer)
      );
    }),
    Effect.orDie
  );

  yield* Effect.forkScoped(Stream.runForEach(doorbell, () => answered));
  yield* Console.log(`ready ${runtime} host ${id} at ${host.url}`);
  yield* write(`${url}.part`, `${host.url}\n`);
  yield* fs.rename(`${url}.part`, url);
  yield* write(pid, `${process.pid}\n`);

  return yield* Effect.never;
});

NodeRuntime.runMain(
  serve.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
