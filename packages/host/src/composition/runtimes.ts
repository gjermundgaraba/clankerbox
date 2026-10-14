import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import { type FileSystem, type Layer, Match } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import type { HostConfig } from "./config.ts";
import * as Boat from "../platform/boat/boat.ts";
import * as Smolvm from "../platform/smolvm.ts";
import * as Tart from "../platform/tart/tart.ts";
import type { Runtime } from "../runtime.ts";
import type { NativeIds } from "../store.ts";

export const runtimeLayer = (
  config: HostConfig,
): Layer.Layer<
  Runtime,
  HostError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | NativeIds
> =>
  Match.value(config).pipe(
    Match.discriminatorsExhaustive("runtime")({
      smolvm: (smolvm) => Smolvm.layer(smolvm),
      tart: (tart) => Tart.layer(tart),
      boat: (boat) => Boat.layer(boat),
    }),
  );
