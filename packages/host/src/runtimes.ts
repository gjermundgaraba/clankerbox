/**
 * The runtime a host process runs, by its config's `runtime`. A new runtime is a module that
 * provides `Runtime`, and an entry here.
 */
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { type FileSystem, type Layer, Match } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { HostConfig } from "./config.ts";
import type { Runtime } from "./runtime.ts";
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
    }),
  );
