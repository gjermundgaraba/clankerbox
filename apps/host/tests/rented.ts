import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { RuntimeTraits } from "@gjermundgaraba/clankerbox-sdk";
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
import { hostConfig, image, loopbackServer } from "./support.ts";

export type RentedApi =
  | { readonly runtime: "smol-cloud"; readonly fake: FakeSmolCloud }
  | { readonly runtime: "boat"; readonly fake: FakeBoat };

export type RentedRuntime = RentedApi["runtime"];

export interface RentedHost {
  readonly id: string;
  readonly url: string;
  /** The fake API's folder: on smol cloud, an exec's `PATH` begins with its `bin`. */
  readonly apiDir: string;
  readonly api: RentedApi;
  readonly traits: RuntimeTraits;
  readonly dispose: Effect.Effect<void>;
}

const smolCloudKey = "fake-smol-cloud-key";

/**
 * A host over the real adapter of a rented runtime, driving that provider's fake API in this
 * process, with `ubuntu` as the provider's image. It ends with the scope, or at `dispose`.
 */
export const startRentedHost = (
  dir: string,
  options: {
    readonly runtime: RentedRuntime;
    readonly id: string;
    /** Its machines' ports, apart from every other suite's, as the suites run side by side. */
    readonly ports: PortRange;
  }
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const apiDir = path.join(dir, "api");

    const config = hostConfig(
      path.join(dir, "state"),
      options.ports,
      options.id
    );

    const rented =
      options.runtime === "smol-cloud"
        ? yield* Effect.gen(function* () {
            const fake = yield* fakeSmolCloud({
              dir: apiDir,
              key: smolCloudKey,
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

    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

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
      apiDir,
      api: rented.api,
      traits: rented.traits,
      dispose: Scope.close(scope, Exit.void),
    };

    return host;
  });
