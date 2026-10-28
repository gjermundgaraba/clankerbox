import type {
  Conflict,
  Desired,
  Internal,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { Sizes } from "./runtime.ts";

export interface Desire {
  readonly desired: Desired;
  readonly generation: number;
}

export interface Intent {
  readonly name: string;
  readonly instance: string;
  readonly createdAt: DateTime.Utc;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  readonly port: number;
  readonly desired: Desired;
  readonly generation: number;
  readonly ephemeral: boolean;
  readonly made: boolean;
  readonly hostKey: string | undefined;
  readonly pin: string | undefined;
}

export interface CheckpointRecord {
  readonly name: string;
  readonly instance: string;
  readonly createdAt: DateTime.Utc;
  readonly machine: string;
  readonly pin: string | undefined;
  readonly port: number;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

export interface Interface {
  readonly machines: Effect.Effect<readonly Intent[], Internal>;
  readonly findMachine: (
    name: string
  ) => Effect.Effect<Option.Option<Intent>, Internal>;
  readonly ports: Effect.Effect<ReadonlySet<number>, Internal>;
  readonly insertMachine: (
    intent: Intent
  ) => Effect.Effect<void, Conflict | Internal>;
  readonly desire: (
    name: string,
    desired: Desired
  ) => Effect.Effect<Option.Option<Desire>, Internal>;
  readonly made: (name: string) => Effect.Effect<void, Internal>;
  readonly hostKey: (
    name: string,
    hostKey: string
  ) => Effect.Effect<void, Internal>;
  readonly bootedUnder: (
    name: string,
    pin: string | undefined
  ) => Effect.Effect<void, Internal>;
  readonly sized: (name: string, sizes: Sizes) => Effect.Effect<void, Internal>;
  readonly removeMachine: (name: string) => Effect.Effect<void, Internal>;
  readonly checkpoints: Effect.Effect<readonly CheckpointRecord[], Internal>;
  readonly findCheckpoint: (
    name: string
  ) => Effect.Effect<Option.Option<CheckpointRecord>, Internal>;
  readonly anyCheckpoint: (
    name: string
  ) => Effect.Effect<Option.Option<CheckpointRecord>, Internal>;
  readonly beginCheckpoint: (
    record: CheckpointRecord
  ) => Effect.Effect<void, Conflict | Internal>;
  readonly readyCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  readonly retireCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  readonly removeCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  readonly unready: Effect.Effect<readonly CheckpointRecord[], Internal>;
}

export class Store extends Context.Service<Store, Interface>()(
  "@clankerbox/host/Store"
) {}
