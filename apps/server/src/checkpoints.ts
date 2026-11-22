import type { Report } from "@clankerbox/host-contract";
import {
  newId,
  stopsBeforeCapture,
  pinRefusal,
} from "@clankerbox/host-contract/traits";
import {
  buildCopyName,
  isResting,
  labelledWith,
  readTimeout,
  Unavailable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  CaptureRequest,
  Checkpoint,
  Declared,
  HostError,
  ListFilter,
  Machine,
  StopRequest,
  Conflict,
  Internal,
} from "@gjermundgaraba/clankerbox-sdk";
import { Cause, Context, DateTime, Effect, Layer, Option } from "effect";
import type { Scope, Duration } from "effect";

import { applied } from "./chart.ts";
import {
  activityOf,
  checkpointChart,
  fromBuild,
  phaseOf,
} from "./checkpoint-chart.ts";
import type { CheckpointEvent, CheckpointRow } from "./checkpoint-chart.ts";
import { uncopiable } from "./copies.ts";
import { apart, driver, untilRest } from "./driver.ts";
import type { Heard } from "./driver.ts";
import { answering, Hosts } from "./hosts.ts";
import { phaseOf as machinePhaseOf, stageOf } from "./machine-chart.ts";
import type { MachineRow } from "./machine-chart.ts";
import { stateOf } from "./machine-view.ts";
import { madeMachine, Machines } from "./machines.ts";
import { collect, cutShort, poll, unreported } from "./operations.ts";
import { checkpointStep } from "./steps.ts";
import { notFound, readUntil, Store } from "./store.ts";
import type { Operation } from "./store.ts";

export interface Interface {
  readonly list: (
    filter: ListFilter
  ) => Effect.Effect<readonly Checkpoint[], Internal>;
  readonly get: (
    id: string
  ) => Effect.Effect<Checkpoint, Declared<"getCheckpoint">>;
  readonly capture: (
    request: CaptureRequest
  ) => Effect.Effect<Checkpoint, Declared<"captureCheckpoint">>;
  readonly stop: (
    request: StopRequest
  ) => Effect.Effect<Machine, Declared<"stopMachine">>;
  readonly delete: (
    id: string
  ) => Effect.Effect<void, Declared<"deleteCheckpoint">>;
  readonly copy: (
    machine: string,
    build: string
  ) => Effect.Effect<string, HostError>;
  readonly publish: (name: string) => Effect.Effect<void, HostError>;
  readonly fetch: (
    published: CheckpointRow,
    host: string
  ) => Effect.Effect<void, Conflict | Internal>;
  readonly discard: (name: string) => Effect.Effect<void, Internal>;
}

export class Checkpoints extends Context.Service<Checkpoints, Interface>()(
  "@clankerbox/server/Checkpoints"
) {}

const shown = (record: CheckpointRow): Checkpoint => ({
  id: record.name,
  createdAt: record.createdAt,
  machine: record.machine,
  base: record.base,
  cpu: record.cpu,
  ramMib: record.ramMib,
  diskGib: record.diskGib,
  phase: phaseOf(record.state),
  ...(record.labels === undefined ? {} : { labels: record.labels }),
  ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  ...(record.error === undefined ? {} : { error: record.error }),
});

const awaits = (name: string, machine: Option.Option<MachineRow>): boolean =>
  Option.exists(
    machine,
    (found) => !isResting(machinePhaseOf(found.state)) && found.after !== name
  );

const expired = (record: CheckpointRow, now: DateTime.Utc): boolean =>
  record.state === "ready" &&
  record.expiresAt !== undefined &&
  DateTime.toEpochMillis(record.expiresAt) < DateTime.toEpochMillis(now);

