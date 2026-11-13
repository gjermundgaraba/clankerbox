import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
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
import type { Scope } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import { hostLayer } from "../src/composition/host.ts";
import type { CannotStart, Runtime } from "../src/runtime.ts";
import type { HostSettings } from "../src/settings.ts";
import { Tailnet } from "../src/tailnet.ts";
import type { Faults } from "./runtime-contract.ts";
import { hostConfig, loopbackServer } from "./support.ts";

export const Fault = Schema.TaggedUnion({
  "hold-capture": {},
  drift: { machine: Schema.String },
  "land-late": {},
  quota: { on: Schema.Boolean },
  "drop-answer": { call: Schema.Literals(["make", "delete"]) },
  repin: { pin: Schema.String },
});

export type Fault = typeof Fault.Type;

const decodeFault = Schema.decodeUnknownEffect(Schema.fromJsonString(Fault));

export const Answer = Schema.Struct({
  took: Schema.Boolean,
  said: Schema.String,
});

export type Answer = typeof Answer.Type;

const refused = (said: string): Answer => ({ took: false, said });

export const fakeTailnet = process.env["CLANKERBOX_FAKE_TAILNET"] === "1";

const slowKey = Effect.as(
  Effect.sleep(Duration.seconds(1)),
  Redacted.make("tskey-auth-fake")
);

export const mintingAsSlowlyAsTailscale = Layer.succeed(Tailnet, {
  mint: slowKey,
  mintBuild: slowKey,
});

const landsLateBy = Duration.seconds(5);

/** What a fake runtime or a fake provider API takes of `fault.sh`'s faults. */
export interface Faulted {
  readonly name: string;
  readonly faults: Faults;
  readonly holdCapture: Effect.Effect<void> | undefined;
  readonly drift:
    | {
        readonly _tag: "by-name";
        readonly running: (machine: string) => string | undefined;
      }
    | { readonly _tag: "never"; readonly because: string };
  readonly sweeps: boolean;
  readonly repin?: (pin: string) => Effect.Effect<void>;
}

export const taking =
  (faulted: Faulted) =>
  (fault: Fault): Effect.Effect<Answer> =>
    Fault.match(fault, {
      "hold-capture": () =>
        faulted.holdCapture === undefined
          ? Effect.succeed(refused(`${faulted.name} holds no capture`))
          : Effect.as(faulted.holdCapture, {
              took: true,
              said: `${faulted.name} holds its next capture`,
            }),
      drift: ({ machine }) => {
        if (faulted.drift._tag === "never") {
          return Effect.succeed(refused(faulted.drift.because));
        }

        const instance = faulted.drift.running(machine);

        return instance === undefined
          ? Effect.succeed(
              refused(`${faulted.name} has no running machine ${machine}`)
            )
          : Effect.as(faulted.faults.drift(instance), {
              took: true,
              said: `${faulted.name} stopped ${machine} (${instance}) on its own`,
            });
      },
      "land-late": () =>
        faulted.sweeps
          ? Effect.as(faulted.faults.landLate(landsLateBy), {
              took: true,
              said: `${faulted.name} fails its next make and lands its machine ${Duration.format(landsLateBy)} later`,
            })
          : Effect.succeed(
              refused(
                `${faulted.name} marks nothing it makes, so no sweep would find a machine that landed late`
              )
            ),
      quota: ({ on }) =>
        Effect.as(faulted.faults.quota(on), {
          took: true,
          said: `${faulted.name} turned its quota ${on ? "on" : "off"}`,
        }),
      "drop-answer": ({ call }) =>
        Effect.as(faulted.faults.dropAnswer(call), {
          took: true,
          said: `${faulted.name} drops its answer to the next ${call}`,
        }),
      repin: ({ pin }) =>
        faulted.repin === undefined
          ? Effect.succeed(refused(`${faulted.name} runs no runtime pin`))
          : Effect.as(faulted.repin(pin), {
              took: true,
              said: `${faulted.name} now runs runtime pin ${pin}, keeping its machines`,
            }),
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

const published = (file: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.andThen(
      write(`${file}.part`, `${text}\n`),
      fs.rename(`${file}.part`, file)
    )
  );

export interface Served {
  readonly url: string;
  readonly runtime: string;
  readonly take: (fault: Fault) => Effect.Effect<Answer>;
}

/**
 * Serves one host of a verify run until it is stopped or killed: `hosts/<id>.url` and `.pid` name
 * it, the `.pid` alone goes when it stops, so a host started again takes the port it had, and each
 * `USR2` answers the fault in `hosts/<id>.fault`.
 */
export const serveHost = <E, R>(
  run: string,
  id: string,
  start: (port: number | undefined) => Effect.Effect<Served, E, R>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hosts = path.join(run, "hosts");
    const url = path.join(hosts, `${id}.url`);
    const pid = path.join(hosts, `${id}.pid`);
    const request = path.join(hosts, `${id}.fault`);

    yield* Effect.forEach([path.join(run, "evidence"), hosts], mkdir);

    const previous = (yield* fs.exists(url))
      ? new URL((yield* fs.readFileString(url)).trim())
      : undefined;

    const host = yield* start(
      previous === undefined ? undefined : Number(previous.port)
    );

    yield* Effect.addFinalizer(() =>
      fs.remove(pid, { force: true }).pipe(Effect.ignore)
    );

    const answered = Effect.gen(function* () {
      const text = yield* fs.readFileString(request);

      yield* fs.remove(request);

      return yield* host.take(yield* decodeFault(text));
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          refused(`host ${id} couldn't read its fault: ${error.message}`)
        )
      ),
      Effect.tap(({ said }) => Effect.logInfo(`fault: ${said}`)),
      Effect.flatMap(({ took, said }) =>
        published(`${request}.${took ? "ok" : "refused"}`, said)
      ),
      Effect.orDie
    );

    yield* Effect.forkScoped(Stream.runForEach(doorbell, () => answered));
    yield* Console.log(`ready ${host.runtime} host ${id} at ${host.url}`);
    yield* published(url, host.url);
    yield* write(pid, `${process.pid}\n`);

    return yield* Effect.never;
  });

