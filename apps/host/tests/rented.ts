import { createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Scope,
} from "effect";
import { HttpServer } from "effect/http";

import { hostLayer } from "../src/composition/host.ts";
import type { PortRange } from "../src/machine-ports.ts";
import * as Boat from "../src/platform/boat/boat.ts";
import * as SmolCloud from "../src/platform/smol-cloud/smol-cloud.ts";
import { fakeBoat, traits as boatTraits } from "./fake-boat.ts";
import type { FakeBoat } from "./fake-boat.ts";
import { fakeSmolCloud, traits as smolCloudTraits } from "./fake-smol-cloud.ts";
import type { FakeSmolCloud } from "./fake-smol-cloud.ts";
import { rentedRange, suitePorts } from "./port-slot.ts";
import { hostConfig, image, loopbackServer } from "./support.ts";

export type RentedApi =
  | { readonly runtime: "smol-cloud"; readonly fake: FakeSmolCloud }
  | { readonly runtime: "boat"; readonly fake: FakeBoat };

export type RentedRuntime = RentedApi["runtime"];

export interface RentedHost {
  readonly id: string;
  readonly url: string;
  readonly api: RentedApi;
  readonly traits: RuntimeTraits;
  readonly dispose: Effect.Effect<void>;
}

const smolCloudKey = "fake-smol-cloud-key";

const guarded = (port: number): Effect.Effect<Server | undefined> =>
  Effect.callback((resume) => {
    const server = createServer();

    server.once("error", () => {
      resume(Effect.undefined);
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.unref();
      resume(Effect.succeed(server));
    });
  });

const machinePorts: Effect.Effect<PortRange, never, Scope.Scope> = Effect.gen(
  function* () {
    const { rented } = suitePorts;

    for (
      let guard = rented.first;
      guard + rentedRange - 1 <= rented.last;
      guard += rentedRange
    ) {
      const held = yield* Effect.acquireRelease(guarded(guard), (server) =>
        Effect.sync(() => server?.close())
      );

      if (held !== undefined) {
        return { first: guard + 1, last: guard + rentedRange - 1 };
      }
    }

    return yield* Effect.die(
      new Error(
        `every block of rented machine ports in ${rented.first}-${rented.last} is held by another host of this run`
      )
    );
  }
);

/**
 * A host over the real adapter of a rented runtime, driving that provider's fake API in this
 * process, with `ubuntu` as the provider's image. It ends with the scope, or at `dispose`. Its
 * machine ports are a block of the run's `suitePorts.rented` after a guard port it listens on while
 * it runs, so two hosts of the run, in test files side by side, never take the same ones.
 */
export const startRentedHost = (
  dir: string,
  options: {
    readonly runtime: RentedRuntime;
    readonly id: string;
    /** On smol cloud, an exec's `PATH` after the fake's own stubs, the runner's own unless given. */
    readonly guestPath?: string | undefined;
  }
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const apiDir = path.join(dir, "api");
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const config = hostConfig(
      path.join(dir, "state"),
      yield* Scope.provide(machinePorts, scope),
      options.id
    );

    const rented =
      options.runtime === "smol-cloud"
        ? yield* Effect.gen(function* () {
            const fake = yield* fakeSmolCloud({
              dir: apiDir,
              key: smolCloudKey,
              guestPath: options.guestPath,
            });

            const apiKeyFile = path.join(dir, "key");

            yield* fs.writeFileString(apiKeyFile, `${smolCloudKey}\n`, {
              mode: 0o600,
            });

            return {
              api: { runtime: "smol-cloud", fake } as const,
              traits: smolCloudTraits,
              bases: new Map([["ubuntu", image]]),
              layer: SmolCloud.layer({ apiKeyFile, api: fake.url }, config),
            };
          })
        : yield* Effect.map(
            fakeBoat({ dir: apiDir, id: options.id }),
            (fake) => ({
              api: { runtime: "boat", fake } as const,
              traits: boatTraits,
              bases: new Map([["ubuntu", Boat.image]]),
              layer: fake.layer,
            })
          );

    const context = yield* Layer.buildWithScope(
      hostLayer(
        { ...config, bases: rented.bases },
        rented.layer,
        loopbackServer()
      ).pipe(
        Layer.provideMerge(Logger.layer([])),
        Layer.provide(NodeHttpClient.layerNodeHttp),
        Layer.provide(NodeServices.layer)
      ),
      scope
    );

    const host: RentedHost = {
      id: options.id,
      url: HttpServer.formatAddress(
        Context.get(context, HttpServer.HttpServer).address
      ),
      api: rented.api,
      traits: rented.traits,
      dispose: Scope.close(scope, Exit.void),
    };

    return host;
  });
