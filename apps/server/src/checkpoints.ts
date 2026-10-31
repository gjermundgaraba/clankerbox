import type { Step } from "@clankerbox/host-contract";
import {
  checkpointKinds,
  Conflict,
  Internal,
  NotFound,
  NotMade,
  NotOffered,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Build,
  Checkpoint,
  Declared,
  HostError,
  PrebuildRequest,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
} from "effect";
import type { Scope } from "effect";
import { Hex } from "effect/encoding";

import { Hosts } from "./hosts.ts";
import { stageOf } from "./machine-chart.ts";
import { Machines } from "./machines.ts";
import { Operations } from "./operations.ts";
import { placing } from "./placement.ts";
import { builderName, nameOf } from "./prebuilds.ts";
import { Store } from "./store.ts";
import type { CheckpointRow, Finish, Operation } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<readonly Checkpoint[], Internal>;
  readonly get: (
    id: string
  ) => Effect.Effect<Checkpoint, Declared<"getCheckpoint">>;
  readonly capture: (
    machine: string,
    name: string
  ) => Effect.Effect<Checkpoint, Declared<"captureCheckpoint">>;
  readonly delete: (
    id: string
  ) => Effect.Effect<void, Declared<"deleteCheckpoint">>;
  readonly prebuild: (
    request: PrebuildRequest
  ) => Effect.Effect<Build, Declared<"prebuildCheckpoint">>;
  readonly build: (id: string) => Effect.Effect<Build, Declared<"getPrebuild">>;
}

export class Checkpoints extends Context.Service<Checkpoints, Interface>()(
  "@clankerbox/server/Checkpoints"
) {}

const retryWait = Duration.millis(100);

const restPoll = Duration.millis(100);

const newId = (): string =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));

const notFound = (name: string): NotFound =>
  new NotFound({ message: `no checkpoint ${name}`, id: name });

const noMachine = (name: string): NotFound =>
  new NotFound({ message: `no machine ${name}`, id: name });

const shown = (record: CheckpointRow): Checkpoint => ({
  id: record.name,
  createdAt: record.createdAt,
  machine: record.machine,
  kind: checkpointKinds[record.kind],
  base: record.base,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  phase: record.phase === "discarding" ? "failed" : record.phase,
  ...(record.profile === undefined ? {} : { profile: record.profile }),
  ...(record.error === undefined ? {} : { error: record.error }),
});

const refOf = (record: CheckpointRow) => ({
  name: record.name,
  instance: record.instance,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  port: record.port,
});

const failed = (error: HostError) =>
  Effect.map(DateTime.now, (failedAt): Finish => ({
    row: "checkpoint",
    patch: { phase: "failed", error, failedAt },
  }));

export const make = (settings: {
  readonly recheck: Duration.Duration;
}): Effect.Effect<
  Interface,
  Internal,
  Store | Hosts | Operations | Machines | Scope.Scope
> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const hosts = yield* Hosts;
    const operations = yield* Operations;
    const machines = yield* Machines;
    const scope = yield* Effect.scope;

    const builds = new Map<string, Build>();
    const driven = new Set<string>();
    const asked = new Set<string>();

    const row = (name: string) =>
      Effect.flatMap(store.findCheckpoint(name), (found) =>
        Effect.fromOption(found, () => notFound(name))
      );

    const stepOf = (
      record: CheckpointRow,
      op: Operation
    ): Effect.Effect<Step | undefined, Internal> =>
      Effect.gen(function* () {
        if (op.kind === "deleteCheckpoint") {
          return { _tag: "deleteCheckpoint", checkpoint: refOf(record) };
        }

        const source = yield* store.findMachine(record.machine);

        if (Option.isNone(source) || source.value.port === undefined) {
          return undefined;
        }

        const { name, instance, cpu, ramMib, diskGib, port, pin } =
          source.value;

        return {
          _tag: "capture",
          machine: { name, instance, cpu, ramMib, diskGib, port },
          checkpoint: refOf(record),
          ...(pin === undefined ? {} : { pin }),
        };
      });

    const begin = (record: CheckpointRow, kind: Operation["kind"]) =>
      Effect.gen(function* () {
        const info = yield* hosts.read(record.host);

        const begun = yield* store.begin({
          id: newId(),
          kind,
          resource: "checkpoint",
          name: record.name,
          host: record.host,
          boot: info.boot,
          seen: "unknown",
          to: undefined,
          leases:
            kind === "capture"
              ? [
                  {
                    resource: "machine",
                    name: record.machine,
                    mode: "share",
                  },
                  { resource: "checkpoint", name: record.name, mode: "own" },
                ]
              : [{ resource: "checkpoint", name: record.name, mode: "own" }],
        });

        if (Option.isNone(begun)) {
          yield* Effect.sleep(retryWait);
        }
      }).pipe(
        Effect.catchTag("Unreachable", (error) =>
          Effect.andThen(
            Effect.logWarning(error.message),
            Effect.sleep(settings.recheck)
          )
        )
      );

    const settle = (
      name: string,
      op: Operation,
      error: HostError | undefined
    ): Effect.Effect<Finish, Internal> =>
      Effect.gen(function* () {
        if (op.kind === "capture") {
          return {
            row: "checkpoint",
            from: "capturing",
            patch:
              error === undefined
                ? { phase: "ready", error: undefined }
                : { phase: "discarding", error },
          };
        }

        const latest = Option.getOrUndefined(yield* store.findCheckpoint(name));

        const discarded =
          latest?.phase === "discarding" ? latest.error : undefined;

        if (error !== undefined) {
          return discarded === undefined
            ? { row: "checkpoint", patch: { error } }
            : { row: "kept" };
        }

        return discarded === undefined
          ? { row: "checkpoint-removed" }
          : yield* failed(discarded);
      });

    const lostWhy = (record: CheckpointRow, op: Operation) =>
      Effect.map(store.findMachine(record.machine), (source) =>
        op.kind === "capture" && Option.isNone(source)
          ? noMachine(record.machine)
          : new Internal({
              message: `the ${op.kind} of checkpoint ${record.name} ended before its host reported it`,
            })
      );

    const work = (name: string) =>
      Effect.gen(function* () {
        for (;;) {
          const present = yield* store.findCheckpoint(name);

          if (Option.isNone(present)) {
            return;
          }

          const record = present.value;
          const inFlight = yield* store.operationOn("checkpoint", name);

          if (Option.isNone(inFlight)) {
            if (record.phase === "capturing") {
              yield* begin(record, "capture");
            } else if (
              record.phase === "deleting" ||
              record.phase === "discarding"
            ) {
              yield* begin(record, "deleteCheckpoint");
            } else {
              return;
            }

            continue;
          }

          const op = inFlight.value;

          const polled = yield* operations.poll(op, {
            cut: false,
            step: stepOf(record, op),
          });

          switch (polled.at) {
            case "ended": {
              yield* operations.finish(
                op,
                yield* settle(name, op, polled.report.error)
              );
              yield* Effect.forEach(
                op.leases.filter((lease) => lease.resource === "machine"),
                (lease) => machines.wake(lease.name),
                { discard: true }
              );

              if (polled.report.error !== undefined && op.kind !== "capture") {
                yield* Effect.sleep(settings.recheck);
              }

              break;
            }

            case "lost": {
              yield* operations.finish(
                op,
                yield* settle(name, op, yield* lostWhy(record, op))
              );
              break;
            }

            case "unreachable": {
              yield* Effect.sleep(settings.recheck);
              break;
            }

            case "running": {
              break;
            }
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `checkpoint ${name}'s work failed, and runs again at the next start:\n${Cause.pretty(cause)}`
          )
        )
      );

    const drive = (name: string) =>
      work(name).pipe(
        Effect.repeat({
          while: () => {
            if (asked.delete(name)) {
              return true;
            }

            driven.delete(name);

            return false;
          },
        })
      );

    const driving = (name: string) =>
      Effect.suspend(() => {
        if (driven.has(name)) {
          asked.add(name);

          return Effect.void;
        }

        driven.add(name);

        return Effect.asVoid(Effect.forkIn(drive(name), scope));
      });

    const capturing = (source: string, name: string) =>
      Effect.gen(function* () {
        const present = yield* store.findMachine(source);

        if (Option.isNone(present) || present.value.state === "undone") {
          return yield* noMachine(source);
        }

        const machine = present.value;
        const stage = stageOf(machine.state);

        if (
          (stage !== "made" && stage !== "deleting") ||
          machine.port === undefined
        ) {
          return yield* new NotMade({
            message: `machine ${source} isn't made yet: its create or setup still runs`,
            machine: source,
          });
        }

        const record: CheckpointRow = {
          name,
          instance: newId(),
          createdAt: yield* DateTime.now,
          machine: source,
          host: machine.host,
          kind: machine.kind,
          pin: machine.pin,
          port: machine.port,
          base: machine.base,
          profile: machine.profile,
          cpu: machine.cpu,
          ramMib: machine.ramMib,
          diskGib: machine.diskGib,
          phase: "capturing",
          error: undefined,
          failedAt: undefined,
        };

        yield* store.insertCheckpoint(record);
        yield* driving(name);

        return shown(record);
      });

    const remove = (name: string) =>
      Effect.gen(function* () {
        const record = yield* row(name);

        if (record.phase === "failed") {
          return yield* store.removeCheckpoint(name);
        }

        yield* store.patchCheckpoint(name, {
          phase: "deleting",
          error: undefined,
        });
        yield* driving(name);
      });

    const rested = (name: string) =>
      Effect.gen(function* () {
        for (;;) {
          const found = yield* store.findCheckpoint(name);

          if (
            Option.isNone(found) ||
            found.value.phase === "ready" ||
            found.value.phase === "failed"
          ) {
            return found;
          }

          if (found.value.error !== undefined) {
            return yield* found.value.error;
          }

          yield* Effect.sleep(restPoll);
        }
      });

    const building = (name: string, request: PrebuildRequest, host: string) =>
      Effect.gen(function* () {
        const builder = builderName();

        const deleted = machines.delete(builder).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catch((error) =>
            Effect.logWarning(
              `couldn't delete prebuild ${name}'s builder ${builder}: ${error.message}`
            )
          )
        );

        const atRest = Effect.gen(function* () {
          const resting = yield* machines.rest(builder);

          if (Option.isNone(resting)) {
            return yield* new Internal({
              message: `prebuild ${name}'s builder went before its setup ended`,
            });
          }

          if (resting.value.error !== undefined) {
            return yield* resting.value.error;
          }

          return resting.value;
        });

        yield* Effect.gen(function* () {
          yield* machines.build(builder, request, host);

          const made = yield* atRest;

          if (checkpointKinds[made.kind] === "disk") {
            yield* machines.stop(builder);
            yield* atRest;
          }

          const stale = yield* store.findCheckpoint(name);

          if (Option.isSome(stale)) {
            yield* remove(name);
            yield* rested(name);
          }

          yield* capturing(builder, name);

          const captured = yield* rested(name);

          if (Option.isSome(captured) && captured.value.error !== undefined) {
            return yield* captured.value.error;
          }
        }).pipe(Effect.ensuring(deleted));

        builds.set(name, { id: name, phase: "built" });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.findError(cause);

            builds.set(name, {
              id: name,
              phase: "failed",
              error: Result.isSuccess(error)
                ? error.success
                : new Internal({ message: Cause.pretty(cause) }),
            });
          })
        )
      );

    const prebuild = (request: PrebuildRequest) =>
      Effect.gen(function* () {
        const placed = placing(yield* hosts.reachAll, request.base);
        const [host] = placed.hosts;

        if (host === undefined) {
          const message = `no host offers base ${request.base}: ${placed.misses.join("; ")}`;

          return yield* placed.noReply
            ? new Unavailable({ message, readOnly: true })
            : new NotOffered({ message, base: request.base });
        }

        const name = yield* nameOf(request, host);

        if (builds.get(name)?.phase === "building") {
          return yield* new Conflict({
            message: `prebuild ${name} is already building`,
            id: name,
          });
        }

        const build: Build = { id: name, phase: "building" };

        builds.set(name, build);
        yield* Effect.forkIn(building(name, request, host.id), scope);

        return build;
      });

    for (const record of yield* store.checkpoints) {
      if (record.phase !== "ready" && record.phase !== "failed") {
        yield* driving(record.name);
      }
    }

    return {
      list: Effect.map(store.checkpoints, (records) =>
        records.flatMap((record) =>
          record.phase === "ready" ? [shown(record)] : []
        )
      ).pipe(Effect.withSpan("Checkpoints.list")),
      get: Effect.fn("Checkpoints.get")((id) => Effect.map(row(id), shown)),
      capture: Effect.fn("Checkpoints.capture")(capturing),
      delete: Effect.fn("Checkpoints.delete")(remove),
      prebuild: Effect.fn("Checkpoints.prebuild")(prebuild),
      build: Effect.fn("Checkpoints.build")((id) =>
        Effect.suspend(() => {
          const build = builds.get(id);

          return build === undefined
            ? Effect.fail(
                new NotFound({
                  message: `no prebuild ${id} is building: it ended with a restart of the control plane, or never began`,
                  id,
                })
              )
            : Effect.succeed(build);
        })
      ),
    } satisfies Interface;
  });

export const layer = (settings: {
  readonly recheck: Duration.Duration;
}): Layer.Layer<Checkpoints, Internal, Store | Hosts | Operations | Machines> =>
  Layer.effect(Checkpoints, make(settings));
