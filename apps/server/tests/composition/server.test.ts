import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Logger, References } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { expect } from "vite-plus/test";

import { journaled } from "../../src/composition/server.ts";
import { request, withClient } from "../support.ts";

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
