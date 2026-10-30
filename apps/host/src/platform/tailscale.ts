import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { Tailnet } from "../tailnet.ts";

export const TailnetSettings = Schema.Struct({
  oauthClient: Schema.Struct({
    id: Schema.String.check(Schema.isNonEmpty()),
    secret: Schema.RedactedFromValue(Schema.String.check(Schema.isNonEmpty())),
  }),
  tags: Schema.NonEmptyArray(
    Schema.String.check(
      // CheckTag in https://github.com/tailscale/tailscale/blob/main/tailcfg/tailcfg.go
      Schema.isPattern(/^tag:[A-Za-z][A-Za-z0-9-]*$/u, {
        message: "a tag, such as tag:clankerbox-machine",
      })
    )
  ),
});

export type TailnetSettings = typeof TailnetSettings.Type;

const apiUrl = "https://api.tailscale.com/api/v2";

const keyLifetime = Duration.minutes(10);

const Token = Schema.Struct({ access_token: Schema.String });

const MintedKey = Schema.Struct({ key: Schema.String });

const failed = (what: string) => (error: { readonly message: string }) =>
  new Internal({ message: `Tailscale ${what}: ${error.message}` });

export const make = (
  settings: TailnetSettings,
  url = apiUrl
): Effect.Effect<Tailnet["Service"], never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    const token = http
      .execute(
        HttpClientRequest.post(`${url}/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: settings.oauthClient.id,
            client_secret: Redacted.value(settings.oauthClient.secret),
          })
        )
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
        Effect.mapError(failed("refused the OAuth client"))
      );

    const mint = Effect.gen(function* () {
      const { access_token } = yield* token;

      const minted = yield* http
        .execute(
          HttpClientRequest.post(`${url}/tailnet/-/keys`).pipe(
            HttpClientRequest.bearerToken(access_token),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({
              capabilities: {
                devices: {
                  create: {
                    reusable: false,
                    ephemeral: true,
                    preauthorized: true,
                    tags: settings.tags,
                  },
                },
              },
              expirySeconds: Duration.toSeconds(keyLifetime),
            })
          )
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(MintedKey)),
          Effect.mapError(failed("didn't mint a key"))
        );

      return Redacted.make(minted.key);
    });

    return { mint };
  });

export const layer = (
  settings: TailnetSettings
): Layer.Layer<Tailnet, never, HttpClient.HttpClient> =>
  Layer.effect(Tailnet, make(settings));
