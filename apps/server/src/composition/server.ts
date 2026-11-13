import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Effect, Exit, Layer } from "effect";
import type { FileSystem, Path } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import type {
  Etag,
  HttpClient,
  HttpPlatform,
  HttpServer,
  HttpServerError,
  HttpServerResponse,
} from "effect/http";

import * as Checkpoints from "../checkpoints.ts";
import * as Hosts from "../hosts.ts";
import * as Machines from "../machines.ts";
import * as Sqlite from "../platform/sqlite.ts";
import type { ServerSettings } from "../settings.ts";
import type { CannotStart, Store } from "../store.ts";
import * as Templates from "../templates.ts";
import { routes } from "./routes.ts";

export type ServerLayer = Layer.Layer<
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path,
  HttpServerError.ServeError
>;

const internalStatus = 500;

/**
 * The journal holds what an operator acts on: a request that answers `Internal` or fails as no
 * declared error does. An answer, a refusal included, is the client's, and logs at debug.
 */
export const journaled = <E, R>(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >
) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.onExit(app, (exit) => {
      const fields = { "http.method": request.method, "http.url": request.url };

      if (Exit.isFailure(exit)) {
        return Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : Effect.annotateLogs(
              Effect.logError("a request failed", exit.cause),
              fields
            );
      }

      const status = { ...fields, "http.status": exit.value.status };

      return exit.value.status === internalStatus
        ? Effect.annotateLogs(
            Effect.logError("a request answered Internal"),
            status
          )
        : Effect.annotateLogs(Effect.logDebug("Sent HTTP response"), status);
    })
  );

export const serverLayer = (
  config: ServerSettings,
  server: ServerLayer
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
  HttpRouter.serve(routes, {
    disableLogger: true,
    middleware: journaled,
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
    Layer.provideMerge(Sqlite.layer(config))
  );
