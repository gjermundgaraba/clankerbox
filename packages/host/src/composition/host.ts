import { type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, type FileSystem, Layer, type Path } from "effect";
import {
  type Etag,
  type HttpClient,
  type HttpPlatform,
  HttpRouter,
  type HttpServer,
  type HttpServerError,
} from "effect/http";
import * as Checkpoints from "../checkpoints.ts";
import * as Leases from "../leases.ts";
import * as Machines from "../machines.ts";
import type { Runtime } from "../runtime.ts";
import * as BindProbe from "../platform/bind-probe.ts";
import * as Sqlite from "../platform/sqlite.ts";
import * as Tailscale from "../platform/tailscale.ts";
import { routes } from "./routes.ts";
import type { HostSettings } from "../settings.ts";
import { type CannotStart, startup } from "../startup.ts";
import * as Store from "../store.ts";

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
  runtime: Layer.Layer<Runtime, E, R>,
): Layer.Layer<
  Machines.Machines | Checkpoints.Checkpoints | Store.Store | Runtime,
  HostError | CannotStart | E,
  R | FileSystem.FileSystem
> =>
  Checkpoints.layer(config).pipe(
    Layer.provideMerge(Machines.layer(config)),
    Layer.provide(startup(config)),
    Layer.provide(Layer.merge(BindProbe.layer, Leases.layer)),
    Layer.provideMerge(runtime.pipe(Layer.provideMerge(Sqlite.layer(config)))),
  );

/** What a host is built from: its settings, and the tailnet it joins its machines to, if any. */
export interface HostLayerConfig extends HostSettings {
  readonly tailnet?: Tailscale.TailnetSettings | undefined;
}

export const hostLayer = <E, R>(
  config: HostLayerConfig,
  runtime: Layer.Layer<Runtime, E, R>,
  server: ServerLayer,
): Layer.Layer<
  HttpServer.HttpServer | Machines.Machines | Checkpoints.Checkpoints | Store.Store,
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
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(servicesLayer(config, runtime)),
    Layer.provide(config.tailnet === undefined ? Layer.empty : Tailscale.layer(config.tailnet)),
  );
