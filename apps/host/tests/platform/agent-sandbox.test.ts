import { writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";

import * as AgentSandbox from "../../src/platform/agent-sandbox/agent-sandbox.ts";
import { Handle } from "../../src/runtime.ts";

const host = "unit";

const machine = {
  name: "dev",
  instance: "0123456789abcdef",
  handle: Handle.make(`cbx-${host}-0123456789abcdef`),
  cpu: 1,
  ramMib: 512,
  diskGib: 2,
};

const disk = `cbx-${host}-${machine.instance}-disk`;

const sized = (capacity: string, allocated?: string, resizing?: string) => ({
  capacity: { storage: capacity },
  ...(allocated === undefined
    ? {}
    : { allocatedResources: { storage: allocated } }),
  ...(resizing === undefined
    ? {}
    : { allocatedResourceStatuses: { storage: resizing } }),
});

const cluster = (growth: {
  readonly asked: string;
  readonly before: object;
  readonly after: readonly object[];
}) => {
  let { asked } = growth;
  let readsAfterPatch: number | undefined;

  const claim = () => ({
    metadata: {
      name: disk,
      uid: "disk-uid",
      labels: { "cbx-host": host, "cbx-instance": machine.instance },
    },
    spec: { resources: { requests: { storage: asked } } },
    status:
      readsAfterPatch === undefined
        ? growth.before
        : growth.after[Math.min(readsAfterPatch - 1, growth.after.length - 1)],
  });

  const client = HttpClient.make((request, url) => {
    const reply = (status: number, body: unknown) =>
      HttpClientResponse.fromWeb(request, Response.json(body, { status }));

    return Effect.sync(() => {
      if (url.pathname.endsWith(`/persistentvolumeclaims/${disk}`)) {
        if (request.method === "PATCH") {
          asked = "4Gi";
          readsAfterPatch = 0;

          return reply(200, claim());
        }

        readsAfterPatch =
          readsAfterPatch === undefined ? undefined : readsAfterPatch + 1;

        return reply(200, claim());
      }

      if (url.searchParams.has("labelSelector")) {
        return reply(200, { items: [] });
      }

      return url.pathname.endsWith("/v1beta1")
        ? reply(200, {})
        : reply(404, { kind: "Status", reason: "NotFound" });
    });
  });

  return { client, readsAfterPatch: () => readsAfterPatch };
};

const grown = (growth: Parameters<typeof cluster>[0]) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const fake = cluster(growth);

    writeFileSync(path.join(dir, "token"), "token");
    writeFileSync(path.join(dir, "ca.crt"), "ca");

    const runtime = yield* AgentSandbox.make(
      {
        namespace: "clankerbox",
        api: "https://cluster.test",
        tokenFile: path.join(dir, "token"),
        caFile: path.join(dir, "ca.crt"),
      },
      {
        id: host,
        stateDir: path.join(dir, "state"),
        listen: { address: "127.0.0.1", port: 0 },
      }
    ).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));

    const resized = yield* runtime.resize(machine, { diskGib: 4 }, false).pipe(
      Effect.as("resized"),
      Effect.catchTag("Unsizable", () => Effect.succeed("unsizable"))
    );

    const readsAfterPatch = fake.readsAfterPatch();
    const { diskGib } = yield* runtime.sizes(machine);

    return { resized, readsAfterPatch, diskGib };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("an agent-sandbox disk grown while stopped", () => {
  it.live("answers once the cluster has grown it late", () =>
    Effect.gen(function* () {
      const old = sized("2Gi");

      expect(
        yield* grown({
          asked: "2Gi",
          before: old,
          after: [old, old, old, sized("4Gi")],
        })
      ).toStrictEqual({ resized: "resized", readsAfterPatch: 4, diskGib: 4 });
    })
  );

  it.live(
    "answers the size the volume grew to while only the next mount's filesystem resize is left",
    () =>
      Effect.gen(function* () {
        expect(
          yield* grown({
            asked: "2Gi",
            before: sized("2Gi"),
            after: [sized("2Gi", "4Gi", "NodeResizePending")],
          })
        ).toStrictEqual({ resized: "resized", readsAfterPatch: 1, diskGib: 4 });
      })
  );

  it.live(
    "waits out the pending filesystem resize of an earlier, smaller growth",
    () =>
      Effect.gen(function* () {
        const earlier = sized("2Gi", "3Gi", "NodeResizePending");

        expect(
          yield* grown({
            asked: "3Gi",
            before: earlier,
            after: [earlier, earlier, sized("2Gi", "4Gi", "NodeResizePending")],
          })
        ).toStrictEqual({ resized: "resized", readsAfterPatch: 3, diskGib: 4 });
      })
  );

  it.live(
    "grows past an earlier growth the cluster gave up on to a size it can give",
    () =>
      Effect.gen(function* () {
        const failed = sized("2Gi", "8Gi", "ControllerResizeInfeasible");

        expect(
          yield* grown({
            asked: "8Gi",
            before: failed,
            after: [failed, failed, sized("4Gi")],
          })
        ).toStrictEqual({ resized: "resized", readsAfterPatch: 3, diskGib: 4 });
      })
  );

  it.live(
    "fails unsizable and keeps its old size where the cluster can't grow it",
    () =>
      Effect.gen(function* () {
        expect(
          yield* grown({
            asked: "2Gi",
            before: sized("2Gi"),
            after: [sized("2Gi", "4Gi", "ControllerResizeInfeasible")],
          })
        ).toStrictEqual({
          resized: "unsizable",
          readsAfterPatch: 1,
          diskGib: 2,
        });
      })
  );
});
