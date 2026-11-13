import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Duration, Effect, Fiber, Logger, References, Schedule } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { expect } from "vite-plus/test";

import { journaled } from "../../src/composition/server.ts";
import {
  clientOf,
  firstHost,
  plane,
  request,
  running,
  withClient,
} from "../support.ts";

const heard = (lines: Array<readonly [string, string]>) =>
  Logger.make(({ logLevel, message }) => {
    lines.push([logLevel, String(message)]);
  });

const answering = (app: Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
  Effect.gen(function* () {
    const lines: Array<readonly [string, string]> = [];

    yield* journaled(app).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://plane/machines"))
      ),
      Effect.provideService(References.MinimumLogLevel, "All"),
      Effect.provide(Logger.layer([heard(lines)])),
      Effect.exit
    );

    return lines;
  });

layer(NodeServices.layer, { excludeTestServices: true })(
  "the control plane's journal",
  (it) => {
    it.effect("holds no line for an answered request, a refusal included", () =>
      Effect.gen(function* () {
        const lines: Array<readonly [string, string]> = [];

        const { client } = yield* withClient({ logger: heard(lines) });

        yield* client.create("dev", request("dev"));
        yield* client.listMachines();
        yield* Effect.flip(client.getMachine({ id: "nope" }));

        expect(
          lines.filter(([, message]) => !message.startsWith("Listening"))
        ).toStrictEqual([]);
      })
    );

    it.effect(
      "logs an answer at debug, one of Internal and a failure no declared error is at error",
      () =>
        Effect.gen(function* () {
          const said = yield* Effect.forEach(
            [
              Effect.succeed(HttpServerResponse.empty({ status: 200 })),
              Effect.succeed(HttpServerResponse.empty({ status: 404 })),
              Effect.succeed(HttpServerResponse.empty({ status: 500 })),
              Effect.die("broken"),
            ],
            answering
          );

          expect(said).toStrictEqual([
            [["Debug", "Sent HTTP response"]],
            [["Debug", "Sent HTTP response"]],
            [["Error", "a request answered Internal"]],
            [["Error", "a request failed"]],
          ]);
        })
    );
  }
);

layer(NodeServices.layer, { excludeTestServices: true })(
  "the control plane's stop",
  (it) => {
    it.effect(
      "a control plane told to stop cuts a request still open at once, and its client hears Unavailable, the action maybe run",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const began = path.join(dir, "began");
          const { url, crash } = yield* running();
          const client = yield* clientOf(url);

          yield* client.create("dev", request("dev"));

          const exec = yield* Effect.forkChild(
            Effect.flip(
              client.execMachine({
                id: "dev",
                argv: ["/bin/sh", "-c", `: >"${began}"; sleep 30`],
              })
            )
          );

          yield* read(began).pipe(
            Effect.retry(Schedule.spaced(Duration.millis(20)))
          );

          const [took] = yield* Effect.timed(crash);

          expect(Duration.toMillis(took)).toBeLessThan(5000);
          expect(yield* Fiber.join(exec)).toMatchObject({
            _tag: "Unavailable",
            readOnly: false,
          });
        })
    );

    it.effect(
      "a read held open when the control plane stops is cut at once, and its client hears Unavailable, retryable",
      () =>
        Effect.gen(function* () {
          const served = yield* running();
          const client = yield* clientOf(served.url);
          const stopping = firstHost(served).fake.holdNext("stop");

          yield* client.create("dev", request("dev"));
          yield* Effect.forkChild(
            Effect.exit(client.stopMachine({ id: "dev" }))
          );
          yield* stopping.entered;

          const heldRead = yield* Effect.forkChild(
            Effect.flip(client.getMachine({ id: "dev", holdSeconds: 5 }))
          );

          yield* Effect.sleep(Duration.millis(300));

          const [took] = yield* Effect.timed(served.crash);

          yield* stopping.release;

          expect(Duration.toMillis(took)).toBeLessThan(5000);
          expect(yield* Fiber.join(heldRead)).toMatchObject({
            _tag: "Unavailable",
            readOnly: true,
          });
        })
    );

    it.effect(
      "a wait reads on through a stop and a restart of the control plane, and ends where it asked",
      () =>
        Effect.gen(function* () {
          const planned = yield* plane();
          const first = yield* planned.start();
          const client = yield* clientOf(first.url);
          const stopping = firstHost(planned).fake.holdNext("stop");

          yield* client.create("dev", request("dev"));

          const wait = yield* Effect.forkChild(
            client.stopMachine({ id: "dev" })
          );

          yield* stopping.entered;
          yield* Effect.sleep(Duration.millis(300));
          yield* first.crash;

          const second = yield* planned.start(Number(new URL(first.url).port));

          yield* Effect.addFinalizer(() => second.crash);
          yield* stopping.release;

          expect(yield* Fiber.join(wait)).toMatchObject({
            state: "stopped",
            phase: "settled",
          });
        })
    );
  }
);
