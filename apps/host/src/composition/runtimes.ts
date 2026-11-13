import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import type { FileSystem, Layer, Schema } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import * as SmolCloud from "../platform/smol-cloud/smol-cloud.ts";
import * as Smolvm from "../platform/smolvm/smolvm.ts";
import * as Tart from "../platform/tart/tart.ts";
import type { CannotStart, Runtime } from "../runtime.ts";
import type { HostSettings } from "../settings.ts";

type RuntimeLayer = Layer.Layer<
  Runtime,
  HostError | CannotStart,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
>;

export const runtimes = {
  smolvm: { settings: Smolvm.SmolvmSettings, layer: Smolvm.layer },
  tart: { settings: Tart.TartSettings, layer: Tart.layer },
  "smol-cloud": {
    settings: SmolCloud.SmolCloudSettings,
    layer: SmolCloud.layer,
  },
};

export type RuntimeKey = keyof typeof runtimes;

type SettingsOf<K extends RuntimeKey> =
  (typeof runtimes)[K]["settings"]["Type"];

interface Registration<T> {
  readonly settings: Schema.Decoder<T>;
  readonly layer: (settings: T, host: HostSettings) => RuntimeLayer;
}

type Registry = { readonly [K in RuntimeKey]: Registration<SettingsOf<K>> };

const registry: Registry = runtimes;

export interface ChosenRuntime<K extends RuntimeKey = RuntimeKey> {
  readonly name: K;
  readonly settings: SettingsOf<K>;
}

export const isRuntimeKey = (name: string): name is RuntimeKey =>
  Object.hasOwn(runtimes, name);

export const settingsOf = <K extends RuntimeKey>(
  name: K
): Schema.Decoder<SettingsOf<K>> => registry[name].settings;

export const runtimeLayer = <K extends RuntimeKey>(
  { name, settings }: ChosenRuntime<K>,
  host: HostSettings
): RuntimeLayer => registry[name].layer(settings, host);
