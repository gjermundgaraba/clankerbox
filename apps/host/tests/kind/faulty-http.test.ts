import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";

import { faultyHttp } from "./faulty-http.ts";

const cluster = "http://cluster.test";

const answering = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})))
  )
);

it.effect(
  "stall cuts a step only at its writes, as a cut at a read leaves the cluster and the host as a cut at the next write does, and the reads' polls only make the series longer on a slow cluster",
  () => {
    const faulty = faultyHttp(answering);

    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const { reached, release } = yield* faulty.stall(0, "start");

      const read = yield* Effect.raceFirst(
        Effect.as(
          client.get(`${cluster}/api/v1/namespaces/default/pods/fill`),
          "answered"
        ),
        Effect.as(reached, "cut")
      );

      expect(read, "the first call, a read").toBe("answered");

      const write = yield* Effect.raceFirst(
        Effect.as(
          client.post(
            `${cluster}/api/v1/namespaces/default/persistentvolumeclaims`
          ),
          "answered"
        ),
        Effect.as(reached, "cut")
      );

      expect(write, "the next call, a write").toBe("cut");
      expect(faulty.requests).toStrictEqual([
        "GET /api/v1/namespaces/default/pods/fill",
        "POST /api/v1/namespaces/default/persistentvolumeclaims",
      ]);

      yield* release;
    }).pipe(Effect.provide(faulty.layer));
  }
);
