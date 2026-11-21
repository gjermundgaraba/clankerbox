import type {
  CheckpointRef,
  MachineRef,
  Ref,
  Step,
} from "@clankerbox/host-contract";
import type { Internal, Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option } from "effect";
import type { Redacted } from "effect";

import { isPublished } from "./checkpoint-chart.ts";
import type { CheckpointRow } from "./checkpoint-chart.ts";
import { stageOf } from "./machine-chart.ts";
import type { MachineRow } from "./machine-chart.ts";
import { Unsendable } from "./operations.ts";
import type { Endpoint, Operation, Interface as Store } from "./store.ts";

export const identityOf = ({
  name,
  instance,
  handle,
}: MachineRow | CheckpointRow): Ref => ({
  name,
  instance,
  ...(handle === undefined ? {} : { handle }),
});

export const refOf = (row: MachineRow): MachineRef => ({
  ...identityOf(row),
  cpu: row.cpu,
  ramMib: row.ramMib,
  diskGib: row.diskGib,
  ...(row.endpoint === undefined ? {} : { port: row.endpoint.port }),
});

const checkpointRefOf = (record: CheckpointRow): CheckpointRef => ({
  ...identityOf(record),
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
});

export const hasEndpoint = (
  row: MachineRow
): row is MachineRow & { readonly endpoint: Endpoint } =>
  row.endpoint !== undefined;

export const mayHoldVm = (row: MachineRow): boolean =>
  hasEndpoint(row) && stageOf(row.state) !== "undone";

export const keptOn = (store: Store, host: string) =>
  Effect.map(store.checkpoints, (rows) =>
    rows.flatMap((row) =>
      row.host === host && row.handle !== undefined ? [row.handle] : []
    )
  );

const pinned = (pin: string | undefined) => (pin === undefined ? {} : { pin });

const copyOf = (found: Option.Option<MachineRow>) =>
  Option.getOrUndefined(
    Option.map(Option.filter(found, hasEndpoint), (from) => ({
      machine: refOf(from),
      ...pinned(from.pin),
    }))
  );

const others = (store: Store, found: MachineRow) =>
  Effect.map(store.machines, (rows) => {
    const onHost = rows.filter(
      (row): row is MachineRow & { readonly endpoint: Endpoint } =>
        row.host === found.host && row.name !== found.name && hasEndpoint(row)
    );

    return {
      machines: onHost.filter(mayHoldVm).map(refOf),
      taken: onHost.map(({ endpoint }) => endpoint.port),
    };
  });

const sourceStep = (store: Store, found: MachineRow, held: Setup | undefined) =>
  Effect.gen(function* () {
    const { source } = found;

    if (source.kind === "base") {
      if (!found.ephemeral) {
        return { _tag: "base", base: found.base } as const;
      }

      return held === undefined
        ? yield* new Unsendable({
            why: "its setup left with a restart of the control plane",
          })
        : ({ _tag: "base", base: found.base, setup: held } as const);
    }

    if (source.kind === "machine") {
      const from = copyOf(yield* store.findMachine(source.name));

      return from === undefined
        ? yield* new Unsendable({ why: `its source ${source.name} went` })
        : ({ _tag: "machine", ...from } as const);
    }

    const from = yield* store.findCheckpoint(source.name);

    return Option.isSome(from)
      ? ({
          _tag: "checkpoint",
          checkpoint: checkpointRefOf(from.value),
          ...pinned(from.value.pin),
        } as const)
      : yield* new Unsendable({ why: `its checkpoint ${source.name} went` });
  });

export interface Joining {
  readonly mint: Effect.Effect<Redacted.Redacted, Unsendable>;
  readonly mintBuild: Effect.Effect<Redacted.Redacted, Unsendable>;
  readonly keyed: boolean;
}

export const machineStep = (
  store: Store,
  found: MachineRow,
  op: Operation,
  held: Setup | undefined,
  authorizedKeys: string,
  joining: Joining,
  hookTimeoutSeconds: number
): Effect.Effect<Step, Internal | Unsendable> =>
  Effect.gen(function* () {
    const ref = refOf(found);
    const { name } = found;
    const { machines, taken } = yield* others(store, found);
    const hostname = `cbx-${name}`;

    const hook = found.ephemeral
      ? {}
      : { hook: { timeoutSeconds: hookTimeoutSeconds } };

    if (op.kind === "remove") {
      return {
        _tag: "remove",
        machine: identityOf(found),
        keep: yield* keptOn(store, found.host),
        ...hook,
      };
    }

    if (op.kind === "make") {
      return {
        _tag: "make",
        machine: ref,
        source: yield* sourceStep(store, found, held),
        ...(found.ephemeral || found.template !== undefined
          ? { authorizedKeys }
          : {}),
        ...(found.tailnet ? { tailnet: true } : {}),
        ...(found.ephemeral && found.tailnet
          ? { join: { hostname, key: yield* joining.mintBuild } }
          : {}),
        taken,
        machines,
      };
    }

    switch (op.kind) {
      case "start": {
        return {
          _tag: "start",
          machine: ref,
          keep: yield* keptOn(store, found.host),
          ...pinned(found.pin),
          machines,
        };
      }

      case "stop": {
        return {
          _tag: op.kind,
          machine: ref,
          ...pinned(found.pin),
          machines,
          ...hook,
        };
      }

      case "pause": {
        return {
          _tag: "pause",
          machine: ref,
          ...pinned(found.pin),
          ...hook,
        };
      }

      case "resize": {
        return { _tag: "resize", machine: ref, to: op.to ?? {}, machines };
      }

      case "join": {
        return {
          _tag: "join",
          machine: ref,
          hostname,
          ...(joining.keyed ? { key: yield* joining.mint } : {}),
        };
      }

      case "capture":
      case "deleteCheckpoint":
      case "publish":
      case "fetch": {
        return yield* new Unsendable({
          why: `a machine takes no ${op.kind} step`,
        });
      }
    }
  });

export const checkpointStep = (
  store: Store,
  record: CheckpointRow,
  op: Operation
): Effect.Effect<Step, Internal | Unsendable> =>
  Effect.gen(function* () {
    const checkpoint = checkpointRefOf(record);
    const { published, build } = record;

    if (op.kind === "deleteCheckpoint") {
      return {
        _tag: "deleteCheckpoint",
        checkpoint: identityOf(record),
        ...(isPublished(record) ? { unpublish: true } : {}),
      };
    }

    if (op.kind === "publish") {
      return { _tag: "publish", checkpoint };
    }

    if (op.kind === "fetch") {
      return published === undefined || build === undefined
        ? yield* new Unsendable({ why: "it names no published build" })
        : { _tag: "fetch", checkpoint, from: published, build };
    }

    const from = copyOf(yield* store.findMachine(record.machine));

    return from === undefined
      ? yield* new Unsendable({ why: `its machine ${record.machine} went` })
      : { _tag: "capture", checkpoint, ...from };
  });
