/**
 * The runtime a host process runs, by its config's `runtime`. A new runtime is a module that
 * provides `Runtime`, and an entry here.
 */
import { type HostError, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Match } from "effect";
import type { HostConfig } from "./config.ts";
import { Runtime } from "./runtime.ts";

export const runtimeLayer = (config: HostConfig): Layer.Layer<Runtime, HostError> =>
  Match.value(config.runtime).pipe(
    Match.when("smolvm", () =>
      Layer.effect(
        Runtime,
        Effect.fail(new Precondition({ message: "this build has no smolvm runtime yet" })),
      ),
    ),
    Match.exhaustive,
  );
