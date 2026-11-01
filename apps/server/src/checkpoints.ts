import type { Report } from "@clankerbox/host-contract";
import {
  checkpointKinds,
  Conflict,
  Internal,
  NotFound,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Build,
  Checkpoint,
  Declared,
  PrebuildRequest,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Cause,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
} from "effect";
import type { Duration, Scope } from "effect";

import { applied } from "./chart.ts";
import { activityOf, checkpointChart, phaseOf } from "./checkpoint-chart.ts";
import type { CheckpointEvent, CheckpointRow } from "./checkpoint-chart.ts";
import { driver, untilRest } from "./driver.ts";
import type { Heard } from "./driver.ts";
import { answering, Hosts } from "./hosts.ts";
import { stageOf } from "./machine-chart.ts";
import { Machines, unmade } from "./machines.ts";
import { collect, cutShort, poll } from "./operations.ts";
import { placing } from "./placement.ts";
import { builderName, nameOf } from "./prebuilds.ts";
import { checkpointStep } from "./steps.ts";
import { newId, notFound, Store } from "./store.ts";
import type { Operation } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<readonly Checkpoint[], Internal>;
  readonly get: (
    id: string
  ) => Effect.Effect<Checkpoint, Declared<"getCheckpoint">>;
  /**
   * Records a capture and answers at once. A checkpoint has no `waiting`, unlike a machine: a
   * capture on a dead host reads `capturing`, so a client's wait polls until its `--timeout`, and
   * without one for as long as the host stays dead.
   */
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

const shown = (record: CheckpointRow): Checkpoint => ({
  id: record.name,
  createdAt: record.createdAt,
  machine: record.machine,
  kind: checkpointKinds[record.kind],
  base: record.base,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  phase: phaseOf(record.state),
  ...(record.profile === undefined ? {} : { profile: record.profile }),
  ...(record.error === undefined ? {} : { error: record.error }),
});

const reportedBy = (
  op: Operation,
  { status, outcome, error }: Report,
  at: DateTime.Utc
): CheckpointEvent =>
  status === "failed" || status === "cancelled"
    ? {
        type: "reported",
        status,
        error: error ?? cutShort(op),
        at,
        cleared: outcome.cleared === true,
      }
    : { type: "reported", status: "done", at };

export const make = (settings: {
  readonly recheck: Duration.Duration;
}): Effect.Effect<
  Interface,
  Internal,
  Store | Hosts | Machines | Scope.Scope
> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const hosts = yield* Hosts;
    const machines = yield* Machines;
    const scope = yield* Effect.scope;

    const builds = new Map<string, Build>();

    const row = (name: string) =>
      Effect.flatMap(store.findCheckpoint(name), (found) =>
        Effect.fromOption(found, () => notFound("checkpoint", name))
      );

    const applying = (name: string, event: CheckpointEvent) =>
      store.advance("checkpoint", name, (found, op) =>
        applied(checkpointChart, found, event, op)
      );

    const lostWhy = (record: CheckpointRow, op: Operation, why: string) =>
      Effect.map(store.findMachine(record.machine), (source) =>
        op.kind === "capture" && Option.isNone(source)
          ? notFound("machine", record.machine)
          : new Internal({
              message: `the ${op.kind} of checkpoint ${record.name} ended before its host reported it: ${why}`,
            })
      );

    const following = (record: CheckpointRow, op: Operation, heard: Heard) =>
      Effect.gen(function* () {
        if (heard.at === "running") {
          return;
        }

        yield* applying(
          record.name,
          heard.at === "ended"
            ? reportedBy(op, heard.report, yield* DateTime.now)
            : { type: "lost", error: yield* lostWhy(record, op, heard.why) }
        );
        yield* collect(hosts, op);
      });

    const drive = yield* driver(settings.recheck, {
      kind: "checkpoint",
      find: store.findCheckpoint,
      operationOn: store.operationOn,
      activityOf,
      looking: (record) =>
        Effect.flatMap(hosts.read(record.host), ({ boot }) =>
          applying(record.name, { type: "read", boot, id: newId() })
        ),
      polling: (record, op) =>
        poll(hosts, op, {
          cut: false,
          step: checkpointStep(store, record, op),
        }),
      following,
    });

    const capturing = (source: string, name: string) =>
      Effect.gen(function* () {
        const present = yield* store.findMachine(source);

        if (Option.isNone(present)) {
          return yield* notFound("machine", source);
        }

        const machine = present.value;

        if (stageOf(machine.state) !== "made" || machine.port === undefined) {
          return yield* unmade(machine);
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
          state: "capturing.due",
          error: undefined,
          failedAt: undefined,
        };

        yield* store.insertCheckpoint(record);
        yield* drive(name);

        return shown(record);
      });

    const remove = (name: string) =>
      Effect.flatMap(applying(name, { type: "delete" }), (answer) =>
        answer.at === "absent"
          ? Effect.fail(notFound("checkpoint", name))
          : drive(name)
      );

    const rests = (name: string) =>
      Effect.gen(function* () {
        const found = yield* store.findCheckpoint(name);

        if (Option.isNone(found)) {
          return true;
        }

        const { error, host, state } = found.value;

        if (error !== undefined) {
          return yield* error;
        }

        if (activityOf(state) === "none") {
          return true;
        }

        yield* answering(hosts, host);

        return false;
      });

    const rested = (name: string) => untilRest(settings.recheck, rests(name));

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
          yield* rested(name);
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
        const [host] = yield* Effect.fromResult(
          placing(yield* hosts.reachAll, request.base)
        );

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
      yield* drive(record.name);
    }

    return {
      list: Effect.map(store.checkpoints, (records) =>
        records.flatMap((record) =>
          record.state === "ready" ? [shown(record)] : []
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
}): Layer.Layer<Checkpoints, Internal, Store | Hosts | Machines> =>
  Layer.effect(Checkpoints, make(settings));
