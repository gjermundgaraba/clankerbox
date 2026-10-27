import { it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";
import { expect } from "vite-plus/test";

import { make } from "../../src/platform/tailscale.ts";
import type { TailnetSettings } from "../../src/platform/tailscale.ts";

const secret = "tskey-client-k1-that-never-prints";

const settings: TailnetSettings = {
  oauthClient: { id: "k1", secret: Redacted.make(secret) },
  tags: ["tag:clankerbox-machine"],
};

const url = "https://tailscale.test/api/v2";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly text: string | undefined;
}

const decoder = new TextDecoder();

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  "body" in request.body && request.body.body instanceof Uint8Array
    ? decoder.decode(request.body.body)
    : undefined;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const fakeTailscale = (
  reply: (sent: Sent) => { readonly status: number; readonly body: string }
) => {
  const sent: Sent[] = [];

  const client = HttpClient.make((request, requestUrl) =>
    Effect.sync(() => {
      const recorded = {
        method: request.method,
        path: requestUrl.pathname.replace("/api/v2", ""),
        authorization: request.headers["authorization"],
        text: bodyText(request),
      };

      sent.push(recorded);

      const answer = reply(recorded);

      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.body, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        })
      );
    })
  );

  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const working = (sent: Sent) =>
  sent.path === "/oauth/token"
    ? {
        status: 200,
        body: JSON.stringify({
          access_token: "access-1",
          token_type: "Bearer",
        }),
      }
    : {
        status: 200,
        body: JSON.stringify({ id: "kK1", key: "tskey-auth-minted" }),
      };

it.effect(
  "a mint asks for a single-use, ephemeral, preauthorized key for the host's tags, expiring in minutes",
  () =>
    Effect.gen(function* () {
      const tailscale = fakeTailscale(working);

      const tailnet = yield* make(settings, url).pipe(
        Effect.provide(tailscale.layer)
      );

      const key = yield* tailnet.mint;

      expect(Redacted.value(key)).toBe("tskey-auth-minted");

      const [token, keys] = tailscale.sent;

      expect([token?.method, token?.path]).toStrictEqual([
        "POST",
        "/oauth/token",
      ]);
      expect(new URLSearchParams(token?.text).get("client_id")).toBe("k1");
      expect(new URLSearchParams(token?.text).get("client_secret")).toBe(
        secret
      );
      expect([keys?.method, keys?.path, keys?.authorization]).toStrictEqual([
        "POST",
        "/tailnet/-/keys",
        "Bearer access-1",
      ]);
      expect(decodeJson(keys?.text)).toStrictEqual({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: true,
              preauthorized: true,
              tags: ["tag:clankerbox-machine"],
            },
          },
        },
        expirySeconds: 600,
      });
    })
);

it.effect(
  "a refused client fails the mint, and the next mint asks for a token again",
  () =>
    Effect.gen(function* () {
      let refusing = true;

      const tailscale = fakeTailscale((sent) =>
        sent.path === "/oauth/token" && refusing
          ? { status: 401, body: JSON.stringify({ message: "bad client" }) }
          : working(sent)
      );

      const tailnet = yield* make(settings, url).pipe(
        Effect.provide(tailscale.layer)
      );

      const refused = yield* Effect.flip(tailnet.mint);

      expect(refused._tag).toBe("Internal");
      expect(refused.message).toContain("Tailscale refused the OAuth client");

      refusing = false;

      expect(Redacted.value(yield* tailnet.mint)).toBe("tskey-auth-minted");
      expect(tailscale.sent.map((sent) => sent.path)).toStrictEqual([
        "/oauth/token",
        "/oauth/token",
        "/tailnet/-/keys",
      ]);
    })
);

it.effect("a key Tailscale won't mint fails the mint", () =>
  Effect.gen(function* () {
    const tailscale = fakeTailscale((sent) =>
      sent.path === "/oauth/token"
        ? working(sent)
        : {
            status: 403,
            body: JSON.stringify({ message: "tags not permitted" }),
          }
    );

    const tailnet = yield* make(settings, url).pipe(
      Effect.provide(tailscale.layer)
    );

    const refused = yield* Effect.flip(tailnet.mint);

    expect(refused.message).toContain("Tailscale didn't mint a key");
  })
);
