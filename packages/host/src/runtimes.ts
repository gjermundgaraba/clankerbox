import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { type FileSystem, type Layer, Match } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import type { HostConfig } from "./config.ts";
import * as Boat from "./platform/boat/boat.ts";
import * as Smolvm from "./platform/smolvm.ts";
import * as Tart from "./platform/tart/tart.ts";
import type { RecordNative, Runtime } from "./runtime.ts";

export const runtimeLayer = (
  config: HostConfig,
  recordNative: RecordNative,
): Layer.Layer<
  Runtime,
  HostError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Match.value(config).pipe(
    Match.discriminatorsExhaustive("runtime")({
      smolvm: (smolvm) => Smolvm.layer(smolvm),
      tart: (tart) => Tart.layer(tart),
      boat: (boat) => Boat.layer(boat, recordNative),
    }),
  );
