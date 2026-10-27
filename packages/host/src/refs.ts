import { NotMade, PinMismatch } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

import { idOn } from "./ids.ts";
import type { CheckpointRef, MachineRef } from "./runtime.ts";
import type { CheckpointRecord, Intent } from "./store.ts";

export const machineRef = (host: string, intent: Intent): MachineRef => ({
  id: idOn(host)(intent.name),
  name: intent.name,
  instance: intent.instance,
  cpu: intent.cpu,
  ramMib: intent.ramMib,
  diskGib: intent.diskGib,
  port: intent.port,
});

export const checkpointRef = (
  host: string,
  record: CheckpointRecord
): CheckpointRef => ({
  id: idOn(host)(record.name),
  name: record.name,
  instance: record.instance,
  port: record.port,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
});

export const madeOn =
  (host: string) =>
  (intent: Intent): Effect.Effect<void, NotMade> =>
    intent.made
      ? Effect.void
      : Effect.fail(
          new NotMade({
            message: `machine ${idOn(host)(intent.name)} isn't made yet: its create or setup still runs`,
            machine: idOn(host)(intent.name),
          })
        );

export const pinnedOn =
  (host: string, pin: string | undefined) =>
  (intent: Intent): Effect.Effect<void, PinMismatch> =>
    intent.pin === pin
      ? Effect.void
      : Effect.fail(
          new PinMismatch({
            message: `machine ${idOn(host)(intent.name)}'s VM booted under ${intent.pin ?? "an older host"}, and this host runs ${pin ?? "no pin"}, so a copy of its RAM would restore under the wrong one: stop it and start it again first`,
          })
        );
