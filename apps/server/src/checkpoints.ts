import type { Report } from "@clankerbox/host-contract";
import {
  copyPrefixes,
  Internal,
  isResting,
  labelledWith,
  pauseCapture,
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
  PauseRequest,
  Conflict,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
} from "effect";
import type { Scope } from "effect";

import { applied } from "./chart.ts";
import { activityOf, checkpointChart, phaseOf } from "./checkpoint-chart.ts";
import type { CheckpointEvent, CheckpointRow } from "./checkpoint-chart.ts";
import { uncopiable, unpinned } from "./copies.ts";
import { apart, driver, untilRest } from "./driver.ts";
import type { Heard } from "./driver.ts";
import { answering, Hosts } from "./hosts.ts";
import { phaseOf as machinePhaseOf, stageOf } from "./machine-chart.ts";
import type { MachineRow } from "./machine-chart.ts";
import { stateOf } from "./machine-view.ts";
import { Machines, unmade } from "./machines.ts";
import { collect, cutShort, poll } from "./operations.ts";
import { checkpointStep } from "./steps.ts";
import { newId, notFound, Store } from "./store.ts";
import type { Operation } from "./store.ts";

const beginPoll = Duration.millis(100);

export interface Interface {
  readonly list: (
    filter: ListFilter
  ) => Effect.Effect<readonly Checkpoint[], Internal>;
  readonly get: (
    id: string
  ) => Effect.Effect<Checkpoint, Declared<"getCheckpoint">>;
  /** Records a capture and answers at once. */
  readonly capture: (
    request: CaptureRequest
  ) => Effect.Effect<Checkpoint, Declared<"captureCheckpoint">>;
  /**
   * Asks a machine to pause, capturing it too if `capture` says so, where `pauseCapture` of its
   * host's traits, as the host answers now, says: `before` records the capture first and the pause
   * waits for it to begin, so the checkpoint holds the machine as it ran; `after` records the pause
   * first, and the capture waits for the machine to rest; `never` is refused, recording nothing. A
   * host that can't be read is `Unavailable`, recording nothing.
   */
  readonly pause: (
    request: PauseRequest
  ) => Effect.Effect<Machine, Declared<"pauseMachine">>;
  readonly delete: (
    id: string
  ) => Effect.Effect<void, Declared<"deleteCheckpoint">>;
  /**
   * Captures `machine` as a copy of template build `build`, which no client reaches as a
   * checkpoint, and waits for the capture to end, failing with its error. Answers the copy's name.
   */
  readonly copy: (
    machine: string,
    build: string
  ) => Effect.Effect<string, HostError>;
  /** Publishes a build's copy to the build store, and waits for that to end, failing with its error. */
  readonly publish: (name: string) => Effect.Effect<void, HostError>;
  /** Records a copy of `published`, a build's published copy, fetched by `host`, and answers at once. */
  readonly fetch: (
    published: CheckpointRow,
    host: string
  ) => Effect.Effect<void, Conflict | Internal>;
  /** Deletes a copy of a template build, if it is there. */
  readonly discard: (name: string) => Effect.Effect<void, Internal>;
}

export class Checkpoints extends Context.Service<Checkpoints, Interface>()(
  "@clankerbox/server/Checkpoints"
) {}

