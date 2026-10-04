/**
 * The host's one startup step, before the actions are built: every action the last host process
 * left running is marked failed, then the runtime runs its own startup cleanup.
 */
import { Effect, Layer } from "effect";
import { Runtime } from "./runtime.ts";
import { Store } from "./store.ts";

export const startup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* Store).failInterrupted;
    yield* (yield* Runtime).startup;
  }),
);
