import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { hostKeySetup } from "@gjermundgaraba/clankerbox-host/testing";
import { startRentedHost } from "@gjermundgaraba/clankerbox-host/testing/rented";
import type { RentedRuntime } from "@gjermundgaraba/clankerbox-host/testing/rented";
import type { Sizes } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { clientOf, running } from "@gjermundgaraba/clankerbox-server/testing";
import { Effect, Layer } from "effect";
import { SandboxAgent } from "sandbox-agent";
import { expect } from "vite-plus/test";

import { provider } from "../src/provider.ts";
import { fakeSsh, fakeSshIn } from "./support.ts";

const sizesOn: Record<RentedRuntime, Sizes> = {
  "smol-cloud": { cpu: 1, ramMib: 1024, diskGib: 10 },
  boat: { cpu: 2, ramMib: 4096, diskGib: 80 },
};

const agentOn = (runtime: RentedRuntime) =>
  Effect.gen(function* () {
    const dir = yield* scratch;

    const host = yield* startRentedHost(path.join(dir, "host"), {
      runtime,
      id: runtime,
    });

    const plane = yield* running({
      hosts: [],
      members: [{ id: host.id, url: host.url, draining: false }],
    });

    const client = yield* clientOf(plane.url);
    const sizes = sizesOn[runtime];

    yield* client.buildTemplate({
      template: "agent",
      base: "ubuntu",
      ...sizes,
      setup: { script: `#!/bin/sh\n${hostKeySetup}` },
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => fakeSshIn(dir)),
      (pointedBack) => Effect.sync(pointedBack)
    );

    const sandbox = yield* Effect.acquireRelease(
      Effect.sync(() =>
        provider(
          { server: plane.url, from: { template: "agent" } },
          Layer.mergeAll(NodeClient.layer(plane.url), NodeServices.layer),
          fakeSsh
        )
      ),
      (made) => Effect.promise(made.dispose)
    );

    return { client, sandbox, sizes };
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  for (const runtime of ["smol-cloud", "boat"] as const) {
    it.effect(
      `on a ${runtime} host the SDK creates a sandbox, starts a session, pauses it, resumes it with another session, and destroys it`,
      () =>
        Effect.gen(function* () {
          const { client, sandbox, sizes } = yield* agentOn(runtime);

          const sdk = yield* Effect.promise(
            async () => await SandboxAgent.start({ sandbox })
          );

          const id = (sdk.sandboxId ?? "").replace(/^clankerbox\//u, "");

          expect(yield* client.getMachine({ id })).toMatchObject({
            state: "running",
            template: "agent@1",
            ...sizes,
          });

          const first = yield* Effect.promise(
            async () => await sdk.createSession({ agent: "claude" })
          );

          expect(first.agentSessionId).toBe("agent-session");

          yield* Effect.promise(async () => {
            await sdk.pauseSandbox();
          });

          expect(yield* client.getMachine({ id })).toMatchObject({
            state: "stopped",
          });

          const resumed = yield* Effect.promise(
            async () =>
              await SandboxAgent.start({
                sandbox,
                sandboxId: `clankerbox/${id}`,
              })
          );

          expect(yield* client.getMachine({ id })).toMatchObject({
            state: "running",
          });

          const second = yield* Effect.promise(
            async () => await resumed.createSession({ agent: "claude" })
          );

          expect(second.agentSessionId).toBe("agent-session");

          yield* Effect.promise(async () => {
            await resumed.destroySandbox();
          });

          expect(yield* client.listMachines()).toStrictEqual([]);
        }),
      60_000
    );
  }
});
