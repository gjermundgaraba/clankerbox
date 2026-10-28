import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";
import type { FileSystem, Path } from "effect";
import { HttpRouter } from "effect/http";
import type {
  Etag,
  HttpClient,
  HttpPlatform,
  HttpServer,
  HttpServerError,
} from "effect/http";

import * as Checkpoints from "../checkpoints.ts";
import * as Leases from "../leases.ts";
import * as Machines from "../machines.ts";
import * as BindProbe from "../platform/bind-probe.ts";
import * as Sqlite from "../platform/sqlite.ts";
import * as Tailscale from "../platform/tailscale.ts";
import type { Runtime } from "../runtime.ts";
import type { HostSettings } from "../settings.ts";
import { startup } from "../startup.ts";
import type { CannotStart } from "../startup.ts";
import type * as Store from "../store.ts";
import { routes } from "./routes.ts";

export type ServerLayer = Layer.Layer<
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path,
  HttpServerError.ServeError
>;

export const servicesLayer = <E, R>(
  config: HostSettings,
  runtime: Layer.Layer<Runtime, E, R>
): Layer.Layer<
  Machines.Machines | Checkpoints.Checkpoints | Store.Store | Runtime,
  HostError | CannotStart | E,
  R | FileSystem.FileSystem
> =>
  Checkpoints.layer(config).pipe(
    Layer.provideMerge(Machines.layer(config)),
    Layer.provide(startup(config)),
    Layer.provide(Layer.merge(BindProbe.layer, Leases.layer)),
    Layer.provideMerge(runtime.pipe(Layer.provideMerge(Sqlite.layer(config))))
  );

export interface HostLayerConfig extends HostSettings {
  readonly tailnet?: Tailscale.TailnetSettings | undefined;
}

export const hostLayer = <E, R>(
  config: HostLayerConfig,
  runtime: Layer.Layer<Runtime, E, R>,
  server: ServerLayer
): Layer.Layer<
  | HttpServer.HttpServer
  | Machines.Machines
  | Checkpoints.Checkpoints
  | Store.Store,
  HostError | CannotStart | E,
  R | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  HttpRouter.serve(routes(config)).pipe(
    Layer.provideMerge(
      Layer.catchTag(server, "ServeError", (error) =>
        Layer.effectContext(
          Effect.fail(
            new Internal({
              message: `couldn't listen on ${config.listen.address}:${config.listen.port}: ${String(error.cause)}`,
            })
          )
        )
      )
    ),
    Layer.provideMerge(servicesLayer(config, runtime)),
    Layer.provide(
      config.tailnet === undefined
        ? Layer.empty
        : Tailscale.layer(config.tailnet)
    )
  );
