import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import type { FileSystem, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import * as Smolvm from "../platform/smolvm/smolvm.ts";
import * as Tart from "../platform/tart/tart.ts";
import type { CannotStart, Runtime } from "../runtime.ts";
import type { HostConfig } from "./config.ts";

type RuntimeLayer = Layer.Layer<
  Runtime,
  HostError | CannotStart,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
>;

type Registry = {
  readonly [K in HostConfig["kind"]]: (
    config: Extract<HostConfig, { readonly kind: K }>
  ) => RuntimeLayer;
};

const runtimes: Registry = {
  linux: Smolvm.layer,
  mac: Tart.layer,
};

export const runtimeLayer = <K extends HostConfig["kind"]>(
  config: Extract<HostConfig, { readonly kind: K }> & { readonly kind: K }
): RuntimeLayer => runtimes[config.kind](config);
