import { Effect, Layer, Schema } from "effect";
import { machineRef } from "./claims.ts";
import type { HostSettings } from "./settings.ts";
import { Runtime } from "./runtime.ts";
import { Store } from "./store.ts";

/**
 * The host can't start as configured: its state dir, its runtime's install or the platform it
 * runs on. It ends the host before the API listens, so no client meets it.
 */
export class CannotStart extends Schema.TaggedError<CannotStart>()("CannotStart", {
  message: Schema.String,
}) {}

export const startup = (config: Pick<HostSettings, "id">) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.failInterrupted;

      const machines = yield* store.list;

      yield* (yield* Runtime).startup(machines.map((record) => machineRef(config.id, record)));
    }),
  );