const reportedBy = (
  op: Operation,
  { status, outcome, error }: Report,
  at: DateTime.Utc
): CheckpointEvent => {
  const made = outcome.handle === undefined ? {} : { handle: outcome.handle };

  return status === "failed" || status === "cancelled"
    ? {
        type: "reported",
        status,
        error: error ?? cutShort(op),
        at,
        cleared: outcome.cleared === true,
        ...made,
      }
    : { type: "reported", status: "done", at, ...made };
};

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

    const row = (name: string) =>
      Effect.flatMap(store.findCheckpoint(name), (found) =>
        Effect.fromOption(
          Option.filter(found, (record) => !fromBuild(record)),
          () => notFound("checkpoint", name)
        )
      );

    const applying = (name: string, event: CheckpointEvent) =>
      store.advance("checkpoint", name, (found, op) =>
        applied(checkpointChart, found, event, op)
      );

    const lostWhy = (record: CheckpointRow, op: Operation, why: string) =>
      Effect.map(store.findMachine(record.machine), (source) =>
        op.kind === "capture" && Option.isNone(source)
          ? notFound("machine", record.machine)
          : unreported(op, why)
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

    const { drive } = yield* driver(settings.recheck, {
      kind: "checkpoint",
      find: store.findCheckpoint,
      store,
      activityOf,
      looking: (record) =>
        Effect.gen(function* () {
          const { boot } = yield* hosts.read(record.host);

          return yield* applying(record.name, {
            type: "read",
            boot,
            id: newId(),
            awaiting:
              record.state === "capturing.due" &&
              awaits(record.name, yield* store.findMachine(record.machine)),
          });
        }),
      polling: (record, op) =>
        poll(hosts, op, {
          cut: false,
          step: checkpointStep(store, record, op),
        }),
      following,
    });

    const driveOnRest = (name: string, machine: string) => {
      const rests = (found: Option.Option<MachineRow>) => !awaits(name, found);

      return readUntil(
        store,
        "machine",
        machine,
        store.findMachine(machine),
        rests
      ).pipe(
        Effect.andThen(drive(name)),
        Effect.catch(({ message }) =>
          Effect.logError(
            `checkpoint ${name} couldn't wait for machine ${machine} to rest, so the next recheck drives it: ${message}`
          )
        ),
        apart({ checkpoint: name }),
        Effect.forkIn(scope),
        Effect.asVoid
      );
    };

    const recorded = (
      { machine: source, name, labels, expiresAt }: CaptureRequest,
      build?: string
    ) =>
      Effect.gen(function* () {
        const machine = yield* madeMachine(store, source);

        const record: CheckpointRow = {
          name,
          instance: newId(),
          createdAt: yield* DateTime.now,
          machine: source,
          host: machine.host,
          runtime: machine.runtime,
          pin: machine.pin,
          handle: undefined,
          base: machine.base,
          cpu: machine.cpu,
          ramMib: machine.ramMib,
          diskGib: machine.diskGib,
          labels,
          state: "capturing.due",
          error: undefined,
          failedAt: undefined,
          expiresAt,
          build,
          published: undefined,
          tailnet: machine.tailnet,
        };

        yield* store.insertCheckpoint(record);

        return record;
      });

    const driven = (record: CheckpointRow) =>
      Effect.andThen(
        drive(record.name),
        driveOnRest(record.name, record.machine)
      );

    const capturing = (request: CaptureRequest, build?: string) =>
      Effect.gen(function* () {
        const record = yield* recorded(request, build);

        yield* driven(record);

        return shown(record);
      });

    const remove = (name: string) =>
      Effect.flatMap(applying(name, { type: "delete" }), (answer) =>
        answer.at === "absent"
          ? Effect.fail(notFound("checkpoint", name))
          : drive(name)
      );

    const discarded = ({ name, instance }: CheckpointRow) =>
      store
        .advance("checkpoint", name, (found, op) =>
          found.instance === instance
            ? applied(checkpointChart, found, { type: "delete" }, op)
            : { next: found, finish: false }
        )
        .pipe(
          Effect.andThen(drive(name)),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `couldn't discard checkpoint ${name}, whose stop was refused, so it stays a capture of its own, which runs now or at the next start of the control plane: ${Cause.pretty(cause)}`
            )
          )
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

    const rested = (name: string) =>
      untilRest(store, "checkpoint", name, settings.recheck, rests(name));

    const begun = (name: string) =>
      readUntil(
        store,
        "checkpoint",
        name,
        Effect.gen(function* () {
          const record = yield* store.findCheckpoint(name);

          return (
            Option.isNone(record) ||
            record.value.state !== "capturing.due" ||
            Option.isSome(yield* store.operationOn("checkpoint", name))
          );
        }),
        (has) => has
      ).pipe(Effect.timeoutOption(readTimeout), Effect.asVoid);

    const asked = (request: CaptureRequest) =>
      Effect.gen(function* () {
        const present = yield* store.findMachine(request.machine);

        if (Option.isSome(present) && stageOf(present.value.state) === "made") {
          const found = present.value;

          const [seen, info] = yield* Effect.all(
            [stateOf(hosts, found), Effect.option(hosts.read(found.host))],
            { concurrency: "unbounded" }
          );

          const refusal = Option.match(info, {
            onNone: () => undefined,
            onSome: ({ traits, pin }) =>
              uncopiable(found, seen, traits, "capture") ??
              (seen === "running"
                ? pinRefusal({ copy: found.name }, found.pin, pin)
                : undefined),
          });

          if (refusal !== undefined) {
            return yield* refusal;
          }
        }

        return yield* capturing(request);
      });

    const stopping = ({ id, capture }: StopRequest) =>
      Effect.gen(function* () {
        if (capture === undefined) {
          return yield* machines.stop(id);
        }

        const found = yield* madeMachine(store, id);

        const { traits, pin } = yield* answering(hosts, found.host);

        if (stopsBeforeCapture(traits)) {
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const record = yield* recorded({ machine: id, ...capture });

              const stopped = yield* machines
                .stop(id)
                .pipe(Effect.tapError(() => discarded(record)));

              yield* driven(record);

              return stopped;
            })
          );
        }

        const seen = yield* stateOf(hosts, found);

        if (seen === "unknown") {
          return yield* new Unavailable({
            message: `machine ${id}'s host can't be reached, so it can't be captured before it stops`,
            readOnly: true,
          });
        }

        if (seen !== "running") {
          return yield* new WrongState({
            message: `machine ${id} is ${seen}, and its host captures only a running machine, so a stop captures it only running: start it, then capture it`,
            machine: id,
            state: seen,
          });
        }

        const unpinned = pinRefusal({ copy: id }, found.pin, pin);

        if (unpinned !== undefined) {
          return yield* unpinned;
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const record = yield* recorded({ machine: id, ...capture });

            yield* driven(record);
            yield* Effect.exit(restore(begun(record.name)));

            return yield* machines
              .stop(id, record.name)
              .pipe(Effect.tapError(() => discarded(record)));
          })
        );
      });

    const sweep = Effect.gen(function* () {
      const now = yield* DateTime.now;

      for (const record of yield* store.checkpoints) {
        if (expired(record, now)) {
          yield* Effect.logInfo(`checkpoint ${record.name} expired`);
          yield* remove(record.name);
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`the expiry sweep failed:\n${Cause.pretty(cause)}`)
      )
    );

    for (const record of yield* store.checkpoints) {
      yield* drive(record.name);
    }

    yield* Effect.forkIn(
      Effect.forever(Effect.andThen(Effect.sleep(settings.recheck), sweep)),
      scope
    );

    return {
      list: Effect.fn("Checkpoints.list")((filter) =>
        Effect.map(store.checkpoints, (records) =>
          records.flatMap((record) =>
            !fromBuild(record) && labelledWith(record.labels, filter.labels)
              ? [shown(record)]
              : []
          )
        )
      ),
      get: Effect.fn("Checkpoints.get")((id) => Effect.map(row(id), shown)),
      capture: Effect.fn("Checkpoints.capture")(asked),
      stop: Effect.fn("Checkpoints.stop")(stopping),
      delete: Effect.fn("Checkpoints.delete")((id) =>
        Effect.andThen(row(id), remove(id))
      ),
      copy: Effect.fn("Checkpoints.copy")((machine, build) => {
        const name = buildCopyName("built");

        return capturing({ machine, name }, build).pipe(
          Effect.andThen(rested(name)),
          Effect.as(name)
        );
      }),
      publish: Effect.fn("Checkpoints.publish")((name) =>
        applying(name, { type: "publish" }).pipe(
          Effect.andThen(drive(name)),
          Effect.andThen(rested(name))
        )
      ),
      fetch: Effect.fn("Checkpoints.fetch")((published, host) =>
        Effect.gen(function* () {
          const name = buildCopyName("fetched");

          yield* store.insertCheckpoint({
            ...published,
            name,
            instance: newId(),
            createdAt: yield* DateTime.now,
            host,
            handle: undefined,
            state: "fetching.due",
            error: undefined,
            failedAt: undefined,
          });
          yield* drive(name);
        })
      ),
      discard: Effect.fn("Checkpoints.discard")((name) =>
        remove(name).pipe(Effect.catchTag("NotFound", () => Effect.void))
      ),
    } satisfies Interface;
  });

export const layer = (settings: {
  readonly recheck: Duration.Duration;
}): Layer.Layer<Checkpoints, Internal, Store | Hosts | Machines> =>
  Layer.effect(Checkpoints, make(settings));
