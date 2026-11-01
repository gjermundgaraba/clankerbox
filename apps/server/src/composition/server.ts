import { Internal } from "@gjermundgaraba/clankerbox-sdk";
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
import * as Hosts from "../hosts.ts";
import * as Machines from "../machines.ts";
import * as Sqlite from "../platform/sqlite.ts";
import type { ServerSettings } from "../settings.ts";
import type { CannotStart, Store } from "../store.ts";
import { routes } from "./routes.ts";

export type ServerLayer = Layer.Layer<
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path,
  HttpServerError.ServeError
>;

export const serverLayer = (
  config: ServerSettings,
  server: ServerLayer
): Layer.Layer<
  | HttpServer.HttpServer
  | Machines.Machines
  | Checkpoints.Checkpoints
  | Hosts.Hosts
  | Store,
  CannotStart | Internal,
  HttpClient.HttpClient | FileSystem.FileSystem
> =>
  HttpRouter.serve(routes).pipe(
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
    Layer.provideMerge(Checkpoints.layer(config)),
    Layer.provideMerge(Machines.layer(config)),
    Layer.provideMerge(Hosts.layer(config.hosts)),
    Layer.provideMerge(Sqlite.layer(config))
  );
