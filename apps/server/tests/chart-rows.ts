import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime } from "effect";

import type { CheckpointFacts, Facts, Operation } from "../src/store.ts";

/** The failure a report or a read carries. */
export const failure = new Internal({ message: "krun busy" });

/** When a report's step ended. */
export const when = DateTime.makeUnsafe(7);

/** What the chart's table and its tests take a row to hold, but for what each sets. */
export const facts = (fields?: Partial<Facts>): Facts => ({
  name: "dev",
  instance: "1",
  createdAt: DateTime.makeUnsafe(0),
  kind: "linux",
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  host: "linux",
  port: undefined,
  desired: "running",
  prepared: false,
  error: undefined,
  resize: undefined,
  ephemeral: false,
  source: { kind: "base", scripted: true },
  prebuild: undefined,
  hostKey: undefined,
  pin: "pin",
  undoneAt: undefined,
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
  seen: "unknown",
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
  kind: "linux",
  pin: "pin",
  port: 2222,
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  error: undefined,
  failedAt: undefined,
  ...fields,
});
