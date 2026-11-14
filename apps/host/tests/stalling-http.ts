import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";

import { callStalls } from "./call-stalls.ts";

/**
 * Node's HTTP client, each request a provider call `Faults.stall` counts: one held at its start
 * is never sent, and one held at its end was answered, and its answer is never read.
 */
export const stallingHttp = () => {
  const stalls = callStalls();

  const layer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.transform(client, (response) =>
        Effect.suspend(() => {
          const held = stalls.next();

          return Effect.andThen(
            held("start"),
            Effect.tap(response, () => held("end"))
          );
        })
      )
    )
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

  return { layer, stall: stalls.stall };
};
