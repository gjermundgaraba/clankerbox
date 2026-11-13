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

import * as Operations from "../operations.ts";
import * as BindProbe from "../platform/bind-probe.ts";
import * as Relay from "../platform/relay.ts";
import * as S3 from "../platform/s3.ts";
import * as Tailscale from "../platform/tailscale.ts";
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

/**
 * How a host's Node server listens: on its config's address, and stopping at once, cutting the
 * requests still open, as its process's end would. An exec runs only as long as its request, and a
 * control plane's wait on a step asks the host again once it is back, so neither is owed the wait
 * Node gives them by default.
 */
export const listening = ({ listen }: Pick<HostSettings, "listen">) =>
  ({
    host: listen.address,
    port: listen.port,
    disablePreemptiveShutdown: true,
  }) as const;

export interface HostLayerConfig extends HostSettings {
  readonly tailnet?: Tailscale.TailnetSettings | undefined;
  readonly builds?: S3.BuildsSettings | undefined;
}

const startedUp = Layer.effectDiscard(
  Effect.flatMap(Runtime, ({ startup }) => startup)
);

export const hostLayer = <E, R>(
  config: HostLayerConfig,
  runtime: Layer.Layer<Runtime, E, R>,
  server: ServerLayer
): Layer.Layer<
  HttpServer.HttpServer | Operations.Operations | Reach.Reaches | Runtime,
  HostError | CannotStart | E,
  R | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
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
    Layer.provideMerge(Operations.layer(config)),
    Layer.provideMerge(Reach.layer(config.machinePorts)),
    Layer.provide(Layer.mergeAll(BindProbe.layer, Relay.layer, startedUp)),
    Layer.provideMerge(runtime),
    Layer.provide(
      config.tailnet === undefined
        ? Layer.empty
        : Tailscale.layer(config.tailnet)
    ),
    Layer.provide(
      config.builds === undefined ? Layer.empty : S3.layer(config.builds)
    )
  );
