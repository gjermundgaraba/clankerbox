import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
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
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http";

import { hostLayer } from "../../src/composition/host.ts";
import * as SmolCloud from "../../src/platform/smol-cloud/smol-cloud.ts";
import { Tailnet } from "../../src/tailnet.ts";
import { fakeSmolCloud } from "../fake-smol-cloud.ts";
import {
  hostConfig,
  image,
  loopbackServer,
  writeTailscaleStubs,
} from "../support.ts";

const usage =
  "usage: serve.ts <run-dir> <host-id> [smol-cloud] [ram-budget-mib], or serve.ts <run-dir> --api, with CLANKERBOX_FAKE_TAILNET optional";

const [runArg, second, , budgetArg] = process.argv.slice(2);

const fakeTailnet = process.env["CLANKERBOX_FAKE_TAILNET"] === "1";

const key = "fake-smol-cloud-key";

const sweepMargin = Duration.seconds(1);

const landsLateBy = Duration.seconds(5);

const Fault = Schema.TaggedUnion({
  "hold-capture": {},
  drift: { machine: Schema.String },
  "land-late": {},
});

const decodeFault = Schema.decodeUnknownEffect(Schema.fromJsonString(Fault));

const slowKey = Effect.as(
  Effect.sleep(Duration.seconds(1)),
  Redacted.make("tskey-auth-fake")
);

const mintingAsSlowlyAsTailscale = Layer.succeed(Tailnet, {
  mint: slowKey,
  mintBuild: slowKey,
});

const doorbell = Stream.callback<undefined>((queue) => {
  const ring = () => {
    Queue.offerUnsafe(queue, undefined);
  };

  return Effect.acquireRelease(
    Effect.sync(() => process.on("SIGUSR2", ring)),
    () => Effect.sync(() => process.off("SIGUSR2", ring))
  );
});

const filesOf = (run: string) => {
  const home = path.join(run, "smol-cloud");

  return {
    home,
    url: path.join(home, "url"),
    key: path.join(home, "key"),
    pid: path.join(run, "hosts", "smol-cloud-api.pid"),
    log: path.join(run, "evidence", "smol-cloud-api.log"),
    calls: path.join(run, "evidence", "smol-cloud-calls.txt"),
  };
};

const alive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  });

const outlivingItsHosts = (run: string) =>
  Effect.gen(function* () {
    const files = filesOf(run);
    const fs = yield* FileSystem.FileSystem;

    yield* mkdir(files.home);

    const fake = yield* fakeSmolCloud({
      dir: path.join(files.home, "provider"),
      key,
      onCall: (call) => {
        appendFileSync(files.calls, `${call}\n`);
      },
    });

    if (fakeTailnet) {
      writeTailscaleStubs(path.join(files.home, "provider", "bin"));
    }

    yield* write(files.key, `${key}\n`);
    yield* write(`${files.url}.part`, `${fake.url}\n`);
    yield* fs.rename(`${files.url}.part`, files.url);
    yield* write(files.pid, `${process.pid}\n`);
    yield* Console.log(`ready fake smol cloud API at ${fake.url}`);

    return yield* Effect.never;
  });

const provider = (run: string) =>
  Effect.gen(function* () {
    const files = filesOf(run);
    const fs = yield* FileSystem.FileSystem;

    const running = (yield* fs.exists(files.pid))
      ? yield* alive(Number((yield* fs.readFileString(files.pid)).trim()))
      : false;

    if (!running) {
      yield* fs.remove(files.url, { force: true });

      const log = openSync(files.log, "a");

      spawn("vpx", [import.meta.filename, run, "--api"], {
        detached: true,
        stdio: ["ignore", log, log],
      }).unref();
    }

    const url = yield* fs.readFileString(files.url).pipe(
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(250)),
        times: 240,
      })
    );

    return { url: url.trim(), keyFile: files.key };
  });

const host = (run: string, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const evidence = path.join(run, "evidence");
    const hosts = path.join(run, "hosts");
    const url = path.join(hosts, `${id}.url`);
    const pid = path.join(hosts, `${id}.pid`);

    yield* Effect.forEach([evidence, hosts], mkdir);

    if (budgetArg !== undefined) {
      yield* Console.log(
        `host ${id} takes no RAM budget: its room is its account's limits`
      );
    }

    const previous = (yield* fs.exists(url))
      ? new URL((yield* fs.readFileString(url)).trim())
      : undefined;

    const cloud = yield* provider(run);
    const dir = path.join(yield* scratch, "host");

    const config = {
      ...hostConfig(path.join(dir, "state"), undefined, id),
      bases: new Map([["ubuntu", image]]),
      sweepMargin,
    };

    const context = yield* Layer.build(
      hostLayer(
        config,
        SmolCloud.layer({ apiKeyFile: cloud.keyFile, api: cloud.url }, config),
        loopbackServer(
          previous === undefined ? undefined : Number(previous.port)
        )
      ).pipe(
        Layer.provide(fakeTailnet ? mintingAsSlowlyAsTailscale : Layer.empty),
        Layer.provideMerge(NodeHttpClient.layerNodeHttp),
        Layer.provideMerge(
          Logger.layer([Logger.consolePretty({ colors: false })])
        )
      )
    );

    const served = HttpServer.formatAddress(
      Context.get(context, HttpServer.HttpServer).address
    );

    yield* Effect.addFinalizer(() =>
      Effect.forEach([url, pid], (file) =>
        fs.remove(file, { force: true })
      ).pipe(Effect.ignore)
    );

    const http = Context.get(context, HttpClient.HttpClient);

    const control = (fault: string, said: string) =>
      http
        .execute(
          HttpClientRequest.post(`${cloud.url}/_fake/${fault}`).pipe(
            HttpClientRequest.bearerToken(key)
          )
        )
        .pipe(
          Effect.map((response) =>
            response.status === 204
              ? { took: true, said }
              : {
                  took: false,
                  said: `the fake API answered ${response.status} to ${fault}`,
                }
          ),
          Effect.catch((error) =>
            Effect.succeed({
              took: false,
              said: `the fake API didn't answer ${fault}: ${error.message}`,
            })
          )
        );

    const take = (fault: typeof Fault.Type) =>
      Fault.match(fault, {
        "hold-capture": () =>
          control("hold-capture", `the fake API holds ${id}'s next capture`),
        drift: ({ machine }) =>
          Effect.succeed({
            took: false,
            said: `host ${id} can't drift ${machine}: smol cloud names a machine by its instance, which the host isn't told by name`,
          }),
        "land-late": () =>
          control(
            `land-late/${Duration.toMillis(landsLateBy)}`,
            `the fake API fails ${id}'s next make and lands its machine ${Duration.format(landsLateBy)} later`
          ),
      });

    const request = path.join(hosts, `${id}.fault`);

    const answered = Effect.gen(function* () {
      const text = yield* fs.readFileString(request);

      yield* fs.remove(request);

      return yield* take(yield* decodeFault(text));
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          took: false,
          said: `host ${id} couldn't read its fault: ${error.message}`,
        })
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
    yield* Console.log(`ready smol-cloud host ${id} at ${served}`);
    yield* write(`${url}.part`, `${served}\n`);
    yield* fs.rename(`${url}.part`, url);
    yield* write(pid, `${process.pid}\n`);

    return yield* Effect.never;
  });

const serve = Effect.gen(function* () {
  if (runArg === undefined || second === undefined) {
    return yield* Effect.die(usage);
  }

  const run = path.resolve(runArg);

  return yield* second === "--api" ? outlivingItsHosts(run) : host(run, second);
});

NodeRuntime.runMain(
  serve.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
