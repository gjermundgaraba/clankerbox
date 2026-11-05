import type { HostInfo, MachineState, Report } from "@clankerbox/host-contract";
import {
  buildId,
  Internal,
  isResting,
  labelledWith,
  NotBuilt,
  NotMade,
  readTimeout,
  templateRef,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  CreateRequest,
  Declared,
  Executed,
  ExecRequest,
  ForkRequest,
  Labels,
  ListFilter,
  Machine,
  NotFound,
  ResizeRequest,
  RestoreRequest,
  Setup,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schedule,
} from "effect";
import type { Scope } from "effect";

import { applied } from "./chart.ts";
import { cloned, copied, refusedBySource } from "./copies.ts";
import type { Spec } from "./copies.ts";
import { driver, untilRest } from "./driver.ts";
import type { Heard } from "./driver.ts";
import { capacity, recheckHosts } from "./fleet.ts";
import type { CapacityRead } from "./fleet.ts";
import { answering, Hosts } from "./hosts.ts";
import {
  activityOf,
  desiredOf,
  machineChart,
  phaseOf,
  stageOf,
  wants,
} from "./machine-chart.ts";
import type { MachineEvent, MachineRow, Move, Wish } from "./machine-chart.ts";
import {
  machineOf,
  phaseShown,
  readStates,
  stateIn,
  stateOf,
} from "./machine-view.ts";
import { collect, cutShort, poll } from "./operations.ts";
import { holding, placing } from "./placement.ts";
import type { BuiltUnder, Candidate } from "./placement.ts";
import { machineStep, refOf } from "./steps.ts";
import { newId, notFound, Store } from "./store.ts";
import type { Operation, TemplateRow } from "./store.ts";
import { checked, due, firstCheck, ticked, unchecked } from "./tailnet.ts";
import type { TailnetCheck } from "./tailnet.ts";

export interface Settings {
  readonly recheck: Duration.Duration;
  readonly failedRowsLast: Duration.Duration;
  readonly authorizedKeys: string;
}

const stepPoll = Duration.millis(100);

export interface Interface {
  readonly list: (
    filter: ListFilter
  ) => Effect.Effect<readonly Machine[], Internal>;
  readonly get: (
    id: string,
    holdSeconds?: number
  ) => Effect.Effect<Machine, Declared<"getMachine">>;
  readonly create: (
    request: CreateRequest
  ) => Effect.Effect<Machine, Declared<"createMachine">>;
  /** A machine for a template's build to capture, on `host`, deleted if the control plane restarts. */
  readonly build: (
    name: string,
    spec: Spec & { readonly setup: Setup },
    host: string
  ) => Effect.Effect<void, Declared<"createMachine">>;
  readonly start: (
    id: string
  ) => Effect.Effect<Machine, Declared<"startMachine">>;
  readonly stop: (
    id: string
  ) => Effect.Effect<Machine, Declared<"stopMachine">>;
  /** `after` names a checkpoint whose capture, once recorded, begins before the pause does. */
  readonly pause: (
    id: string,
    after?: string
  ) => Effect.Effect<Machine, Declared<"pauseMachine">>;
  readonly resize: (
    request: ResizeRequest
  ) => Effect.Effect<Machine, Declared<"resizeMachine">>;
  readonly delete: (
    id: string
  ) => Effect.Effect<void, Declared<"deleteMachine">>;
  readonly fork: (
    request: ForkRequest & Sizing
  ) => Effect.Effect<Machine, Declared<"forkMachine">>;
  readonly restore: (
    request: RestoreRequest & Sizing
  ) => Effect.Effect<Machine, Declared<"restoreMachine">>;
  /**
   * Runs a command in a machine, through its host, once a step on it has ended, and for as long
   * as the request does. Nothing of it is stored.
   */
  readonly exec: (
    request: ExecRequest
  ) => Effect.Effect<Executed, Declared<"execMachine">>;
  readonly capacity: Effect.Effect<CapacityRead, Internal>;
  /**
   * Waits until a machine rests or is gone, for a template build's own steps, reading its VM only once
   * its row rests. A host that can't be reached for a whole recheck ends the wait as `Unavailable`,
   * whatever step the machine is in.
   */
  readonly rest: (
    name: string
  ) => Effect.Effect<Option.Option<MachineRow>, Internal | Unavailable>;
}

export class Machines extends Context.Service<Machines, Interface>()(
  "@clankerbox/server/Machines"
) {}

interface CreateHeldInMemory {
  readonly setup: Setup | undefined;
  readonly untried: readonly Candidate[];
}

