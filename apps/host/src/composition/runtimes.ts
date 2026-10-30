import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Match } from "effect";
import type { FileSystem, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import * as Smolvm from "../platform/smolvm.ts";
import * as Tart from "../platform/tart/tart.ts";
import type { Runtime } from "../runtime.ts";
import type { CannotStart } from "../startup.ts";
import type { HostConfig } from "./config.ts";

export const runtimeLayer = (
  config: HostConfig
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Match.value(config).pipe(
    Match.discriminatorsExhaustive("kind")({
      linux: (linux) => Smolvm.layer(linux),
      mac: (mac) => Tart.layer(mac),
    })
  );
