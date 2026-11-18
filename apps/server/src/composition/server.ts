import { Server } from "node:http";

import { journal } from "@clankerbox/host-contract/journal";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
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
import type { Tailnet } from "../tailnet.ts";
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

class ClosingEveryConnection extends Server {
  override close(callback?: (error?: Error) => void) {
    super.close(callback);
    this.closeAllConnections();

    return this;
  }
}

/**
 * The control plane's Node server, on its config's address. It stops at once, cutting the requests
 * still open. A write is one SQLite transaction, which a stop never splits, and a request it cuts
 * is one a crash would cut: the client reads to see what a mutation did, and a wait reads on
 * through the outage.
 *
 * Without the preemptive shutdown, the stop takes the routes off, cuts the requests they run, waits
 * for each to answer 503, and only then closes the server. A connection still open then is owed
 * nothing, so the server closes every one, where Node's own close closes the idle ones and waits on
 * the rest, on one whose request never completes for good. A request that comes once the routes
 * are off meets its connection closed, unanswered, once the requests the stop cut have ended, a
 * few milliseconds later as each ends at once, which its client reads as it reads a 503.
 */
export const controlPlaneServer = ({
  listen,
}: Pick<ServerSettings, "listen">) =>
  NodeHttpServer.layer(() => new ClosingEveryConnection(), {
    host: listen.address,
    port: listen.port,
    disablePreemptiveShutdown: true,
  });

/** The control plane, over `tailnet` when its config names one: without it, no machine joins one. */
export const serverLayer = (
  config: ServerSettings,
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
  HttpRouter.serve(routes, {
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