type TemplateCreate = Extract<CreateRequest, { readonly template: string }>;

type BaseCreate = Exclude<CreateRequest, TemplateCreate>;

const readyBuild = (
  found: Option.Option<TemplateRow>,
  { template, number }: ReturnType<typeof templateRef>
): Result.Result<BuiltUnder, NotBuilt> => {
  const ready = Option.match(found, {
    onNone: () => [],
    onSome: ({ builds }) => builds.filter(({ phase }) => phase === "ready"),
  });

  const build =
    number === undefined
      ? ready.at(-1)
      : ready.find((each) => each.number === number);

  if (build !== undefined && Option.isSome(found)) {
    return Result.succeed({
      id: buildId(template, build.number),
      base: found.value.base,
      pin: build.pin,
      image: build.image,
    });
  }

  const kept = ready.map((each) => buildId(template, each.number));

  return Result.fail(
    new NotBuilt({
      message: `template ${template} has no ready build${number === undefined ? "" : ` ${buildId(template, number)}`}: ${
        kept.length === 0
          ? `run clankerbox template build ${template} to make one`
          : `its ready builds are ${kept.join(", ")}`
      }`,
      template,
    })
  );
};

interface Made {
  readonly spec: Spec;
  readonly labels: Labels | undefined;
  readonly template?: string | undefined;
  readonly ephemeral?: boolean | undefined;
}

const onBase = ({ id }: HostInfo): Candidate => ({
  host: id,
  source: { kind: "base" },
});

/** Why a machine can't be copied or resized: it may yet be made, or it won't be. */
export const unmade = (found: MachineRow): NotMade | NotFound =>
  stageOf(found.state) === "making"
    ? new NotMade({
        message: `machine ${found.name} isn't made yet: its create or setup still runs`,
        machine: found.name,
      })
    : notFound("machine", found.name);

