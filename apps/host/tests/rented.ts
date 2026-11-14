import { createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect, Exit, FileSystem, Scope } from "effect";

import type { PortRange } from "../src/machine-ports.ts";
import type { FakeBoat } from "./fake-boat.ts";
import type { FakeSmolCloud } from "./fake-smol-cloud.ts";
import { rentedRange, suitePorts } from "./port-slot.ts";
import { boat, smolCloud } from "./providers.ts";
import type { Provider } from "./serving.ts";
import { startHostOver } from "./support.ts";

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

const startOn = <F>(provider: Provider<F>, dir: string, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const ports = yield* Scope.provide(machinePorts, scope);

    const api = yield* Scope.provide(
      provider.fake(path.join(dir, "api"), undefined),
      scope
    );

    const keyFile = path.join(dir, "key");

    yield* fs.writeFileString(keyFile, `${api.key}\n`, { mode: 0o600 });

    const host = yield* Scope.provide(
      startHostOver(
        dir,
        (settings) =>
          provider.layer({ url: api.url, key: api.key, keyFile }, settings),
        {
          id,
          ports,
          bases: new Map([["ubuntu", provider.image]]),
          http: NodeHttpClient.layerNodeHttp,
        }
      ),
      scope
    );

    return {
      id: host.id,
      url: host.url,
      fake: api.fake,
      traits: provider.traits,
      dispose: Scope.close(scope, Exit.void),
    };
  });

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
  options.runtime === "smol-cloud"
    ? Effect.map(
        startOn(smolCloud(options.guestPath), dir, options.id),
        ({ fake, ...host }): RentedHost => ({
          ...host,
          api: { runtime: "smol-cloud", fake },
        })
      )
    : Effect.map(
        startOn(boat(), dir, options.id),
        ({ fake, ...host }): RentedHost => ({
          ...host,
          api: { runtime: "boat", fake },
        })
      );
