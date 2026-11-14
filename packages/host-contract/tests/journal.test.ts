import { it } from "@effect/vitest";
import { Unavailable } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Logger, References } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { expect } from "vite-plus/test";

import { journal } from "../src/journal.ts";

const answering = (
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, Unavailable>
) =>
  Effect.gen(function* () {
    const lines: Array<readonly [string, string]> = [];

    yield* journal(app).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://plane/machines"))
      ),
      Effect.provideService(References.MinimumLogLevel, "All"),
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, message }) => {
            lines.push([logLevel, [message].flat().map(String).join(" ")]);
          }),
        ])
      ),
      Effect.exit
    );

    return lines;
  });

const refusedWith = (status: number) =>
  Effect.failCause(
    Cause.combine(
      Cause.fail(
        new Unavailable({ message: "no host answered", readOnly: true })
      ),
      Cause.die(HttpServerResponse.empty({ status }))
    )
  );

it.effect(
  "logs an answer at debug, one of Internal and a failure no declared error is at error, a failure answered 503 at debug, and a request cut short not at all",
  () =>
    Effect.gen(function* () {
      const said = yield* Effect.forEach(
        [
          Effect.succeed(HttpServerResponse.empty({ status: 200 })),
          Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          Effect.succeed(HttpServerResponse.empty({ status: 503 })),
          Effect.succeed(HttpServerResponse.empty({ status: 500 })),
          Effect.die("broken"),
          refusedWith(503),
          Effect.interrupt,
        ],
        answering
      );

      expect(said).toStrictEqual([
        [["Debug", "Sent HTTP response"]],
        [["Debug", "Sent HTTP response"]],
        [["Debug", "Sent HTTP response"]],
        [["Error", "a request answered Internal"]],
        [["Error", "a request failed"]],
        [["Debug", "Sent HTTP response"]],
        [],
      ]);
    })
);
