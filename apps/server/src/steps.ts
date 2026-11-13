import type {
  CheckpointRef,
  Endpoint,
  MachineRef,
  Ref,
  Step,
} from "@clankerbox/host-contract";
import type { Internal, Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option } from "effect";

import { isPublished } from "./checkpoint-chart.ts";
import type { CheckpointRow } from "./checkpoint-chart.ts";
import { stageOf } from "./machine-chart.ts";
import type { MachineRow } from "./machine-chart.ts";
import type { Operation, Interface as Store } from "./store.ts";

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
  ...(row.endpoint === undefined ? {} : { endpoint: row.endpoint }),
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

/** Whether a row's VM may be on its host, so its host counts it: a make reached it, and no undo has ended it. */
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
        ? undefined
        : ({ _tag: "base", base: found.base, setup: held } as const);
    }

    if (source.kind === "machine") {
      const from = copyOf(yield* store.findMachine(source.name));

      return from === undefined
        ? undefined
        : ({ _tag: "machine", ...from } as const);
    }

    const from = yield* store.findCheckpoint(source.name);

    return Option.isSome(from)
      ? ({
          _tag: "checkpoint",
          checkpoint: checkpointRefOf(from.value),
          ...pinned(from.value.pin),
        } as const)
      : undefined;
  });

const hooked = (found: MachineRow, timeoutSeconds: number) =>
  found.ephemeral ? {} : { hook: { timeoutSeconds } };

/**
 * What a host is sent for a machine's operation, built afresh from the rows at each delivery, or
 * undefined when it can't be sent: its source went, or the setup `held` in memory for a template's
 * builder did. The keys go to a builder, so its build holds them, and to a clone of a build, which adds
 * any it lacks. A builder on a host that `joins` joins the tailnet for its setup. A stop, a pause and
 * every remove ask the host to run the guest's hook first, for at most `hookTimeoutSeconds`, but a
 * builder's: a build may stop its builder before the copy, so a stop hook's effects would land in
 * every clone, and a builder's delete has no user work to finish.
 */
export const machineStep = (
  store: Store,
  found: MachineRow,
  op: Operation,
  held: Setup | undefined,
  authorizedKeys: string,
  joins: boolean,
  hookTimeoutSeconds: number
): Effect.Effect<Step | undefined, Internal> =>
  Effect.gen(function* () {
    const ref = refOf(found);
    const { name } = found;
    const { machines, taken } = yield* others(store, found);

    if (op.kind === "remove") {
      return {
        _tag: "remove",
        machine: identityOf(found),
        keep: yield* keptOn(store, found.host),
        ...hooked(found, hookTimeoutSeconds),
      };
    }

    if (op.kind === "make") {
      const source = yield* sourceStep(store, found, held);

      return source === undefined
        ? undefined
        : {
            _tag: "make",
            machine: ref,
            source,
            ...(found.ephemeral || found.template !== undefined
              ? { authorizedKeys }
              : {}),
            ...(found.ephemeral && joins
              ? { join: { hostname: `cbx-${name}` } }
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
          ...hooked(found, hookTimeoutSeconds),
        };
      }

      case "pause": {
        return {
          _tag: "pause",
          machine: ref,
          ...pinned(found.pin),
          ...hooked(found, hookTimeoutSeconds),
        };
      }

      case "resize": {
        return { _tag: "resize", machine: ref, to: op.to ?? {}, machines };
      }

      case "join": {
        return { _tag: "join", machine: ref, hostname: `cbx-${name}` };
      }

      case "capture":
      case "deleteCheckpoint":
      case "publish":
      case "fetch": {
        return undefined;
      }
    }
  });

/**
 * What a host is sent for a checkpoint's operation, or undefined when its machine went. A delete of
 * the copy a build was published from also removes it from the build store.
 */
export const checkpointStep = (
  store: Store,
  record: CheckpointRow,
  op: Operation
): Effect.Effect<Step | undefined, Internal> =>
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
        ? undefined
        : { _tag: "fetch", checkpoint, from: published, build };
    }

    const from = copyOf(yield* store.findMachine(record.machine));

    return from === undefined
      ? undefined
      : { _tag: "capture", checkpoint, ...from };
  });
