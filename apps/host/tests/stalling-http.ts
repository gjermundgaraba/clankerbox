import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import { callStalls } from "./call-stalls.ts";

export const stallingHttp = <E, R>(
  base: Layer.Layer<HttpClient.HttpClient, E, R>,
  counts?: (request: HttpClientRequest.HttpClientRequest) => boolean
) => {
  const stalls = callStalls();

  const layer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.transform(client, (response, request) =>
        Effect.suspend(() => {
          const held = stalls.next(counts?.(request));

          return Effect.andThen(
            held("start"),
            Effect.tap(response, () => held("end"))
          );
        })
      )
    )
  ).pipe(Layer.provide(base));

  return { layer, stall: stalls.stall };
};
