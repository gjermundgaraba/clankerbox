/** The host role: one runtime, its machines' state, and the API on the host's own address. */
import { type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, type FileSystem, Layer, type Path } from "effect";
import {
  type Etag,
  type HttpPlatform,
  HttpRouter,
  type HttpServer,
  type HttpServerError,
} from "effect/http";
import * as Checkpoints from "./checkpoints.ts";
import * as Machines from "./machines.ts";
import type { RecordNative, Runtime } from "./runtime.ts";
import * as BindProbe from "./platform/bind-probe.ts";
import * as Sqlite from "./platform/sqlite.ts";
import { routes } from "./routes.ts";
import type { HostSettings } from "./settings.ts";
import { startup } from "./startup.ts";
import * as Store from "./store.ts";

/** What the API needs of its HTTP server, all of which `NodeHttpServer.layer` provides. */
export type ServerLayer = Layer.Layer<
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path,
  HttpServerError.ServeError
>;

/**
 * The host's services over the runtime `runtime` builds: the state dir's database with its owner
 * lock, the runtime, startup recovery, then the actions. `runtime` gets the store's
 * `recordNative`, for a runtime that assigns its own IDs, and nothing else of it.
 */
export const servicesLayer = <E, R>(
  config: HostSettings,
  runtime: (recordNative: RecordNative) => Layer.Layer<Runtime, E, R>,
): Layer.Layer<
  Machines.Machines | Checkpoints.Checkpoints | Store.Store | Runtime,
  HostError | E,
  R | FileSystem.FileSystem
> =>
  Layer.merge(Machines.layer(config), Checkpoints.layer(config)).pipe(
    Layer.provide(startup(config)),
    Layer.provide(BindProbe.layer),
    // The runtime is built only once the store holds the state dir's owner lock: a runtime may
    // write there (smolvm creates its inventory), and a second host must not touch it at all.
    // A runtime that owns a native ID, as boat does its sandbox's, records it through the
    // store's `recordNative`, which is all of the store it gets.
    Layer.provideMerge(
      Layer.unwrap(
        Effect.map(Effect.service(Store.Store), (store) => runtime(store.recordNative)),
      ).pipe(Layer.provideMerge(Sqlite.layer(config))),
    ),
  );

/**
 * The whole host: its services, served by `server`, which listens on `config.listen`. The server
 * binds only after recovery. It provides the server, the store and the actions, for a caller
 * that reads them, such as a test.
 */
export const hostLayer = <E, R>(
  config: HostSettings,
  runtime: (recordNative: RecordNative) => Layer.Layer<Runtime, E, R>,
  server: ServerLayer,
): Layer.Layer<
  HttpServer.HttpServer | Machines.Machines | Checkpoints.Checkpoints | Store.Store,
  HostError | E,
  R | FileSystem.FileSystem
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
