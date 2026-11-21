import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import type { Dropped } from "../runtime-contract.ts";
import { stallingHttp } from "../stalling-http.ts";

const lost = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: "the test lost its answer",
    }),
  });

const asks = (
  request: HttpClientRequest.HttpClientRequest,
  dropping: Dropped
): boolean =>
  /\/sandboxes(?:\/[^/]+)?$/u.test(new URL(request.url).pathname) &&
  request.method === (dropping === "make" ? "POST" : "DELETE");

const claimCreate = (request: HttpClientRequest.HttpClientRequest): boolean =>
  request.method === "POST" &&
  new URL(request.url).pathname.endsWith("/persistentvolumeclaims");

interface Landing {
  pending: Effect.Effect<unknown, HttpClientError.HttpClientError> | undefined;
}

export const faultyHttp = <E, R>(
  base: Layer.Layer<HttpClient.HttpClient, E, R>
) => {
  const stalling = stallingHttp(base);
  const dropping = new Set<Dropped>();
  const requests: string[] = [];

  let landing: Landing | undefined;

  const layer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.transform(client, (response, request) =>
        Effect.suspend(() => {
          requests.push(`${request.method} ${new URL(request.url).pathname}`);

          if (landing !== undefined && claimCreate(request)) {
            landing.pending ??= response;

            return Effect.fail(lost(request));
          }

          const dropped = [...dropping].find((each) => asks(request, each));

          if (dropped === undefined) {
            return response;
          }

          dropping.delete(dropped);

          return Effect.andThen(response, Effect.fail(lost(request)));
        })
      )
    )
  ).pipe(Layer.provide(stalling.layer));

  return {
    layer,
    requests,
    stall: stalling.stall,
    dropAnswer: (dropped: Dropped) =>
      Effect.sync(() => {
        dropping.add(dropped);
      }),
    landLate: Effect.sync(() => {
      const armed: Landing = { pending: undefined };

      landing = armed;

      return Effect.suspend(() => {
        landing = undefined;

        return Effect.ignore(armed.pending ?? Effect.void);
      });
    }),
  };
};
