import { type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, type FileSystem, Layer, type Path } from "effect";
import {
  type Etag,
  type HttpPlatform,
  HttpRouter,
  type HttpServer,
  type HttpServerError,
} from "effect/http";
import * as Checkpoints from "../checkpoints.ts";
import * as Machines from "../machines.ts";
import type { Runtime } from "../runtime.ts";
import * as BindProbe from "../platform/bind-probe.ts";
import * as Sqlite from "../platform/sqlite.ts";
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
  Exclude<R, Store.NativeIds> | FileSystem.FileSystem
> => {
  const store = Sqlite.layer(config);

  const nativeIds = Layer.effect(Store.NativeIds, Effect.service(Store.NativeIds)).pipe(
    Layer.provide(store),
  );

  return Layer.merge(Machines.layer(config), Checkpoints.layer(config)).pipe(
    Layer.provide(startup(config)),
    Layer.provide(BindProbe.layer),
    Layer.provideMerge(Layer.merge(store, runtime.pipe(Layer.provide(nativeIds)))),
  );
};

export const hostLayer = <E, R>(
  config: HostSettings,
  runtime: Layer.Layer<Runtime, E, R>,
  server: ServerLayer,
): Layer.Layer<
  HttpServer.HttpServer | Machines.Machines | Checkpoints.Checkpoints | Store.Store,
  HostError | CannotStart | E,
  Exclude<R, Store.NativeIds> | FileSystem.FileSystem
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
  );
