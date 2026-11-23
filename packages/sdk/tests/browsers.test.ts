import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import { Invalid, refuseBrowsers } from "../src/index.ts";

const decodeInvalid = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Invalid)
);

const answering = HttpRouter.add(
  "POST",
  "/api/ping",
  HttpServerResponse.text("pong")
);

const asking = (host: string, origin?: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        answering.pipe(
          Layer.provide(refuseBrowsers("control plane").layer),
          Layer.provide(HttpServer.layerServices)
        ),
        { disableLogger: true }
      )
    ),
    (web) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://${host}/api/ping`, {
            method: "POST",
            headers: origin === undefined ? { host } : { host, origin },
          })
        );

        return { status: response.status, body: await response.text() };
      }),
    (web) =>
      Effect.promise(async () => {
        await web.dispose();
      })
  );

describe("refuseBrowsers", () => {
  it.effect("passes a request that carries no Origin, as ours don't", () =>
    Effect.gen(function* () {
      expect(yield* asking("cbx.test")).toStrictEqual({
        status: 200,
        body: "pong",
      });
    })
  );

  it.effect(
    "refuses Invalid, before its handler runs, a request that carries Origin: a rebound page's, whose Origin names the Host it sent, a cross-origin page's, and a sandboxed one's",
    () =>
      Effect.gen(function* () {
        const page = "http://evil.example:8484";
        const rebound = yield* asking("evil.example:8484", page);
        const crossOrigin = yield* asking("cbx.test", page);
        const sandboxed = yield* asking("cbx.test", "null");

        expect([
          rebound.status,
          crossOrigin.status,
          sandboxed.status,
        ]).toStrictEqual([400, 400, 400]);
        expect((yield* decodeInvalid(rebound.body)).message).toBe(
          "this control plane takes no request that carries Origin, as a browser's does, and this one carries http://evil.example:8484: a proxy in front of it must not add Origin"
        );
      })
  );
});
