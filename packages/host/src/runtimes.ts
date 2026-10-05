/**
 * The runtime a host process runs, by its config's `runtime`. A new runtime is a module that
 * provides `Runtime`, and an entry here.
 */
import { type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, type FileSystem, Layer, Match } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { HostConfig } from "./config.ts";
import { Runtime } from "./runtime.ts";
import * as Smolvm from "./smolvm.ts";
import * as Tart from "./tart.ts";

export const runtimeLayer = (
  config: HostConfig,
): Layer.Layer<
  Runtime,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Match.value(config).pipe(
    Match.discriminatorsExhaustive("runtime")({
      smolvm: (smolvm) => Smolvm.layer(smolvm),
      tart: (tart) => Tart.layer(tart),
      // Phase 6 builds the boat runtime on its API client (boat-api.ts); until then a boat host
      // refuses to start.
      boat: () =>
        Layer.effect(
          Runtime,
          Effect.fail(new Internal({ message: "the boat runtime isn't built yet" })),
        ),
    }),
  );