/** Runs a serve program, scoped, over Node's services. */
export const runServe = <E>(
  program: Effect.Effect<never, E, Scope.Scope | NodeServices.NodeServices>
) => {
  NodeRuntime.runMain(
    program.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
};

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface Recorder {
  readonly call: (line: string) => void;
  readonly request: (logged: LoggedRequest) => void;
}

/** A provider's fake API, as the process that serves it for a verify run holds it. */
export interface FakeApi extends Omit<Faulted, "name" | "sweeps"> {
  readonly url: string;
  readonly key: string;
}

/**
 * A provider runtime for the verify skill: its fake API, served by a process of its own that
 * outlives the hosts `fault.sh` kills, and its real adapter, given that API and a key file.
 */
export interface Provider {
  readonly name: string;
  readonly image: string;
  readonly fake: (
    dir: string,
    record: Recorder
  ) => Effect.Effect<FakeApi, never, Scope.Scope>;
  readonly layer: (
    api: {
      readonly url: string;
      readonly key: string;
      readonly keyFile: string;
    },
    host: HostSettings
  ) => Layer.Layer<
    Runtime,
    HostError | CannotStart,
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | HttpClient.HttpClient
  >;
}

const filesOf = (run: string, provider: Provider) => {
  const home = path.join(run, provider.name);

  return {
    home,
    url: path.join(home, "url"),
    control: path.join(home, "control"),
    key: path.join(home, "key"),
    pid: path.join(run, "hosts", `${provider.name}-api.pid`),
    log: path.join(run, "evidence", `${provider.name}-api.log`),
    calls: path.join(run, "evidence", `${provider.name}-calls.txt`),
    requests: path.join(run, "evidence", `${provider.name}-requests.jsonl`),
  };
};

const fakeApi = (run: string, provider: Provider) =>
  Effect.gen(function* () {
    const files = filesOf(run, provider);

    yield* mkdir(files.home);

    const fake = yield* provider.fake(path.join(files.home, "api"), {
      call: (line) => {
        appendFileSync(files.calls, `${line}\n`);
      },
      request: (logged) => {
        appendFileSync(files.requests, `${JSON.stringify(logged)}\n`);
      },
    });

    const take = taking({
      ...fake,
      name: `the fake ${provider.name} API`,
      sweeps: true,
    });

    const control = yield* Layer.build(
      HttpRouter.serve(
        HttpRouter.add("POST", "/", (request) =>
          request.text.pipe(
            Effect.flatMap(decodeFault),
            Effect.flatMap(take),
            Effect.catch((error) =>
              Effect.succeed(refused(`no fault: ${error.message}`))
            ),
            Effect.map((answer) => HttpServerResponse.jsonUnsafe(answer))
          )
        )
      ).pipe(Layer.provideMerge(loopbackServer()))
    );

    yield* write(files.key, `${fake.key}\n`);
    yield* published(
      files.control,
      HttpServer.formatAddress(
        Context.get(control, HttpServer.HttpServer).address
      )
    );
    yield* published(files.url, fake.url);
    yield* write(files.pid, `${process.pid}\n`);
    yield* Console.log(`ready fake ${provider.name} API at ${fake.url}`);

    return yield* Effect.never;
  });

const alive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  });

