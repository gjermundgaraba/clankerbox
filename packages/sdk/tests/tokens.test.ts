import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as Client from "../src/client.ts";
import {
  callerInConstantTime,
  hashToken,
  mintToken,
  readCallers,
  requireToken,
} from "../src/node.ts";
import type { Caller } from "../src/node.ts";
import { isTailnetOrLoopback } from "../src/reach.ts";
import { scratch, write } from "./files.ts";

const decodeRefusal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Action.Unauthenticated)
);

const answering = HttpRouter.add(
  "POST",
  "/api/ping",
  HttpServerResponse.text("pong")
);

const served = (callers: Effect.Effect<readonly Caller[]> | undefined) =>
  Effect.map(
    Effect.acquireRelease(
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
          await web.dispose();
        })
    ),
    (web) => (authorization?: string) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request("http://cbx.test/api/ping", {
            method: "POST",
            headers: authorization === undefined ? {} : { authorization },
          })
        );

        return { status: response.status, body: await response.text() };
      })
  );

const asking = (
  callers: readonly Caller[] | undefined,
  authorization?: string
) =>
  Effect.scoped(
    Effect.flatMap(
      served(callers === undefined ? undefined : Effect.succeed(callers)),
      (ask) => ask(authorization)
    )
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

const sum = (bytes: Buffer) => bytes.reduce((total, byte) => total + byte, 0);

const token = (minted: typeof laptop) => Redacted.value(minted.token);

layer(NodeServices.layer)((it) => {
  describe("requireToken", () => {
    it.effect(
      "with no callers configured, passes every request, as today",
      () =>
        Effect.gen(function* () {
          expect(yield* asking(undefined)).toStrictEqual({
            status: 200,
            body: "pong",
          });
        })
    );

    it.effect(
      "with callers configured and none of them left, refuses every request, a token's too",
      () =>
        Effect.gen(function* () {
          for (const authorization of [undefined, `Bearer ${token(laptop)}`]) {
            expect((yield* asking([], authorization)).status).toBe(401);
          }
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
  });

  it.effect(
    "one middleware reads its callers at each request, so a caller taken away is refused from its next request",
    () =>
      Effect.gen(function* () {
        let taken = yield* callersOf(laptop.line, orbs.line);
        const ask = yield* served(Effect.sync(() => taken));

        expect((yield* ask(`Bearer ${token(laptop)}`)).status).toBe(200);

        taken = yield* callersOf(orbs.line);

        expect((yield* ask(`Bearer ${token(laptop)}`)).status).toBe(401);
        expect((yield* ask(`Bearer ${token(orbs)}`)).status).toBe(200);
      }).pipe(Effect.scoped)
  );

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

    it("finds no caller whose hash differs from the token's in any one bit, at every bit of every byte", () => {
      const right = token(laptop);
      const digest = Buffer.from(hashToken(right));

      for (const index of digest.keys()) {
        for (let bit = 0; bit < 8; bit += 1) {
          const near = Buffer.from(digest);

          near.writeUInt8(near.readUInt8(index) ^ (1 << bit), index);

          expect(
            callerInConstantTime([{ name: "near", hash: near }], right),
            `byte ${index}, bit ${bit}`
          ).toBeUndefined();
        }
      }

      expect(
        callerInConstantTime([{ name: "same", hash: digest }], right)?.name
      ).toBe("same");
    });

    it("finds no caller whose hash holds the token's bytes in another order", () => {
      const right = token(laptop);
      const digest = Buffer.from(hashToken(right));

      const permutations = [
        Buffer.from([...digest].toReversed()),
        ...[...digest.keys()].map((index) =>
          Buffer.concat([digest.subarray(index), digest.subarray(0, index)])
        ),
        ...[...digest.keys()].map((index) => {
          const next = (index + 1) % digest.length;
          const swapped = Buffer.from(digest);

          swapped.writeUInt8(digest.readUInt8(next), index);
          swapped.writeUInt8(digest.readUInt8(index), next);

          return swapped;
        }),
      ].filter((near) => !near.equals(digest));

      expect(permutations.length).toBeGreaterThan(32);

      for (const near of permutations) {
        expect(
          callerInConstantTime([{ name: "near", hash: near }], right),
          near.toString("hex")
        ).toBeUndefined();
      }
    });

    it("finds no caller whose hash has the token's byte sum but other bytes", () => {
      const right = token(laptop);
      const digest = Buffer.from(hashToken(right));

      const sameSum = [...digest.keys()].flatMap((raised) => {
        const lowered = [...digest.keys()].find(
          (index) => index !== raised && digest.readUInt8(index) > 0
        );

        if (digest.readUInt8(raised) === 255 || lowered === undefined) {
          return [];
        }

        const moved = Buffer.from(digest);

        moved.writeUInt8(digest.readUInt8(raised) + 1, raised);
        moved.writeUInt8(digest.readUInt8(lowered) - 1, lowered);

        return [moved];
      });

      expect(sameSum.length).toBeGreaterThan(16);

      for (const near of sameSum) {
        expect(sum(near), near.toString("hex")).toBe(sum(digest));
        expect(near.equals(digest)).toBe(false);
        expect(
          callerInConstantTime([{ name: "near", hash: near }], right),
          near.toString("hex")
        ).toBeUndefined();
      }
    });
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
  describe("isTailnetOrLoopback", () => {
    it("takes the loopback and tailnet ranges, as IPv4, IPv6 and IPv4 mapped into IPv6, and nothing else", () => {
      const expected: ReadonlyArray<readonly [string, boolean]> = [
        ["127.0.0.1", true],
        ["127.255.255.254", true],
        ["126.255.255.255", false],
        ["128.0.0.1", false],
        ["100.64.0.0", true],
        ["100.127.255.255", true],
        ["100.63.255.255", false],
        ["100.128.0.0", false],
        ["10.0.0.5", false],
        ["203.0.113.7", false],
        ["0.0.0.0", false],
        ["::1", true],
        ["0:0:0:0:0:0:0:1", true],
        ["::2", false],
        ["::", false],
        ["fd7a:115c:a1e0::5", true],
        ["fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff", true],
        ["fd7a:115c:a1e1::5", false],
        ["fd7a:115c:a1df::5", false],
        ["2001:db8::1", false],
        ["::ffff:127.0.0.1", true],
        ["::ffff:7f00:1", true],
        ["::ffff:100.64.0.1", true],
        ["::ffff:6440:1", true],
        ["::ffff:100.128.0.1", false],
        ["::ffff:10.0.0.5", false],
        ["::ffff:203.0.113.7", false],
        ["::ffff:cb00:7107", false],
        ["::ffff:0.0.0.0", false],
        ["::127.0.0.1", false],
        ["localhost", false],
        ["127.1", false],
        ["::1%lo", false],
        ["2001:db8::ffff:7f00:1", false],
        ["1::ffff:127.0.0.1", false],
        ["fe80::ffff:6440:1", false],
        ["0:0:0:0:1:ffff:7f00:1", false],
        ["::ffff:0:1", false],
        ["::5:0:1", false],
        ["0:0:0:0:1:0:0:1", false],
        ["1::1", false],
      ];

      for (const [address, takes] of expected) {
        expect(isTailnetOrLoopback(address), address).toBe(takes);
      }
    });
  });

  describe("tokenUrlRefusal", () => {
    it("lets a token go over https anywhere, and over http only to a tailnet or loopback IP", () => {
      for (const url of [
        "https://203.0.113.7:8585",
        "https://box.tailnet.ts.net",
        "http://127.0.0.1:8484",
        "http://127.255.0.9",
        "http://100.64.0.1:8484",
        "http://100.127.255.255",
        "http://[::1]:8484",
        "http://[fd7a:115c:a1e0::5]:8484",
      ]) {
        expect(Client.tokenUrlRefusal(url), url).toBeUndefined();
      }

      for (const url of [
        "http://203.0.113.7:8585",
        "http://100.63.255.255",
        "http://100.128.0.1",
        "http://10.0.0.5",
        "http://box.tailnet.ts.net",
        "http://localhost:8484",
        "http://127.0.0.1.evil.example",
        "http://[fd7a:115c:a1e1::1]",
        "http://[2001:db8::1]",
        "ftp://127.0.0.1",
        "not a url",
      ]) {
        expect(Client.tokenUrlRefusal(url), url).toBeDefined();
      }
    });

    it.effect(
      "Client.make refuses a token for an http URL a token may not cross, and takes one without",
      () =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip(
            Client.make("http://203.0.113.7:8585", {
              token: Redacted.make("a".repeat(64)),
            })
          );

          expect(refused.message).toContain(
            "would cross the network in the clear"
          );

          yield* Client.make("http://203.0.113.7:8585");
        }).pipe(Effect.provide(FetchHttpClient.layer))
    );
  });
});
