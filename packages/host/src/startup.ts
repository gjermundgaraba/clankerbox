/**
 * The host's one startup step, before the actions are built: every action the last host process
 * left running is marked failed, then the runtime runs its own startup over the host's machines.
 */
import { Effect, Layer } from "effect";
import { machineRef } from "./actions.ts";
import type { HostConfig } from "./config.ts";
import { Runtime } from "./runtime.ts";
import { Store } from "./store.ts";

export const startup = (config: Pick<HostConfig, "id">) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* Store;

      yield* store.failInterrupted;

      const machines = yield* store.list;

      yield* (yield* Runtime).startup(machines.map((record) => machineRef(config.id, record)));
    }),
  );