const apiOf = (run: string, provider: Provider, program: string) =>
  Effect.gen(function* () {
    const files = filesOf(run, provider);
    const fs = yield* FileSystem.FileSystem;

    const running = (yield* fs.exists(files.pid))
      ? yield* alive(Number((yield* fs.readFileString(files.pid)).trim()))
      : false;

    if (!running) {
      yield* Effect.forEach([files.url, files.control], (file) =>
        fs.remove(file, { force: true })
      );

      const log = openSync(files.log, "a");

      spawn("vpx", [program, run, "--api"], {
        detached: true,
        stdio: ["ignore", log, log],
      }).unref();
    }

    const read = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text) => text.trim()),
        Effect.retry({
          schedule: Schedule.spaced(Duration.millis(250)),
          times: 240,
        })
      );

    return {
      url: yield* read(files.url),
      control: yield* read(files.control),
      key: yield* read(files.key),
      keyFile: files.key,
    };
  });

const providerHost = (
  run: string,
  id: string,
  provider: Provider,
  program: string,
  budget: string | undefined
) =>
  serveHost(run, id, (port) =>
    Effect.gen(function* () {
      if (budget !== undefined) {
        yield* Console.log(
          `host ${id} takes no RAM budget: its room is its account's limits`
        );
      }

      const api = yield* apiOf(run, provider, program);
      const dir = path.join(yield* scratch, "host");

      const config = {
        ...hostConfig(path.join(dir, "state"), undefined, id),
        bases: new Map([["ubuntu", provider.image]]),
      };

      const context = yield* Layer.build(
        hostLayer(
          config,
          provider.layer(api, config),
          loopbackServer(port)
        ).pipe(
          Layer.provide(fakeTailnet ? mintingAsSlowlyAsTailscale : Layer.empty),
          Layer.provideMerge(NodeHttpClient.layerNodeHttp),
          Layer.provideMerge(
            Logger.layer([Logger.consolePretty({ colors: false })])
          )
        )
      );

      const http = Context.get(context, HttpClient.HttpClient);

      const take = (fault: Fault) =>
        http
          .execute(
            HttpClientRequest.post(api.control).pipe(
              HttpClientRequest.bodyJsonUnsafe(fault)
            )
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Answer)),
            Effect.catch((error) =>
              Effect.succeed(
                refused(
                  `the fake ${provider.name} API didn't answer: ${error.message}`
                )
              )
            )
          );

      return {
        url: HttpServer.formatAddress(
          Context.get(context, HttpServer.HttpServer).address
        ),
        runtime: provider.name,
        take,
      };
    })
  );

/**
 * The program `tests/<runtime>/serve.ts` runs: `serve.ts <run> <host-id> [runtime] [budget]` serves
 * a host over the provider's fake API, and `serve.ts <run> --api` serves that API.
 */
export const serveProvider = (provider: Provider, program: string) => {
  const [runArg, second, , budget] = process.argv.slice(2);

  runServe(
    Effect.gen(function* () {
      if (runArg === undefined || second === undefined) {
        return yield* Effect.die(
          `usage: serve.ts <run-dir> <host-id> [${provider.name}] [ram-budget-mib], or serve.ts <run-dir> --api, with CLANKERBOX_FAKE_TAILNET optional`
        );
      }

      const run = path.resolve(runArg);

      return yield* second === "--api"
        ? fakeApi(run, provider)
        : providerHost(run, second, provider, program, budget);
    })
  );
};
