import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import {
  callerInConstantTime,
  mintToken,
  readCallers,
  requireToken,
} from "../src/node.ts";
import type { Caller } from "../src/node.ts";
import { scratch, write } from "./files.ts";

const decodeRefusal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Action.Unauthenticated)
);

const answering = HttpRouter.add(
  "POST",
  "/api/ping",
  HttpServerResponse.text("pong")
);

const asking = (callers: readonly Caller[], authorization?: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        answering.pipe(
          Layer.provide(requireToken("control plane", callers).layer),
          Layer.provide(HttpServer.layerServices)
        ),
        { disableLogger: true }
      )
    ),
    (web) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request("http://cbx.test/api/ping", {
            method: "POST",
            headers: authorization === undefined ? {} : { authorization },
          })
        );

        return { status: response.status, body: await response.text() };
      }),
    (web) =>
      Effect.promise(async () => {
        await web.dispose();
      })
  );

const callersOf = (...lines: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* scratch;
      const file = `${dir}/callers`;

      yield* write(file, `${lines.join("\n")}\n`);

      return yield* readCallers(file);
    })
  );

const laptop = mintToken("laptop");
const orbs = mintToken("orbs");
const other = mintToken("smolvm-1");

const token = (minted: typeof laptop) => Redacted.value(minted.token);

layer(NodeServices.layer)((it) => {
  describe("requireToken", () => {
    it.effect(
      "with no callers configured, passes every request, as today",
      () =>
        Effect.gen(function* () {
          expect(yield* asking([])).toStrictEqual({
            status: 200,
            body: "pong",
          });
        })
    );

    it.effect("passes each named caller's own token", () =>
      Effect.gen(function* () {
        const callers = yield* callersOf(laptop.line, orbs.line);

        for (const minted of [laptop, orbs]) {
          expect(
            (yield* asking(callers, `Bearer ${token(minted)}`)).status
          ).toBe(200);
        }
      })
    );

    it.effect(
      "refuses Unauthenticated a request with no token, an empty one, a wrong one, one prefix or one longer than a caller's, and another file's",
      () =>
        Effect.gen(function* () {
          const callers = yield* callersOf(laptop.line, orbs.line);
          const right = token(laptop);

          const sent = [
            undefined,
            "Bearer ",
            "Bearer",
            `Basic ${right}`,
            `Bearer ${"0".repeat(64)}`,
            `Bearer ${right.slice(0, 32)}`,
            `Bearer ${right.slice(0, 1)}`,
            `Bearer ${right}0`,
            `Bearer ${token(other)}`,
          ];

          for (const authorization of sent) {
            const answer = yield* asking(callers, authorization);

            expect(answer.status, authorization).toBe(401);
            expect(
              (yield* decodeRefusal(answer.body)).message,
              authorization
            ).toMatch(
              /takes (?:only a caller with a token|no caller with this token)/u
            );
          }
        })
    );

    it.effect(
      "refuses a caller whose line was deleted, once the file is read again",
      () =>
        Effect.gen(function* () {
          const before = yield* callersOf(laptop.line, orbs.line);
          const after = yield* callersOf(orbs.line);

          expect(
            (yield* asking(before, `Bearer ${token(laptop)}`)).status
          ).toBe(200);
          expect((yield* asking(after, `Bearer ${token(laptop)}`)).status).toBe(
            401
          );
          expect((yield* asking(after, `Bearer ${token(orbs)}`)).status).toBe(
            200
          );
        })
    );
  });

  describe("callerInConstantTime", () => {
    it.effect(
      "finds each caller by its own token, and no caller for an empty token, a prefix of one, or one of another file",
      () =>
        Effect.gen(function* () {
          const callers = yield* callersOf(laptop.line, orbs.line);
          const right = token(laptop);

          expect(callerInConstantTime(callers, right)?.name).toBe("laptop");
          expect(callerInConstantTime(callers, token(orbs))?.name).toBe("orbs");

          for (const presented of [
            "",
            right.slice(0, 63),
            right.slice(0, 1),
            token(other),
          ]) {
            expect(
              callerInConstantTime(callers, presented),
              presented
            ).toBeUndefined();
          }
        })
    );
  });

  describe("readCallers", () => {
    it.effect(
      "refuses a token in place of its hash, a name twice, a hash twice, a bad name, and a file naming no one",
      () =>
        Effect.gen(function* () {
          const hash = laptop.line.split(" ")[1]!;

          const refused = [
            [[`laptop ${token(laptop)}x`], "not 64 lowercase hex"],
            [[`laptop ${hash.toUpperCase()}`], "not 64 lowercase hex"],
            [
              [laptop.line, `laptop ${orbs.line.split(" ")[1]!}`],
              "named twice",
            ],
            [[laptop.line, `orbs ${hash}`], "another caller's too"],
            [[`my/laptop ${hash}`], "isn't letters"],
            [[`laptop`], "each line is"],
            [["# nobody"], "names no caller"],
          ] as const;

          for (const [lines, says] of refused) {
            const error = yield* Effect.flip(callersOf(...lines));

            expect(error.message, says).toContain(says);
          }
        })
    );
  });
});
