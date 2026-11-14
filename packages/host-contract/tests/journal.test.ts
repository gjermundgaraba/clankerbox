import { it } from "@effect/vitest";
import { Unavailable } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Logger, References } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { expect } from "vite-plus/test";

import { journal } from "../src/journal.ts";

interface Said {
  readonly level: string;
  readonly message: string;
  readonly whole: string;
}

const heard = (
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, Unavailable>,
  request = new Request("http://plane/machines")
) =>
  Effect.gen(function* () {
    const said: Said[] = [];

    yield* journal(app).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request)
      ),
      Effect.provideService(References.MinimumLogLevel, "All"),
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, message, cause, fiber }) => {
            const text = [message].flat().map(String).join(" ");

            said.push({
              level: logLevel,
              message: text,
              whole: JSON.stringify([
                text,
                Cause.pretty(cause),
                fiber.getRef(References.CurrentLogAnnotations),
              ]),
            });
          }),
        ])
      ),
      Effect.exit
    );

    return said;
  });

const levels = (said: readonly Said[]) =>
  said.map(({ level, message }) => [level, message]);

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
        (app) => heard(app)
      );

      expect(said.map(levels)).toStrictEqual([
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

const secret = "hunter2-a5f1";

const planted = {
  body: new Request("http://plane/host/execMachine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ env: { TOKEN: secret } }),
  }),
  header: new Request("http://plane/host/execMachine", {
    method: "POST",
    headers: { "x-token": secret },
  }),
  "query string": new Request(`http://plane/host/execMachine?token=${secret}`, {
    method: "POST",
  }),
};

const lines = {
  answered: {
    app: Effect.succeed(HttpServerResponse.empty({ status: 200 })),
    says: [["Debug", "Sent HTTP response"]],
  },
  "refused as its action declares": {
    app: refusedWith(503),
    says: [["Debug", "Sent HTTP response"]],
  },
  "answered Internal": {
    app: Effect.succeed(
      HttpServerResponse.text("the store failed", { status: 500 })
    ),
    says: [["Error", "a request answered Internal the store failed"]],
  },
  "failed as no action declares": {
    app: Effect.die("broken"),
    says: [["Error", "a request failed"]],
  },
  "cut short": { app: Effect.interrupt, says: [] },
};

for (const [place, request] of Object.entries(planted)) {
  for (const [line, { app, says }] of Object.entries(lines)) {
    it.effect(
      `a secret in a request's ${place} reaches no line of a request ${line}`,
      () =>
        Effect.gen(function* () {
          const said = yield* heard(app, request.clone());

          expect(levels(said)).toStrictEqual(says);
          expect(said.map(({ whole }) => whole).join("\n")).not.toContain(
            secret
          );
        })
    );
  }
}
