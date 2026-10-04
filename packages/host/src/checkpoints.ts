/**
 * The checkpoint actions: capture, list, get and delete. They run in the order `actions.ts`
 * describes. A capture claims its source machine and inserts the checkpoint's row; restores,
 * which only read a ready checkpoint, are machine actions.
 */
import {
  type Checkpoint,
  Conflict,
  formatId,
  type HostError,
  NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, Layer, Option, type Scope } from "effect";
import {
  type Claim,
  checkpointRef,
  claimAndCheck,
  detacher,
  done,
  machineRef,
  nameOn,
  native,
  newInstance,
} from "./actions.ts";
import type { HostConfig } from "./config.ts";
import { Runtime } from "./runtime.ts";
import { type CheckpointRecord, type MachineRecord, type NewCheckpoint, Store } from "./store.ts";

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

/** What a capture holds: the new checkpoint and its source. */
interface Capturing {
  readonly checkpoint: CheckpointRecord;
  readonly source: MachineRecord;
}

export const make = (
  config: Pick<HostConfig, "id">,
): Effect.Effect<Interface, HostError, Store | Runtime | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const detached = yield* detacher;

    const idOf = (name: string) => `${config.id}_${name}`;
    const nameOf = nameOn(config.id);

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

    const find = (name: string) =>
      Effect.flatMap(
        store.findCheckpoint(name),
        Option.match({
          onNone: () => Effect.fail(new NotFound({ message: `no checkpoint ${idOf(name)}` })),
          onSome: Effect.succeed,
        }),
      );

    /** Inserts the checkpoint's row and claims its source; both end with the capture's outcome. */
    const claimCapture = (row: NewCheckpoint): Effect.Effect<Claim<Capturing>, HostError> =>
      Effect.map(store.insertCheckpoint(row), (before) => ({
        action: "capture",
        record: {
          checkpoint: { ...row, action: { name: "capture", status: "running" } },
          source: { ...before, action: { name: "capture", status: "running" } },
        },
        release: Effect.andThen(
          store.removeCheckpoint(row.name),
          store.record(row.machine, { action: before.action }),
        ),
        end: (outcome) =>
          Effect.andThen(
            store.recordCheckpoint(row.name, outcome),
            store.record(row.machine, { action: outcome }),
          ),
      }));

    /**
     * The kind follows the source's state, which the row records, so it is read before the
     * claim. The claim keeps every action of ours off the source, and step 3 reads it again: a
     * kind that changed between is refused.
     */
    const capture = (machineId: string, name: string) =>
      Effect.gen(function* () {
        const sourceName = yield* nameOf(machineId);
        const id = yield* formatId(config.id, name);

        const source = yield* Effect.flatMap(
          store.find(sourceName),
          Option.match({
            onNone: () => Effect.fail(new NotFound({ message: `no machine ${machineId}` })),
            onSome: Effect.succeed,
          }),
        );

        // Another action's machine can read as missing before its VM exists.
        if (source.action.status === "running") {
          return yield* new Conflict({
            message: `machine ${machineId} is busy: ${source.action.name} is running`,
            kind: "busy",
          });
        }

        const kind = yield* runtime.captureKind(machineRef(config.id, source));

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

        const [claimed] = yield* claimAndCheck(claimCapture(row), (held) =>
          Effect.flatMap(runtime.captureKind(machineRef(config.id, held.source)), (now) =>
            now === kind
              ? Effect.void
              : Effect.fail(
                  new Precondition({
                    message: `machine ${machineId} changed state as its capture began; capture it again`,
                  }),
                ),
          ),
        );

        yield* native(
          claimed,
          `capture ${id}`,
          runtime.capture(
            machineRef(config.id, claimed.record.source),
            checkpointRef(config.id, claimed.record.checkpoint),
          ),
        );
        yield* done(claimed);

        return resource(yield* find(name));
      });

    const remove = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [claimed] = yield* claimAndCheck(
          Effect.map(store.claimCheckpoint(name, "delete"), (before): Claim<CheckpointRecord> => ({
            action: "delete",
            record: { ...before, action: { name: "delete", status: "running" } },
            release: store.recordCheckpoint(name, before.action),
            end: (outcome) => store.recordCheckpoint(name, outcome),
          })),
          () => Effect.void,
        );

        yield* native(
          claimed,
          `delete ${id}`,
          runtime.deleteCheckpoint(checkpointRef(config.id, claimed.record)),
        );
        yield* store.removeCheckpoint(name);
      });

    return {
      list: Effect.map(store.checkpoints, (records) => records.map(resource)),
      get: (id) => Effect.flatMap(nameOf(id), (name) => Effect.map(find(name), resource)),
      capture: (machine, name) => detached(`capture ${machine} to ${name}`, capture(machine, name)),
      delete: (id) => detached(`delete ${id}`, remove(id)),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostConfig, "id">,
): Layer.Layer<Checkpoints, HostError, Store | Runtime> => Layer.effect(Checkpoints, make(config));
