import { journal } from "@clankerbox/host-contract/journal";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { version, versionHeader } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Logger, References, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { expect } from "vite-plus/test";

import { hostOn } from "../support.ts";

const serve = hostOn({ first: 21_190, last: 21_199 });

const secret = "TOKEN=hunter2-a5f1";

class Unlisted extends Schema.TaggedError<
  Unlisted,
  { readonly brand: unique symbol }
>()("Unlisted", { message: Schema.String }) {}

interface Line {
  readonly level: string;
  readonly text: string;
  readonly annotations: string;
}

const recording = () => {
  const lines: Line[] = [];

  const logger = Logger.make(({ logLevel, message, cause, fiber }) => {
    lines.push({
      level: logLevel,
      text: [...[message].flat().map(String), Cause.pretty(cause)].join(" "),
      annotations: JSON.stringify(
        fiber.getRef(References.CurrentLogAnnotations)
      ),
    });
  });

  return { lines, logger };
};

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a request that fails as no declared error does logs one error line with its method, URL and cause, and nothing of what it sent",
    () =>
      Effect.gen(function* () {
        const { lines, logger } = recording();

        const request = HttpServerRequest.fromWeb(
          new Request("http://127.0.0.1/host/execMachine", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ env: { TOKEN: secret } }),
          })
        );

        yield* journal(
          Effect.fail(new Unlisted({ message: "no answer for this" }))
        ).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.exit,
          Effect.provide(Logger.layer([logger]))
        );

        expect(
          lines.map(({ level, annotations }) => ({ level, annotations }))
        ).toStrictEqual([
          {
            level: "Error",
            annotations: JSON.stringify({
              "http.method": "POST",
              "http.url": "/host/execMachine",
              "http.status": 500,
            }),
          },
        ]);
        expect(lines[0]?.text).toContain("a request failed");
        expect(lines[0]?.text).toContain("no answer for this");
        expect(JSON.stringify(lines)).not.toContain("hunter2");
      })
  );

  it.effect("a request for no route is the caller's, and logs no error", () =>
    Effect.gen(function* () {
      const { lines, logger } = recording();
      const { url } = yield* serve({ logger });

      const statuses = yield* Effect.promise(
        async () =>
          await Promise.all(
            [
              { path: "/host/noSuchAction", method: "POST" },
              { path: "/host/readHost", method: "GET" },
            ].map(async ({ path, method }) => {
              const response = await fetch(`${url}${path}`, {
                method,
                headers: { [versionHeader]: version },
              });

              return response.status;
            })
          )
      );

      expect(statuses).toStrictEqual([404, 404]);
      expect(lines.filter(({ level }) => level === "Error")).toStrictEqual([]);
    })
  );
});