export const make = (
  settings: Settings
): Effect.Effect<Interface, Internal, Store | Hosts | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const hosts = yield* Hosts;
    const scope = yield* Effect.scope;

    const creates = new Map<string, CreateHeldInMemory>();
    const tailnets = new Map<string, TailnetCheck>();

    const row = (name: string) =>
      Effect.flatMap(store.findMachine(name), (found) =>
        Effect.fromOption(found, () => notFound("machine", name))
      );

    const applying = (name: string, event: MachineEvent) =>
      store.advance("machine", name, (found, op) =>
        applied(machineChart, found, event, op)
      );

    const shown = (found: MachineRow, seen?: MachineState) =>
      machineOf(found, seen, {
        address: hosts.known(found.host)?.publishAddress,
        tailnet: tailnets.get(found.name)?.status,
      });

    const movedPastCapacity = (found: MachineRow): Move | undefined => {
      const [candidate] = creates.get(found.name)?.untried ?? [];
      const info = hosts.known(candidate?.host ?? "");

      return candidate === undefined ||
        info === undefined ||
        found.error?._tag !== "Capacity"
        ? undefined
        : {
            host: candidate.host,
            kind: info.kind,
            pin: info.pin,
            source: candidate.source,
          };
    };

    const reportedBy = (
      found: MachineRow,
      op: Operation,
      { status, outcome, error }: Report,
      at: DateTime.Utc
    ): MachineEvent => {
      if (status === "failed" || status === "cancelled") {
        return {
          type: "reported",
          status,
          outcome,
          error: error ?? cutShort(op),
        };
      }

      const move = op.kind === "remove" ? movedPastCapacity(found) : undefined;

      return {
        type: "reported",
        status: "done",
        outcome,
        at,
        ...(move === undefined ? {} : { move }),
      };
    };

    const stored = (name: string, event: MachineEvent) =>
      Effect.gen(function* () {
        const answer = yield* applying(name, event);

        if (answer.at !== "written") {
          return false;
        }

        const { next } = answer;
        const held = creates.get(name);

        if (next === "removed") {
          creates.delete(name);
          tailnets.delete(name);
        } else if (next.state === "making.due" && held !== undefined) {
          creates.set(name, {
            setup: held.setup,
            untried: held.untried.slice(1),
          });
        } else if (next.state === "undone" || stageOf(next.state) === "made") {
          creates.delete(name);
        }

        return true;
      });

    const sizesRead = (found: MachineRow) => {
      const ref = refOf(found);

      return ref === undefined
        ? Effect.void
        : hosts
            .call(found.host, (api) => api.readSizes({ machine: ref }))
            .pipe(
              Effect.matchEffect({
                onFailure: ({ message }) =>
                  Effect.logWarning(
                    `couldn't read the sizes of ${found.name}, so it keeps those it has: ${message}`
                  ),
                onSuccess: (sizing) =>
                  Effect.asVoid(
                    applying(found.name, { type: "sized", sizing })
                  ),
              })
            );
    };

    const following = (found: MachineRow, op: Operation, heard: Heard) =>
      Effect.gen(function* () {
        const { name } = found;

        switch (heard.at) {
          case "running": {
            const { port } = heard.report.outcome;

            if (port !== undefined && found.port !== port) {
              yield* applying(name, { type: "ran", port });
            }

            return;
          }

          case "ended": {
            const { report } = heard;

            const written = yield* stored(
              name,
              reportedBy(found, op, report, yield* DateTime.now)
            );

            if (written && op.kind === "start") {
              tailnets.delete(name);
            }

            if (written && op.kind === "join") {
              tailnets.set(
                name,
                checked(tailnets.get(name) ?? unchecked, report.outcome.tailnet)
              );
            }

            return yield* collect(hosts, op);
          }

          case "lost": {
            yield* Effect.logWarning(
              `machine ${name}'s ${op.kind} is gone from host ${op.host}`
            );

            const written = yield* stored(name, {
              type: "lost",
              error: new Internal({
                message: `the ${op.kind} of machine ${name} ended before its host reported it: ${heard.why}`,
              }),
            });

            if (written && op.kind === "resize") {
              yield* sizesRead(found);
            }

            return yield* collect(hosts, op);
          }
        }
      });

    const unbegun = (checkpoint: string) =>
      Effect.gen(function* () {
        const record = yield* store.findCheckpoint(checkpoint);

        return (
          Option.isSome(record) &&
          record.value.state === "capturing.due" &&
          Option.isNone(yield* store.operationOn("checkpoint", checkpoint))
        );
      });

    const looking = (found: MachineRow) =>
      Effect.gen(function* () {
        const { name } = found;

        const refused =
          found.state === "making.due"
            ? yield* refusedBySource(store, found)
            : undefined;

        if (refused !== undefined) {
          return yield* applying(name, { type: "refused", error: refused });
        }

        const seen =
          stageOf(found.state) === "made"
            ? yield* stateOf(hosts, found)
            : "unknown";

        const info = yield* hosts.read(found.host);
        const check = tailnets.get(name) ?? firstCheck;

        const answer = yield* applying(name, {
          type: "read",
          seen,
          boot: info.boot,
          pin: info.pin,
          id: newId(),
          joins:
            seen === "running" && !found.ephemeral && due(check) && info.joins,
          awaiting:
            found.desired === "paused" &&
            found.after !== undefined &&
            (yield* unbegun(found.after)),
        });

        if (
          answer.at === "written" &&
          answer.next !== "removed" &&
          answer.next.state === "made.settled"
        ) {
          tailnets.set(name, ticked(check));
        }

        return answer;
      });

    const drive = yield* driver(settings.recheck, {
      kind: "machine",
      find: store.findMachine,
      operationOn: store.operationOn,
      activityOf,
      looking,
      polling: (found, op) =>
        poll(hosts, op, {
          cut: !wants(op.kind, desiredOf(found)),
          step: machineStep(
            store,
            found,
            op,
            creates.get(found.name)?.setup,
            settings.authorizedKeys
          ),
        }),
      following,
    });

    const recorded = (name: string, event: MachineEvent) =>
      Effect.gen(function* () {
        const answer = yield* applying(name, event);

        if (answer.at !== "written" || answer.next === "removed") {
          return yield* notFound("machine", name);
        }

        yield* drive(name);

        return { next: answer.next, moved: answer.moved };
      });

    const born = (
      name: string,
      { spec, labels, template, ephemeral }: Made,
      placed: Candidate,
      info: HostInfo,
      held: CreateHeldInMemory
    ) =>
      Effect.gen(function* () {
        const created: MachineRow = {
          name,
          instance: newId(),
          createdAt: yield* DateTime.now,
          kind: info.kind,
          base: spec.base,
          cpu: spec.cpu,
          ramMib: spec.ramMib,
          diskGib: spec.diskGib,
          labels,
          host: placed.host,
          port: undefined,
          desired: "running",
          state: "making.due",
          prepared: false,
          error: undefined,
          resize: undefined,
          ephemeral: ephemeral === true,
          source: placed.source,
          template,
          hostKey: undefined,
          pin: info.pin,
          undoneAt: undefined,
          after: undefined,
        };

        yield* store.insertMachine(created);
        creates.set(name, held);
        yield* drive(name);

        return shown(created);
      });

    const asked = (name: string, desired: Wish, after?: string) =>
      Effect.gen(function* () {
        const { next, moved } = yield* recorded(name, {
          type: "ask",
          desired,
          after,
        });

        return moved || stageOf(next.state) === "deleting"
          ? shown(next)
          : yield* notFound("machine", name);
      });

    const copy = (
      name: string,
      made: Made,
      info: HostInfo,
      placed: Candidate
    ) => born(name, made, placed, info, { setup: undefined, untried: [] });

    const fromBase = (request: BaseCreate) =>
      Effect.gen(function* () {
        const { id: name, labels } = request;

        const [first, ...rest] = yield* Effect.fromResult(
          placing(yield* hosts.reachAll, request.base)
        );

        return yield* born(
          name,
          { spec: request, labels },
          onBase(first),
          first,
          { setup: undefined, untried: rest.map(onBase) }
        );
      });

    const fromTemplate = (request: TemplateCreate) =>
      Effect.gen(function* () {
        const { id: name, template: ref, labels, ...sizing } = request;
        const pinned = templateRef(ref);
        const { template } = pinned;

        const made = yield* Effect.fromResult(
          readyBuild(yield* store.findTemplate(template), pinned)
        );

        const build = made.id;

        const copies = new Map(
          (yield* store.checkpoints).flatMap((record) =>
            record.build === build && record.state === "ready"
              ? [[record.host, record] as const]
              : []
          )
        );

        const [first, ...rest] = yield* Effect.fromResult(
          holding(yield* hosts.reachAll, copies, template, made)
        );

        const onCopy = ([{ id }, held]: (typeof rest)[number]): Candidate => ({
          host: id,
          source: { kind: "checkpoint", name: held.name },
        });

        const [info, held] = first;

        return yield* born(
          name,
          {
            spec: yield* cloned(name, build, held, sizing),
            labels,
            template: build,
          },
          onCopy(first),
          info,
          { setup: undefined, untried: rest.map(onCopy) }
        );
      });

    const create: Interface["create"] = (request) =>
      "template" in request ? fromTemplate(request) : fromBase(request);

    const build: Interface["build"] = (name, spec, host) =>
      Effect.gen(function* () {
        const info = yield* answering(hosts, host);

        yield* born(
          name,
          { spec, labels: undefined, ephemeral: true },
          { host, source: { kind: "base" } },
          info,
          { setup: spec.setup, untried: [] }
        );
      });

    const fork = ({
      machine: id,
      name,
      labels,
      ...sizing
    }: ForkRequest & Sizing) =>
      Effect.gen(function* () {
        const from = yield* row(id);

        if (stageOf(from.state) !== "made") {
          return yield* unmade(from);
        }

        const info = yield* answering(hosts, from.host);

        return yield* copy(
          name,
          { spec: yield* copied(name, from, sizing, from.kind), labels },
          info,
          { host: from.host, source: { kind: "machine", name: id } }
        );
      });

    const restore = ({
      checkpoint,
      name,
      labels,
      ...sizing
    }: RestoreRequest & Sizing) =>
      Effect.gen(function* () {
        const present = yield* store.findCheckpoint(checkpoint);

        if (
          Option.isNone(present) ||
          present.value.state !== "ready" ||
          present.value.build !== undefined
        ) {
          return yield* notFound("checkpoint", checkpoint);
        }

        const record = present.value;

        const info = yield* answering(hosts, record.host);

        return yield* copy(
          name,
          { spec: yield* copied(name, record, sizing, info.kind), labels },
          info,
          {
            host: record.host,
            source: { kind: "checkpoint", name: checkpoint },
          }
        );
      });

    const stepless = (name: string) =>
      row(name).pipe(
        Effect.repeat({
          until: (found) => activityOf(found.state) !== "follow",
          schedule: Schedule.spaced(stepPoll).pipe(
            Schedule.upTo({ duration: readTimeout })
          ),
        })
      );

    const exec = ({ id, ...command }: ExecRequest) =>
      Effect.gen(function* () {
        const made = yield* row(id);

        if (stageOf(made.state) !== "made") {
          return yield* unmade(made);
        }

        const found = yield* stepless(id);
        const ref = refOf(found);

        if (stageOf(found.state) !== "made" || ref === undefined) {
          return yield* unmade(found);
        }

        const { timeoutSeconds } = command;

        return yield* hosts
          .call(
            found.host,
            (api) => api.execMachine({ machine: ref, ...command }),
            timeoutSeconds === undefined
              ? Duration.infinity
              : Duration.sum(Duration.seconds(timeoutSeconds), readTimeout)
          )
          .pipe(
            Effect.catchTag(
              "Unreachable",
              ({ message }) => new Unavailable({ message, readOnly: false })
            )
          );
      });

    const resize = (request: ResizeRequest) =>
      Effect.gen(function* () {
        const { id, ...sizing } = request;

        const { next, moved } = yield* recorded(id, {
          type: "resize",
          sizing,
        });

        return moved || stageOf(next.state) === "deleting"
          ? shown(next)
          : yield* unmade(next);
      });

    const remove = (name: string) =>
      Effect.flatMap(applying(name, { type: "delete" }), (answer) =>
        answer.at === "absent"
          ? Effect.fail(notFound("machine", name))
          : drive(name)
      );

    const rests = (name: string) =>
      Effect.gen(function* () {
        const found = yield* store.findMachine(name);

        if (Option.isNone(found)) {
          return true;
        }

        const resting =
          activityOf(found.value.state) !== "follow" &&
          isResting(phaseOf(found.value.state));

        // https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/List.swift#L47
        if (!resting) {
          return yield* hosts.read(found.value.host).pipe(
            Effect.as(false),
            Effect.mapError(
              ({ message }) =>
                new Unavailable({
                  message: `machine ${name}'s host can't be reached: ${message}`,
                  readOnly: true,
                })
            )
          );
        }

        const phase = phaseShown(
          found.value,
          yield* stateOf(hosts, found.value)
        );

        if (phase === "waiting") {
          return yield* new Unavailable({
            message: `machine ${name}'s host can't be reached`,
            readOnly: true,
          });
        }

        return true;
      });

    const held = (id: string, bound: Duration.Duration) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { now, next } = yield* store.watchMachine(id);

          const first = yield* Effect.fromOption(now, () =>
            notFound("machine", id)
          );

          const answers = Option.match({
            onNone: () => true,
            onSome: (found: MachineRow) =>
              found.instance !== first.instance ||
              isResting(phaseOf(found.state)),
          });

          if (!answers(now)) {
            yield* Effect.timeoutOption(
              Effect.repeat(next, { until: answers }),
              bound
            );
          }
        })
      );

    const read = (id: string) =>
      Effect.flatMap(row(id), (found) =>
        Effect.map(stateOf(hosts, found), (state) => shown(found, state))
      );

    const rest = (name: string) =>
      Effect.andThen(
        untilRest(settings.recheck, rests(name)),
        store.findMachine(name)
      );

    const tick = recheckHosts(store, hosts, settings.failedRowsLast);

    yield* tick;

    for (const found of yield* store.machines) {
      if (found.ephemeral) {
        yield* applying(found.name, { type: "delete" });
      }

      yield* drive(found.name);
    }

    yield* Effect.forkIn(
      Effect.forever(Effect.andThen(Effect.sleep(settings.recheck), tick)),
      scope
    );

    return {
      list: Effect.fn("Machines.list")((filter) =>
        Effect.gen(function* () {
          const rows = (yield* store.machines).filter(
            ({ ephemeral, labels }) =>
              !ephemeral && labelledWith(labels, filter.labels)
          );

          const states = yield* readStates(hosts, rows);

          return rows.map((found) => shown(found, stateIn(found, states)));
        })
      ),
      get: Effect.fn("Machines.get")((id, holdSeconds) =>
        holdSeconds === undefined
          ? read(id)
          : Effect.andThen(held(id, Duration.seconds(holdSeconds)), read(id))
      ),
      create: Effect.fn("Machines.create")(create),
      build: Effect.fn("Machines.build")(build),
      start: Effect.fn("Machines.start")((id) => asked(id, "running")),
      stop: Effect.fn("Machines.stop")((id) => asked(id, "stopped")),
      pause: Effect.fn("Machines.pause")((id, after) =>
        asked(id, "paused", after)
      ),
      resize: Effect.fn("Machines.resize")(resize),
      delete: Effect.fn("Machines.delete")(remove),
      fork: Effect.fn("Machines.fork")(fork),
      restore: Effect.fn("Machines.restore")(restore),
      exec: Effect.fn("Machines.exec")(exec),
      capacity: capacity(store, hosts).pipe(
        Effect.withSpan("Machines.capacity")
      ),
      rest,
    } satisfies Interface;
  });

export const layer = (
  settings: Settings
): Layer.Layer<Machines, Internal, Store | Hosts> =>
  Layer.effect(Machines, make(settings));