const shown = (record: CheckpointRow): Checkpoint => ({
  id: record.name,
  createdAt: record.createdAt,
  machine: record.machine,
  kind: record.traits.checkpoint,
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
          Option.filter(found, ({ build }) => build === undefined),
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

      return Effect.scoped(
        Effect.gen(function* () {
          const { now, next } = yield* store.watchMachine(machine);

          if (!rests(now)) {
            yield* Effect.repeat(next, { until: rests });
          }
        })
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
        const present = yield* store.findMachine(source);

        if (Option.isNone(present)) {
          return yield* notFound("machine", source);
        }

        const machine = present.value;

        if (stageOf(machine.state) !== "made") {
          return yield* unmade(machine);
        }

        const record: CheckpointRow = {
          name,
          instance: newId(),
          createdAt: yield* DateTime.now,
          machine: source,
          host: machine.host,
          traits: machine.traits,
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
              `couldn't discard checkpoint ${name}, whose pause was refused, so it stays a capture of its own, which runs now or at the next start of the control plane: ${Cause.pretty(cause)}`
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

    const rested = (name: string) => untilRest(settings.recheck, rests(name));

    const begun = (name: string) =>
      Effect.gen(function* () {
        const record = yield* store.findCheckpoint(name);

        return (
          Option.isNone(record) ||
          record.value.state !== "capturing.due" ||
          Option.isSome(yield* store.operationOn("checkpoint", name))
        );
      }).pipe(
        Effect.repeat({
          until: (has) => has,
          schedule: Schedule.spaced(beginPoll).pipe(
            Schedule.upTo({ duration: readTimeout })
          ),
        }),
        Effect.asVoid
      );

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
              unpinned({ machine: found }, pin),
          });

          if (refusal !== undefined) {
            return yield* refusal;
          }
        }

        return yield* capturing(request);
      });

    const pausing = ({ id, capture }: PauseRequest) =>
      Effect.gen(function* () {
        if (capture === undefined) {
          return yield* machines.pause(id);
        }

        const present = yield* store.findMachine(id);

        if (Option.isNone(present)) {
          return yield* notFound("machine", id);
        }

        const found = present.value;

        if (stageOf(found.state) !== "made") {
          return yield* unmade(found);
        }

        const { traits, pin } = yield* answering(hosts, found.host);
        const unpinnedRefusal = unpinned({ machine: found }, pin);

        switch (pauseCapture(traits)) {
          case "never": {
            return yield* new WrongState({
              message: `machine ${id}'s host captures only a stopped machine, and its pause leaves it paused, so no pause captures it: stop it and capture it, or pause it without a capture`,
              machine: id,
              state: yield* stateOf(hosts, found),
            });
          }

          case "after": {
            if (unpinnedRefusal !== undefined) {
              return yield* unpinnedRefusal;
            }

            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const record = yield* recorded({ machine: id, ...capture });

                const paused = yield* machines
                  .pause(id)
                  .pipe(Effect.tapError(() => discarded(record)));

                yield* driven(record);

                return paused;
              })
            );
          }

          case "before": {
            break;
          }
        }

        const seen = yield* stateOf(hosts, found);

        if (seen === "unknown") {
          return yield* new Unavailable({
            message: `machine ${id}'s host can't be reached, so it can't be captured before it pauses`,
            readOnly: true,
          });
        }

        if (seen !== "running") {
          return yield* new WrongState({
            message: `machine ${id} is ${seen}, and its host captures only a running machine, so a pause captures it only running: start it, then capture it`,
            machine: id,
            state: seen,
          });
        }

        if (unpinnedRefusal !== undefined) {
          return yield* unpinnedRefusal;
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const record = yield* recorded({ machine: id, ...capture });

            yield* driven(record);
            yield* Effect.exit(restore(begun(record.name)));

            return yield* machines
              .pause(id, record.name)
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
            record.build === undefined &&
            labelledWith(record.labels, filter.labels)
              ? [shown(record)]
              : []
          )
        )
      ),
      get: Effect.fn("Checkpoints.get")((id) => Effect.map(row(id), shown)),
      capture: Effect.fn("Checkpoints.capture")(asked),
      pause: Effect.fn("Checkpoints.pause")(pausing),
      delete: Effect.fn("Checkpoints.delete")((id) =>
        Effect.andThen(row(id), remove(id))
      ),
      copy: Effect.fn("Checkpoints.copy")((machine, build) => {
        const name = `${copyPrefixes.built}${newId().slice(0, 16)}`;

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
          const name = `${copyPrefixes.fetched}${newId().slice(0, 16)}`;

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
