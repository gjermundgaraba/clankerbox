import { createServer } from "node:http";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  startHost,
  writeTailscaleStubs,
} from "@gjermundgaraba/clankerbox-host/testing";
import type { TestHost } from "@gjermundgaraba/clankerbox-host/testing";
import { Client } from "@gjermundgaraba/clankerbox-sdk";
import type {
  CreateRequest,
  Internal,
  Kind,
  Machine,
} from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Duration, Effect, Exit, Layer, Logger, Scope } from "effect";
import { HttpServer } from "effect/http";

import * as Checkpoints from "../src/checkpoints.ts";
import { serverLayer } from "../src/composition/server.ts";
import * as Machines from "../src/machines.ts";
import { defaultFailedRowsLast } from "../src/settings.ts";
import type { ServerSettings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { CannotStart, Interface as StoreInterface } from "../src/store.ts";

export {
  eventually,
  loginSetup,
  pause,
} from "@gjermundgaraba/clankerbox-host/testing";

/** Ends a host as a kill does, and brings it back on its port and runtime under a new boot. */
export const restartedHost = (
  host: TestHost,
  options?: Parameters<typeof startHost>[1]
) =>
  Effect.gen(function* () {
    yield* host.dispose;

    return yield* startHost(host.dir, {
      fake: host.fake,
      id: host.id,
      port: Number(new URL(host.url).port),
      ...options,
    });
  });

export const quiet = Duration.hours(1);

export const request = (
  name: string,
  fields?: Partial<CreateRequest>
): CreateRequest => ({
  id: name,
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

export const at = ({ state, desired, phase }: Machine) => [
  state,
  desired,
  phase,
];

export interface Started {
  readonly url: string;
  readonly machines: Machines.Interface;
  readonly checkpoints: Checkpoints.Interface;
  readonly store: StoreInterface;
  /** Ends the process as a kill does: memory goes, and a host hears nothing. */
  readonly crash: Effect.Effect<void>;
}

export interface Plane {
  readonly dir: string;
  readonly stateDir: string;
  readonly hosts: readonly TestHost[];
  readonly settings: ServerSettings;
  readonly start: (
    port?: number
  ) => Effect.Effect<Started, CannotStart | Internal>;
}

const started = (settings: ServerSettings, port: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const context = yield* Layer.buildWithScope(
      serverLayer(
        settings,
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })
      ).pipe(
        Layer.provideMerge(Logger.layer([])),
        Layer.provide(NodeHttpClient.layerNodeHttp),
        Layer.provide(NodeServices.layer)
      ),
      scope
    );

    const served: Started = {
      url: HttpServer.formatAddress(
        Context.get(context, HttpServer.HttpServer).address
      ),
      machines: Context.get(context, Machines.Machines),
      checkpoints: Context.get(context, Checkpoints.Checkpoints),
      store: Context.get(context, Store),
      crash: Scope.close(scope, Exit.void),
    };

    return served;
  });

const planePorts = { linux: 21_100, mac: 21_200 } as const;

let nextRange = 0;

const portRange = () => {
  nextRange += 1;

  return {
    first: planePorts.linux + nextRange * 20,
    last: planePorts.linux + nextRange * 20 + 19,
  };
};

export const plane = (options?: {
  readonly hosts?: ReadonlyArray<{ readonly id: string; readonly kind?: Kind }>;
  readonly draining?: readonly string[];
  readonly recheck?: Duration.Duration;
  readonly failedRowsLast?: Duration.Duration;
  readonly runtime?: Parameters<typeof startHost>[1];
  /** Gives every guest tailscaled and tailscale, so a host's tailnet check finds them. */
  readonly tailscaled?: boolean;
}) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const members = options?.hosts ?? [{ id: "linux" }];

    const hosts = yield* Effect.forEach(members, ({ id, kind }) =>
      Effect.suspend(() => {
        if (options?.tailscaled === true) {
          writeTailscaleStubs(path.join(dir, id, "bin"));
        }

        return startHost(path.join(dir, id), {
          id,
          ...(kind === undefined ? {} : { kind }),
          ports: portRange(),
          ...options?.runtime,
        });
      })
    );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(hosts, ({ dispose }) => dispose, { discard: true })
    );

    const stateDir = path.join(dir, "server");

    const settings: ServerSettings = {
      listen: { address: "127.0.0.1", port: 0 },
      stateDir,
      hosts: hosts.map(({ id, url }) => ({
        id,
        url,
        draining: options?.draining?.includes(id) === true,
      })),
      recheck: options?.recheck ?? quiet,
      failedRowsLast: options?.failedRowsLast ?? defaultFailedRowsLast,
    };

    const plan: Plane = {
      dir,
      stateDir,
      hosts,
      settings,
      start: (port = 0) => started(settings, port),
    };

    return plan;
  });

/** A control plane running over its hosts, ended with the test. */
export const running = (options?: Parameters<typeof plane>[0]) =>
  Effect.gen(function* () {
    const planned = yield* plane(options);
    const served = yield* planned.start();

    yield* Effect.addFinalizer(() => served.crash);

    return { ...planned, ...served };
  });

export const clientOf = (url: string, options?: Client.Options) =>
  Client.make(url, { pollEvery: Duration.millis(20), ...options }).pipe(
    Effect.provide(NodeHttpClient.layerNodeHttp)
  );
