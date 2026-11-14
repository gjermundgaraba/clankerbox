import { presets } from "@gjermundgaraba/clankerbox-host/testing";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Brand, DateTime } from "effect";

import type { FreshBoot } from "../src/hosts.ts";
import type { CheckpointFacts, Facts, Operation } from "../src/store.ts";

export const freshBoot = Brand.nominal<FreshBoot>();

export const failure = new Internal({ message: "krun busy" });

export const when = DateTime.makeUnsafe(7);

/** What the chart's table and its tests take a row to hold, but for what each sets. */
export const facts = (fields?: Partial<Facts>): Facts => ({
  name: "dev",
  instance: "1",
  createdAt: DateTime.makeUnsafe(0),
  runtime: presets.smolvm.traits.runtime,
  captures: "ram",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  host: "linux",
  handle: undefined,
  endpoint: undefined,
  desired: "running",
  prepared: false,
  error: undefined,
  resize: undefined,
  ephemeral: false,
  source: { kind: "base" },
  template: undefined,
  hostKey: undefined,
  pin: "pin",
  undoneAt: undefined,
  labels: undefined,
  after: undefined,
  ...fields,
});

/** An operation in flight, for a row's write to read. */
export const flight = (
  kind: Operation["kind"],
  fields?: Partial<Operation>
): Operation => ({
  id: "op",
  kind,
  resource: "machine",
  name: "dev",
  host: "linux",
  boot: "boot",
  sequence: 1,
  leases: [],
  to: undefined,
  ...fields,
});

/** What the checkpoint chart's tests take a row to hold, but for what each sets. */
export const checkpointFacts = (
  fields?: Partial<CheckpointFacts>
): CheckpointFacts => ({
  name: "snap",
  instance: "1",
  createdAt: DateTime.makeUnsafe(0),
  machine: "dev",
  host: "linux",
  runtime: presets.smolvm.traits.runtime,
  kind: "ram",
  pin: "pin",
  handle: undefined,
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  error: undefined,
  failedAt: undefined,
  labels: undefined,
  expiresAt: undefined,
  build: undefined,
  published: undefined,
  ...fields,
});
