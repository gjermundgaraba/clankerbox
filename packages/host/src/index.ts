/** The host role: one runtime, its machines' state, and the API on the host's own address. */
import { type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, type FileSystem, Layer } from "effect";
import * as Checkpoints from "./checkpoints.ts";
import { type HostConfig, loadConfig } from "./config.ts";
import * as Machines from "./machines.ts";
import type { RecordNative, Runtime } from "./runtime.ts";
import { runtimeLayer } from "./runtimes.ts";
import { serve } from "./server.ts";
import { startup } from "./startup.ts";
import * as Store from "./store.ts";

/**
 * The whole host over the runtime `runtime` builds: the state dir's database with its owner
 * lock, startup recovery, then the API. The server binds only after recovery. `runtime` gets
 * the store's `recordNative`, for a runtime that assigns its own IDs, and nothing else of it.
 */
export const hostLayer = <E, R>(
  config: HostConfig,
  runtime: (recordNative: RecordNative) => Layer.Layer<Runtime, E, R>,
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
    Layer.provide(
      Layer.merge(Machines.layer(config), Checkpoints.layer(config)).pipe(
        Layer.provide(startup(config)),
      ),
    ),
    // The runtime is built only once the store holds the state dir's owner lock: a runtime may
    // write there (smolvm creates its inventory), and a second host must not touch it at all.
    // A runtime that owns a native ID, as boat does its sandbox's, records it through the
    // store's `recordNative`, which is all of the store it gets.
    Layer.provide(
      Layer.unwrap(
        Effect.map(Effect.service(Store.Store), (store) => runtime(store.recordNative)),
      ).pipe(Layer.provideMerge(Layer.effect(Store.Store, Store.open(config)))),
    ),
  );

/** Runs the host from the config file at `file` until the process is stopped. */
export const runHost = (file: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(file);

    return yield* Layer.launch(
      hostLayer(config, (recordNative) => runtimeLayer(config, recordNative)),
    );
  });
