import type { MachineRef, Step } from "@clankerbox/host-contract";
import type { Internal, Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option } from "effect";

import type { CheckpointRow } from "./checkpoint-chart.ts";
import type { MachineRow } from "./machine-chart.ts";
import type { Operation, Interface as Store } from "./store.ts";

export const refOf = (row: MachineRow): MachineRef | undefined =>
  row.port === undefined
    ? undefined
    : {
        name: row.name,
        instance: row.instance,
        cpu: row.cpu,
        ramMib: row.ramMib,
        diskGib: row.diskGib,
        port: row.port,
      };

const checkpointRefOf = (record: CheckpointRow) => ({
  name: record.name,
  instance: record.instance,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  port: record.port,
});

const pinned = (pin: string | undefined) => (pin === undefined ? {} : { pin });

const copyOf = (found: Option.Option<MachineRow>) =>
  Option.getOrUndefined(
    Option.flatMapNullishOr(found, (from) => {
      const machine = refOf(from);

      return machine === undefined
        ? undefined
        : { machine, ...pinned(from.pin) };
    })
  );

const others = (store: Store, found: MachineRow) =>
  Effect.map(store.machines, (rows) => {
    const onHost = rows.filter(
      ({ host, name }) => host === found.host && name !== found.name
    );

    return {
      machines: onHost.flatMap((other) => {
        const ref = refOf(other);

        return ref === undefined ? [] : [ref];
      }),
      ports: onHost.flatMap(({ port }) => (port === undefined ? [] : [port])),
    };
  });

const sourceStep = (store: Store, found: MachineRow, held: Setup | undefined) =>
  Effect.gen(function* () {
    const { source } = found;

    if (source.kind === "base") {
      if (!source.scripted) {
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

const takesKeys = (found: MachineRow) =>
  found.source.kind === "base"
    ? found.source.scripted
    : found.template !== undefined;

/**
 * What a host is sent for a machine's operation, built afresh from the rows at each delivery, or
 * undefined when it can't be sent: its source went, or the setup `held` in memory did.
 */
export const machineStep = (
  store: Store,
  found: MachineRow,
  op: Operation,
  held: Setup | undefined,
  authorizedKeys: string
): Effect.Effect<Step | undefined, Internal> =>
  Effect.gen(function* () {
    const ref = refOf(found);
    const { name, instance } = found;
    const { machines, ports } = yield* others(store, found);

    if (op.kind === "remove") {
      return { _tag: "remove", machine: { name, instance } };
    }

    if (op.kind === "make") {
      const source = yield* sourceStep(store, found, held);

      return source === undefined
        ? undefined
        : {
            _tag: "make",
            machine: {
              name,
              instance,
              cpu: found.cpu,
              ramMib: found.ramMib,
              diskGib: found.diskGib,
            },
            source,
            ...(takesKeys(found) ? { authorizedKeys } : {}),
            ports,
            machines,
          };
    }

    if (ref === undefined) {
      return undefined;
    }

    switch (op.kind) {
      case "start": {
        return {
          _tag: "start",
          machine: ref,
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
        };
      }

      case "pause": {
        return { _tag: "pause", machine: ref, ...pinned(found.pin) };
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
    const { name, published, build } = record;

    if (op.kind === "deleteCheckpoint") {
      return {
        _tag: "deleteCheckpoint",
        checkpoint,
        ...(published === name ? { published } : {}),
      };
    }

    if (op.kind === "publish") {
      return { _tag: "publish", checkpoint, as: published ?? name };
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
