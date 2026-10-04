/**
 * The checkpoint actions: capture, list, get and delete. They run in the order `actions.ts`
 * describes. A capture claims its source machine and inserts the checkpoint's row; restores,
 * which only read a ready checkpoint, are machine actions.
 */
import { type Checkpoint, formatId, type HostError } from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, Layer, type Scope } from "effect";
import { checkpointRef, claimsOn, detacher, machineRef, madeOn, rowsOn } from "./actions.ts";
import type { HostConfig } from "./config.ts";
import { idOn, nameOn, newInstance } from "./ids.ts";
import { Runtime } from "./runtime.ts";
import { type CheckpointRecord, type NewCheckpoint, Store } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Checkpoint>, HostError>;
  readonly get: (id: string) => Effect.Effect<Checkpoint, HostError>;
  /** Captures the machine `machine` into a new checkpoint named `name`. */
  readonly capture: (machine: string, name: string) => Effect.Effect<Checkpoint, HostError>;
  readonly delete: (id: string) => Effect.Effect<void, HostError>;
}

export class Checkpoints extends Context.Service<Checkpoints, Interface>()(
  "@clankerbox/host/Checkpoints",
) {}

export const make = (
  config: Pick<HostConfig, "id">,
): Effect.Effect<Interface, HostError, Store | Runtime | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const detached = yield* detacher;

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const rows = rowsOn(store, config.id);
    const made = madeOn(config.id);
    const { claimAndCheck, native, done } = claimsOn(store);

    const resource = (record: CheckpointRecord): Checkpoint => {
      const checkpoint: Checkpoint = {
        id: idOf(record.name),
        createdAt: record.createdAt,
        machine: idOf(record.machine),
        kind: record.kind,
        base: record.base,
        cpu: record.cpu,
        ramMib: record.ramMib,
        diskGib: record.diskGib,
        action: record.action,
      };

      return record.profile === undefined ? checkpoint : { ...checkpoint, profile: record.profile };
    };

    /**
     * Claims the source, then inserts the checkpoint's row, of the runtime's kind, into the same
     * claim. A host crash between the two leaves the source's capture failed and no checkpoint
     * row. The runtime refuses a source in a state it doesn't capture.
     */
    const capture = (machineId: string, name: string) =>
      Effect.gen(function* () {
        const sourceName = yield* nameOf(machineId);
        const id = yield* formatId(config.id, name);

        const [token, { source, row }] = yield* claimAndCheck(
          store.claim("capture", { hold: { table: "machines", name: sourceName } }),
          (source, join) =>
            Effect.gen(function* () {
              yield* made(source);

              const kind = runtime.checkpointKind;

              const row: NewCheckpoint = {
                name,
                instance: newInstance(),
                native: undefined,
                createdAt: yield* DateTime.now,
                machine: sourceName,
                kind,
                pin: kind === "ram" ? runtime.pin : undefined,
                port: source.port,
                base: source.base,
                profile: source.profile,
                cpu: source.cpu,
                ramMib: source.ramMib,
                diskGib: source.diskGib,
              };

              yield* join({ table: "checkpoints", record: row });

              return { source, row };
            }),
        );

        yield* native(
          token,
          `capture ${id}`,
          runtime.capture(machineRef(config.id, source), checkpointRef(config.id, row)),
        );
        yield* done(token);

        return resource(yield* rows.checkpoint(name));
      });

    const remove = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* claimAndCheck(
          store.claim("delete", { hold: { table: "checkpoints", name } }),
          Effect.succeed,
        );

        yield* native(
          token,
          `delete ${id}`,
          runtime.deleteCheckpoint(checkpointRef(config.id, record)),
        );
        yield* store.remove({ table: "checkpoints", name });
      });

    return {
      list: Effect.map(store.checkpoints, (records) => records.map(resource)),
      get: (id) =>
        Effect.flatMap(nameOf(id), (name) => Effect.map(rows.checkpoint(name), resource)),
      capture: (machine, name) => detached(`capture ${machine} to ${name}`, capture(machine, name)),
      delete: (id) => detached(`delete ${id}`, remove(id)),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostConfig, "id">,
): Layer.Layer<Checkpoints, HostError, Store | Runtime> => Layer.effect(Checkpoints, make(config));
