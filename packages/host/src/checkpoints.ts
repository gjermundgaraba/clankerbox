import {
  type Checkpoint,
  type Declared,
  formatId,
  type HostError,
  type Internal,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, Layer, type Scope } from "effect";
import { checkpointRef, claimsOn, detacher, machineRef, madeOn, rowsOn } from "./claims.ts";
import type { HostSettings } from "./settings.ts";
import { idOn, nameOn, newInstance } from "./ids.ts";
import { Runtime } from "./runtime.ts";
import { type CheckpointRecord, type NewCheckpoint, Store } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Checkpoint>, Internal>;
  readonly get: (id: string) => Effect.Effect<Checkpoint, Declared<"getCheckpoint">>;
  readonly capture: (
    machine: string,
    name: string,
  ) => Effect.Effect<Checkpoint, Declared<"captureCheckpoint">>;
  readonly delete: (id: string) => Effect.Effect<void, Declared<"deleteCheckpoint">>;
}

export class Checkpoints extends Context.Service<Checkpoints, Interface>()(
  "@clankerbox/host/Checkpoints",
) {}

export const make = (
  config: Pick<HostSettings, "id">,
): Effect.Effect<Interface, HostError, Store | Runtime | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const detached = yield* detacher;

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const rows = rowsOn(store, config.id);
    const made = madeOn(config.id);
    const { claimAndCheck, native, refusable, done } = claimsOn(store);

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

    const capture = (machineId: string, name: string) =>
      Effect.gen(function* () {
        const sourceName = yield* nameOf(machineId);
        const id = yield* formatId(config.id, name);

        const [token, { source, row }] = yield* claimAndCheck(
          store.hold("captureCheckpoint", { kind: "machine", name: sourceName }),
          (source, join) =>
            Effect.gen(function* () {
              yield* made(source);

              const kind = runtime.checkpointKind;

              const row: NewCheckpoint = {
                name,
                instance: newInstance(),
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

              yield* join({ kind: "checkpoint", record: row });

              return { source, row };
            }),
        );

        yield* refusable(
          token,
          `captureCheckpoint ${id}`,
          runtime.capture(machineRef(config.id, source), checkpointRef(config.id, row)),
        );
        yield* done(token);

        return resource(yield* rows.checkpoint(name));
      });

    const remove = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* claimAndCheck(
          store.hold("deleteCheckpoint", { kind: "checkpoint", name }),
          Effect.succeed,
        );

        yield* native(
          token,
          `deleteCheckpoint ${id}`,
          runtime.deleteCheckpoint(checkpointRef(config.id, record)),
        );
        yield* store.remove({ kind: "checkpoint", name });
      });

    return {
      list: Effect.map(store.checkpoints, (records) => records.map(resource)).pipe(
        Effect.withSpan("Checkpoints.list"),
      ),
      get: Effect.fn("Checkpoints.get")((id) =>
        Effect.flatMap(nameOf(id), (name) => Effect.map(rows.checkpoint(name), resource)),
      ),
      capture: Effect.fn("Checkpoints.capture")((machine, name) =>
        detached(`captureCheckpoint ${machine} to ${name}`, capture(machine, name)),
      ),
      delete: Effect.fn("Checkpoints.delete")((id) =>
        detached(`deleteCheckpoint ${id}`, remove(id)),
      ),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id">,
): Layer.Layer<Checkpoints, HostError, Store | Runtime> => Layer.effect(Checkpoints, make(config));
