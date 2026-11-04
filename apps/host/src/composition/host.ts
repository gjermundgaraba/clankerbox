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
import * as S3 from "../platform/s3.ts";
import * as Tailscale from "../platform/tailscale.ts";
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
  HttpServer.HttpServer | Operations.Operations | Runtime,
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
    Layer.provide(Layer.merge(BindProbe.layer, startedUp)),
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
