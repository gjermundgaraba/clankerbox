/** The host role: one runtime, its machines' state, and the API on the host's own address. */
import { type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, type FileSystem, Layer } from "effect";
import * as Checkpoints from "./checkpoints.ts";
import { type HostConfig, loadConfig } from "./config.ts";
import * as Machines from "./machines.ts";
import type { Runtime } from "./runtime.ts";
import { runtimeLayer } from "./runtimes.ts";
import { serve } from "./server.ts";
import * as Store from "./store.ts";

/**
 * The whole host over `runtime`: the state dir's database with its owner lock, startup
 * recovery, then the API. The server binds only after recovery.
 */
export const hostLayer = <E, R>(
  config: HostConfig,
  runtime: Layer.Layer<Runtime, E, R>,
): Layer.Layer<never, HostError | E, R | FileSystem.FileSystem> =>
  serve(config).pipe(
    Layer.catchTag("ServeError", (error) =>
      Layer.effectDiscard(
        Effect.fail(
          new Internal({
            message: `couldn't listen on ${config.listen.address}:${config.listen.port}: ${String(error.cause)}`,
          }),
        ),
      ),
    ),
    Layer.provide(Layer.merge(Machines.layer(config), Checkpoints.layer(config))),
    // The runtime is built only once the store holds the state dir's owner lock: a runtime may
    // write there (smolvm creates its inventory), and a second host must not touch it at all.
    Layer.provide(
      runtime.pipe(
        Layer.provideMerge(Layer.effect(Store.Store, Store.open(config.stateDir, config.id))),
      ),
    ),
  );

/** Runs the host from the config file at `file` until the process is stopped. */
export const runHost = (file: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(file);

    return yield* Layer.launch(hostLayer(config, runtimeLayer(config)));
  });
