import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import {
  Invalid,
  release,
  version,
  versionCheck,
  versionHeader,
} from "../src/index.ts";

const decodeInvalid = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Invalid)
);

const answering = HttpRouter.add(
  "POST",
  "/api/ping",
  HttpServerResponse.text("pong")
);

const asking = (
  headers: Record<string, string>,
  own?: string,
  url = "http://cbx.test/api/ping"
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        answering.pipe(
          Layer.provide(versionCheck("control plane", own).layer),
          Layer.provide(HttpServer.layerServices)
        ),
        { disableLogger: true }
      )
    ),
    (web) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(url, { method: "POST", headers })
        );

        return { status: response.status, body: await response.text() };
      }),
    (web) =>
      Effect.promise(async () => {
        await web.dispose();
      })
  );

const carrying = (origin: string, url?: string) =>
  asking({ [versionHeader]: version, origin }, undefined, url);

const [major = "0", minor = "0"] = version.split(".");

describe("release", () => {
  it("a release is the version's major.minor", () => {
    expect(release("1.2.3")).toBe("1.2");
    expect(release("0.30.1")).toBe("0.30");
  });

  it.effect("the version check passes a caller of the same release", () =>
    Effect.gen(function* () {
      expect(yield* asking({ [versionHeader]: version })).toStrictEqual({
        status: 200,
        body: "pong",
      });
    })
  );

  it.effect("the version check passes another patch of the release", () =>
    Effect.gen(function* () {
      const answer = yield* asking({
        [versionHeader]: `${major}.${minor}.999`,
      });

      expect(answer).toStrictEqual({ status: 200, body: "pong" });
    })
  );

  it.effect(
    "the version check refuses a request with no version, saying what it serves",
    () =>
      Effect.gen(function* () {
        const { status, body } = yield* asking({});
        const error = yield* decodeInvalid(body);

        expect(status).toBe(400);
        expect(error.message).toContain(`no ${versionHeader} header`);
        expect(error.message).toContain("this control plane");
        expect(error.message).toContain(release(version));
      })
  );

  it.effect(
    "a control plane of 0.41 refuses a 0.40.1 caller, and one of 0.40.1 a caller of 0.41, before its handler runs",
    () =>
      Effect.gen(function* () {
        const older = yield* asking({ [versionHeader]: "0.40.1" }, "0.41.0");
        const newer = yield* asking({ [versionHeader]: "0.41.0" }, "0.40.1");

        expect([older.status, newer.status]).toStrictEqual([400, 400]);
        expect((yield* decodeInvalid(older.body)).message).toBe(
          "this control plane runs clankerbox 0.41.0 and the caller is 0.40.1; their major.minor must match"
        );
        expect((yield* decodeInvalid(newer.body)).message).toBe(
          "this control plane runs clankerbox 0.40.1 and the caller is 0.41.0; their major.minor must match"
        );
      })
  );

  it.effect(
    "a request that carries Origin is refused Invalid before its handler runs, though it carries the release: a rebound page's, whose Origin names the host it reached, a cross-origin page's, and a sandboxed one's",
    () =>
      Effect.gen(function* () {
        const page = "http://evil.example:8484";

        const rebound = yield* carrying(page, `${page}/api/ping`);
        const crossOrigin = yield* carrying(page);
        const sandboxed = yield* carrying("null");

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

  it.effect("the version check refuses another release, naming both", () =>
    Effect.gen(function* () {
      const caller = `${major}.${Number(minor) + 1}.0`;
      const { status, body } = yield* asking({ [versionHeader]: caller });
      const error = yield* decodeInvalid(body);

      expect(status).toBe(400);
      expect(error.message).toContain(caller);
      expect(error.message).toContain(version);
    })
  );
});
