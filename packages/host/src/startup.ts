import { Effect, Layer } from "effect";
import { machineRef } from "./claims.ts";
import type { HostSettings } from "./settings.ts";
import { Runtime } from "./runtime.ts";
import { Store } from "./store.ts";

export const startup = (config: Pick<HostSettings, "id">) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.failInterrupted;

      const machines = yield* store.list;

      yield* (yield* Runtime).startup(machines.map((record) => machineRef(config.id, record)));
    }),
  );
