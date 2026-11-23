import { journal } from "@clankerbox/host-contract/journal";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { closingServer } from "@gjermundgaraba/clankerbox-sdk/node";
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
import type { Tailnet } from "../tailnet.ts";
import * as Templates from "../templates.ts";
import type { ServerConfig } from "./config.ts";
import { routes } from "./routes.ts";

export type ServerLayer = Layer.Layer<
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path,
  HttpServerError.ServeError
>;

/**
 * Without the preemptive shutdown, the stop takes the routes off, cuts the requests they run, waits
 * for each to answer 503, and only then closes the server. A connection still open then is owed
 * nothing, so the server, `closingServer`, closes every one.
 */
export const controlPlaneServer = ({
  listen,
  tls,
}: Pick<ServerConfig, "listen" | "tls">) =>
  NodeHttpServer.layer(() => closingServer(tls), {
    host: listen.address,
    port: listen.port,
    disablePreemptiveShutdown: true,
  });

export const serverLayer = (
  config: ServerSettings & Pick<ServerConfig, "callers">,
  server: ServerLayer,
  tailnet:
    | Layer.Layer<Tailnet, never, HttpClient.HttpClient>
    | Layer.Layer<never>
): Layer.Layer<
  | HttpServer.HttpServer
  | Machines.Machines
  | Checkpoints.Checkpoints
  | Templates.Templates
  | Hosts.Hosts
  | Store,
  CannotStart | Internal,
  HttpClient.HttpClient | FileSystem.FileSystem
> =>
  HttpRouter.serve(routes(config.callers ?? []), {
    disableLogger: true,
    middleware: journal,
  }).pipe(
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
    Layer.provideMerge(Templates.layer(config)),
    Layer.provideMerge(Checkpoints.layer(config)),
    Layer.provideMerge(Machines.layer(config)),
    Layer.provideMerge(Hosts.layer(config.hosts)),
    Layer.provideMerge(Sqlite.layer(config)),
    Layer.provide(tailnet)
  );
