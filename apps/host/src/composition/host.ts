import { Server } from "node:http";

import { stoppingStatus } from "@clankerbox/host-contract";
import { journal } from "@clankerbox/host-contract/journal";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";
import type { FileSystem, Path } from "effect";
import { HttpRouter } from "effect/http";
import type {
  Etag,
  HttpPlatform,
  HttpServer,
  HttpServerError,
} from "effect/http";

import type { PortProbe } from "../machine-ports.ts";
import * as Operations from "../operations.ts";
import * as BindProbe from "../platform/bind-probe.ts";
import * as Relay from "../platform/relay.ts";
import * as Reach from "../reach.ts";
import { Runtime } from "../runtime.ts";
import type { CannotStart } from "../runtime.ts";
import type { HostSettings } from "../settings.ts";
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
 * Without the preemptive shutdown, the stop takes the routes off, cuts the requests they run, waits
 * for each to answer 503, and only then closes the server. A connection still open then is owed
 * nothing, so the server closes every one, where Node's own close closes the idle ones and waits on
 * the rest, on one whose request never completes for good.
 *
 * The routes go on after the server listens and come off when the stop begins, so a request that
 * finds no more request listeners than the server had when it began listening, ours and any the
 * library keeps for itself, is one no route will take. It answers 503 with Connection: close, so a
 * kept-alive client opens a fresh connection for its next request rather than meet the final close
 * mid-request, where a mutation would read as maybe run, not as sent to a stopping host.
 */
export const hostServer = ({ listen }: Pick<HostSettings, "listen">) =>
  NodeHttpServer.layer(
    () => {
      const server = new ClosingEveryConnection();
      let unroutedListeners = Infinity;

      server.once("listening", () => {
        unroutedListeners = server.listenerCount("request");
      });

      server.on("request", (_request, response) => {
        const unrouted = server.listenerCount("request") <= unroutedListeners;

        if (unrouted) {
          response.writeHead(stoppingStatus, { connection: "close" }).end();
        }
      });

      return server;
    },
    {
      host: listen.address,
      port: listen.port,
      disablePreemptiveShutdown: true,
    }
  );

const startedUp = Layer.effectDiscard(
  Effect.flatMap(Runtime, ({ startup }) => startup)
);

export const hostLayer = <E, R>(
  config: HostSettings,
  runtime: Layer.Layer<Runtime, E, R>,
  server: ServerLayer
): Layer.Layer<
  HttpServer.HttpServer | Operations.Operations | Reach.Reaches | Runtime,
  HostError | CannotStart | E,
  Exclude<R, PortProbe> | FileSystem.FileSystem | Path.Path
> =>
  HttpRouter.serve(routes(config), {
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
    Layer.provideMerge(Operations.layer(config)),
    Layer.provideMerge(Reach.layer(config.machinePorts)),
    Layer.provide(Layer.mergeAll(BindProbe.layer, Relay.layer, startedUp)),
    Layer.provideMerge(Layer.provide(runtime, BindProbe.layer))
  );
