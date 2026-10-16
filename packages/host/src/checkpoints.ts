import {
  type Checkpoint,
  type Declared,
  formatId,
  type HostError,
  Internal,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, Exit, Fiber, Layer, type Scope } from "effect";
import { foundOn, idOn, nameOn, newInstance } from "./ids.ts";
import { Leases } from "./leases.ts";
import { checkpointRef, machineRef, madeOn } from "./refs.ts";
import { Runtime } from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { type CheckpointRecord, Store } from "./store.ts";

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
): Effect.Effect<Interface, HostError, Store | Runtime | Leases | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const leases = yield* Leases;
    const hostScope = yield* Effect.scope;

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const found = foundOn(config.id);
    const made = madeOn(config.id);

    const detached = <A, E>(what: string, work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.flatMap(
        Effect.forkIn(
          Effect.tapError(work, (error) => Effect.logWarning(`${what} failed: ${String(error)}`)),
          hostScope,
        ),
        Fiber.join,
      );

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
      };

      return record.profile === undefined ? checkpoint : { ...checkpoint, profile: record.profile };
    };

    const capturing = (source: string, name: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* leases.share("machine", source);
          yield* leases.own("checkpoint", name);

          const intent = yield* found("machine", source, store.findMachine(source));

          yield* made(intent);

          const left = (yield* store.unready).find((record) => record.name === name);

          if (left !== undefined) {
            yield* discarded(left);
          }

          const kind = runtime.checkpointKind;

          const record: CheckpointRecord = {
            name,
            instance: newInstance(),
            createdAt: yield* DateTime.now,
            machine: source,
            kind,
            pin: kind === "ram" ? runtime.pin : undefined,
            port: intent.port,
            base: intent.base,
            profile: intent.profile,
            cpu: intent.cpu,
            ramMib: intent.ramMib,
            diskGib: intent.diskGib,
          };

          yield* store.beginCheckpoint(record);

          yield* runtime
            .capture(machineRef(config.id, intent), checkpointRef(config.id, record))
            .pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : Effect.ignore(discarded(record)),
              ),
            );

          yield* store.readyCheckpoint(name);

          return resource(record);
        }),
      );

    const discarded = (record: CheckpointRecord) =>
      Effect.andThen(
        runtime.deleteCheckpoint(checkpointRef(config.id, record)),
        store.removeCheckpoint(record.name),
      );

    const remove = (name: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* leases.own("checkpoint", name);

          const record = yield* found("checkpoint", name, store.anyCheckpoint(name));

          yield* store.retireCheckpoint(name);
          yield* discarded(record);
        }),
      );

    return {
      list: Effect.map(store.checkpoints, (records) => records.map(resource)).pipe(
        Effect.withSpan("Checkpoints.list"),
      ),
      get: Effect.fn("Checkpoints.get")((id) =>
        Effect.flatMap(nameOf(id), (name) =>
          Effect.map(found("checkpoint", name, store.findCheckpoint(name)), resource),
        ),
      ),
      capture: Effect.fn("Checkpoints.capture")((machine, name) =>
        Effect.gen(function* () {
          const source = yield* nameOf(machine);

          yield* formatId(config.id, name);

          return yield* detached(
            `captureCheckpoint ${machine} to ${name}`,
            capturing(source, name),
          );
        }),
      ),
      delete: Effect.fn("Checkpoints.delete")((id) =>
        Effect.flatMap(nameOf(id), (name) => detached(`deleteCheckpoint ${id}`, remove(name))),
      ),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id">,
): Layer.Layer<Checkpoints, HostError, Store | Runtime | Leases> =>
  Layer.effect(Checkpoints, make(config));
