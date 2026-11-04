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
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { Context, Duration, Effect, Exit, Layer, Logger, Scope } from "effect";
import { HttpServer } from "effect/http";

import { applied } from "../src/chart.ts";
import * as Checkpoints from "../src/checkpoints.ts";
import { serverLayer } from "../src/composition/server.ts";
import {
  machineChart,
  phaseOf as phaseOfLeaf,
  stageOf as stageOfLeaf,
} from "../src/machine-chart.ts";
import type { MachineEvent, MachineRow } from "../src/machine-chart.ts";
import * as Machines from "../src/machines.ts";
import { defaultFailedRowsLast } from "../src/settings.ts";
import type { ServerSettings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type {
  CannotStart,
  Facts,
  Interface as StoreInterface,
} from "../src/store.ts";
import * as Templates from "../src/templates.ts";

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

export const addsLoginUser = [
  'mkdir -p "$CLANKERBOX_ROOT/etc"',
  'echo "admin:x:1000:1000::/home/admin:/bin/sh" >>"$CLANKERBOX_ROOT/etc/passwd"',
].join("\n");

type BaseRequest = Extract<CreateRequest, { readonly base: string }>;

export const request = (
  name: string,
  fields?: Partial<BaseRequest>
): BaseRequest => ({
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

export const phaseOf = ({ state }: Pick<MachineRow, "state">) =>
  phaseOfLeaf(state);

export const stageOf = ({ state }: Pick<MachineRow, "state">) =>
  stageOfLeaf(state);

/** One event through the chart, as the loop writes it, with no loop told. */
export const applying = (
  store: StoreInterface,
  name: string,
  event: MachineEvent
) =>
  store.advance("machine", name, (row, op) =>
    applied(machineChart, row, event, op)
  );

/** Facts no event sets, as a VM that booted under an older pin leaves them. */
export const patched = (
  store: StoreInterface,
  name: string,
  facts: Partial<Facts>
) =>
  store.advance("machine", name, (row) => ({
    next: { ...row, ...facts },
    finish: false,
  }));

export interface Started {
  readonly url: string;
  readonly machines: Machines.Interface;
  readonly checkpoints: Checkpoints.Interface;
  readonly templates: Templates.Interface;
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

const started = (
  settings: ServerSettings,
  port: number,
  logger: Logger.Logger<unknown, unknown> | undefined
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const context = yield* Layer.buildWithScope(
      serverLayer(
        settings,
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })
      ).pipe(
        Layer.provideMerge(Logger.layer(logger === undefined ? [] : [logger])),
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
      templates: Context.get(context, Templates.Templates),
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
  readonly hosts?: ReadonlyArray<{
    readonly id: string;
    readonly kind?: Kind;
    /** This host's own, over `runtime`. */
    readonly options?: Parameters<typeof startHost>[1];
  }>;
  readonly draining?: readonly string[];
  readonly recheck?: Duration.Duration;
  readonly failedRowsLast?: Duration.Duration;
  readonly runtime?: Parameters<typeof startHost>[1];
  /** Gives every guest tailscaled and tailscale, so a host's tailnet check finds them. */
  readonly tailscaled?: boolean;
  /** Hears the control plane's log, which goes nowhere without one. */
  readonly logger?: Logger.Logger<unknown, unknown>;
}) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const members = options?.hosts ?? [{ id: "linux" }];

    const hosts = yield* Effect.forEach(members, ({ id, kind, options: own }) =>
      Effect.suspend(() => {
        if (options?.tailscaled === true) {
          writeTailscaleStubs(path.join(dir, id, "bin"));
        }

        return startHost(path.join(dir, id), {
          id,
          ...(kind === undefined ? {} : { kind }),
          ports: portRange(),
          ...options?.runtime,
          ...own,
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
      authorizedKeys: `${operatorKey}\n`,
    };

    const plan: Plane = {
      dir,
      stateDir,
      hosts,
      settings,
      start: (port = 0) => started(settings, port, options?.logger),
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

export const firstHost = (served: Pick<Plane, "hosts">): TestHost => {
  const [host] = served.hosts;

  if (host === undefined) {
    throw new Error("a plane without a host");
  }

  return host;
};

export const withClient = (options?: Parameters<typeof running>[0]) =>
  Effect.gen(function* () {
    const served = yield* running(options);
    const client = yield* clientOf(served.url);

    return { ...served, client, host: firstHost(served) };
  });

export const machineNames = (served: Pick<Started, "store">) =>
  Effect.map(served.store.machines, (rows) => rows.map(({ name }) => name));

export const callsTo = (host: TestHost, operation: string) =>
  host.fake.calls.filter((call) => call.startsWith(`${operation} `));
