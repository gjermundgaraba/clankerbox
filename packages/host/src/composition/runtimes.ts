import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { type FileSystem, type Layer, Match } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { HostConfig } from "./config.ts";
import * as Smolvm from "../platform/smolvm.ts";
import * as Tart from "../platform/tart/tart.ts";
import type { Runtime } from "../runtime.ts";
import type { CannotStart } from "../startup.ts";

export const runtimeLayer = (
  config: HostConfig,
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Match.value(config).pipe(
    Match.discriminatorsExhaustive("kind")({
      linux: (linux) => Smolvm.layer(linux),
      mac: (mac) => Tart.layer(mac),
    }),
  );
