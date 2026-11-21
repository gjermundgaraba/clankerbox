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

/**
 * `base`, each request a call the contract's faults reach: `stall` holds one, as `stallingHttp`
 * does, `dropAnswer` sends the next create or delete of a Sandbox and loses its answer, and
 * `landLate` loses unsent every create of a claim, a make's first, until the effect it answers
 * sends the first of them. `requests` holds the method and path of each request sent.
 *
 * `stall` counts only the writes, a request that isn't a GET. A read changes nothing in the
 * cluster, so a step cut at any read leaves what a cut at the start of the next write leaves, and
 * the reads are mostly polls, whose count is the cluster's speed: on kind, a make from a base made
 * 50 calls on 2026-11-21, its 5 writes, a claim's POST, a fill pod's POST and DELETE, the claim's
 * PATCH and the Sandbox's POST, and 45 reads, 9 of them polls of the fill pod every 500 ms and 31
 * of the Sandbox and its pod until ready. Cut at every call, a slower cluster ran 76 rounds of a
 * series where a faster one ran 45, past the case's 10 minutes. Cut at the writes, each series of a
 * make has 5 cut points on any cluster, and every set of objects a cut can leave written is still
 * among them.
 */
export const faultyHttp = <E, R>(
  base: Layer.Layer<HttpClient.HttpClient, E, R>
) => {
  const stalling = stallingHttp(base, (request) => request.method !== "GET");
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
