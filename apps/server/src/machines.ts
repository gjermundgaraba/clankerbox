import type { HostInfo, MachineState, Report } from "@clankerbox/host-contract";
import {
  Internal,
  isResting,
  NotMade,
  NotOffered,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  CreateRequest,
  Declared,
  Machine,
  NotFound,
  PrebuildRequest,
  ResizeRequest,
  Setup,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import type { Duration, Scope } from "effect";

import { applied } from "./chart.ts";
import { copied, refusedBySource } from "./copies.ts";
import type { Spec } from "./copies.ts";
import { driver, untilRest } from "./driver.ts";
import type { Heard } from "./driver.ts";
import { capacity, recheckHosts } from "./fleet.ts";
import type { CapacityRead } from "./fleet.ts";
import { Hosts } from "./hosts.ts";
import {
  activityOf,
  desiredOf,
  machineChart,
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
import { candidatesFor, placing } from "./placement.ts";
import type { Candidate } from "./placement.ts";
import { nameOf } from "./prebuilds.ts";
import { machineStep, refOf } from "./steps.ts";
import { newId, notFound, Store } from "./store.ts";
import type { Operation, Source } from "./store.ts";
import { checked, due, firstCheck, ticked, unchecked } from "./tailnet.ts";
import type { TailnetCheck } from "./tailnet.ts";

export interface Settings {
  readonly recheck: Duration.Duration;
  /** How long a failed create's row stays to tell why. */
  readonly failedRowsLast: Duration.Duration;
}

export interface Interface {
  readonly list: Effect.Effect<readonly Machine[], Internal>;
  readonly get: (id: string) => Effect.Effect<Machine, Declared<"getMachine">>;
  readonly create: (
    request: CreateRequest
  ) => Effect.Effect<Machine, Declared<"createMachine">>;
  /** A machine for a prebuild to capture, on `host`, deleted if the control plane restarts. */
  readonly build: (
    name: string,
    request: PrebuildRequest,
    host: string
  ) => Effect.Effect<void, Declared<"createMachine">>;
  readonly start: (
    id: string
  ) => Effect.Effect<Machine, Declared<"startMachine">>;
  readonly stop: (
    id: string
  ) => Effect.Effect<Machine, Declared<"stopMachine">>;
  readonly pause: (
    id: string
  ) => Effect.Effect<Machine, Declared<"pauseMachine">>;
  readonly resize: (
    request: ResizeRequest
  ) => Effect.Effect<Machine, Declared<"resizeMachine">>;
  readonly delete: (
    id: string
  ) => Effect.Effect<void, Declared<"deleteMachine">>;
  readonly fork: (
    id: string,
    name: string,
    sizing?: Sizing
  ) => Effect.Effect<Machine, Declared<"forkMachine">>;
  readonly restore: (
    checkpoint: string,
    name: string,
    sizing?: Sizing
  ) => Effect.Effect<Machine, Declared<"restoreMachine">>;
  readonly capacity: Effect.Effect<CapacityRead, Internal>;
  /**
   * Waits until a machine rests or is gone, for a prebuild's own steps. A machine that can't be read
   * for a whole recheck ends the wait as `Unavailable`, whatever step it is in.
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
            prebuild: candidate.prebuild,
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
              Effect.flatMap((sizing) =>
                applying(found.name, { type: "sized", sizing })
              ),
              Effect.asVoid,
              Effect.catchTag("Unreachable", (error) =>
                Effect.logWarning(
                  `couldn't read the sizes of ${found.name}, so it keeps those it has: ${error.message}`
                )
              )
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

            if (written && op.kind === "join") {
              tailnets.set(
                name,
                checked(tailnets.get(name) ?? unchecked, report.outcome.tailnet)
              );
            } else if (
              written &&
              op.kind === "start" &&
              report.status === "done"
            ) {
              tailnets.set(name, firstCheck);
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
                message: `the ${op.kind} of machine ${name} ended before its host reported it: its host restarted, or the setup left with a restart of the control plane`,
              }),
            });

            if (written && op.kind === "resize") {
              yield* sizesRead(found);
            }

            return yield* collect(hosts, op);
          }
        }
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
          step: machineStep(store, found, op, creates.get(found.name)?.setup),
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
      spec: Spec,
      placed: Candidate,
      info: HostInfo,
      ephemeral: boolean,
      held: CreateHeldInMemory
    ) =>
      Effect.gen(function* () {
        const created: MachineRow = {
          name,
          instance: newId(),
          createdAt: yield* DateTime.now,
          kind: info.kind,
          base: spec.base,
          profile: spec.profile,
          cpu: spec.cpu,
          ramMib: spec.ramMib,
          diskGib: spec.diskGib,
          host: placed.host,
          port: undefined,
          desired: "running",
          state: "making.due",
          prepared: false,
          error: undefined,
          resize: undefined,
          ephemeral,
          source: placed.source,
          prebuild: placed.prebuild,
          hostKey: undefined,
          pin: info.pin,
          undoneAt: undefined,
        };

        yield* store.insertMachine(created);
        creates.set(name, held);
        yield* drive(name);

        return shown(created);
      });

    const asked = (name: string, desired: Wish) =>
      Effect.gen(function* () {
        const { next, moved } = yield* recorded(name, {
          type: "ask",
          desired,
        });

        return moved || stageOf(next.state) === "deleting"
          ? shown(next)
          : yield* notFound("machine", name);
      });

    const infoOf = (host: string) =>
      hosts
        .read(host)
        .pipe(
          Effect.mapError(
            ({ message }) => new Unavailable({ message, readOnly: true })
          )
        );

    const copy = (
      name: string,
      spec: Spec,
      info: HostInfo,
      host: string,
      source: Source
    ) =>
      born(name, spec, { host, source, prebuild: undefined }, info, false, {
        setup: undefined,
        untried: [],
      });

    const placedFor = (base: string) =>
      Effect.gen(function* () {
        const placed = placing(yield* hosts.reachAll, base);

        if (placed.hosts.length === 0) {
          const reasons = placed.misses.join("; ");

          return yield* placed.noReply
            ? new Unavailable({
                message: `no host answered that can take base ${base}: ${reasons}`,
                readOnly: true,
              })
            : new NotOffered({
                message: `no host offers base ${base}: ${reasons}`,
                base,
              });
        }

        return placed.hosts;
      });

    const create = (request: CreateRequest) =>
      Effect.gen(function* () {
        const { id: name, setup, fresh } = request;
        const placed = yield* placedFor(request.base);

        const prebuilds = new Map<string, string>();

        if (setup !== undefined && fresh !== true) {
          for (const host of placed) {
            const prebuilt = yield* nameOf(request, host);
            const found = yield* store.findCheckpoint(prebuilt);

            if (Option.isSome(found) && found.value.state === "ready") {
              prebuilds.set(host.id, prebuilt);
            }
          }
        }

        const [first, ...untried] = candidatesFor(
          placed,
          prebuilds,
          setup !== undefined
        );

        const info = hosts.known(first?.host ?? "");

        if (first === undefined || info === undefined) {
          return yield* new Internal({
            message: `no host left to place machine ${name} on`,
          });
        }

        return yield* born(name, request, first, info, false, {
          setup,
          untried,
        });
      });

    const build: Interface["build"] = (name, request, host) =>
      Effect.gen(function* () {
        const info = yield* infoOf(host);

        yield* born(
          name,
          request,
          {
            host,
            source: { kind: "base", scripted: true },
            prebuild: undefined,
          },
          info,
          true,
          { setup: request.setup, untried: [] }
        );
      });

    const fork = (id: string, name: string, sizing?: Sizing) =>
      Effect.gen(function* () {
        const from = yield* row(id);

        if (stageOf(from.state) !== "made") {
          return yield* unmade(from);
        }

        const info = yield* infoOf(from.host);

        return yield* copy(
          name,
          yield* copied(name, from, sizing, from.kind),
          info,
          from.host,
          { kind: "machine", name: id }
        );
      });

    const restore = (checkpoint: string, name: string, sizing?: Sizing) =>
      Effect.gen(function* () {
        const present = yield* store.findCheckpoint(checkpoint);

        if (Option.isNone(present) || present.value.state !== "ready") {
          return yield* notFound("checkpoint", checkpoint);
        }

        const record = present.value;

        const info = yield* infoOf(record.host);

        return yield* copy(
          name,
          yield* copied(name, record, sizing, info.kind),
          info,
          record.host,
          { kind: "checkpoint", name: checkpoint }
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

        return activityOf(found.value.state) !== "follow" && isResting(phase);
      });

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
      list: Effect.gen(function* () {
        const rows = (yield* store.machines).filter(
          ({ ephemeral }) => !ephemeral
        );

        const states = yield* readStates(hosts, rows);

        return rows.map((found) => shown(found, stateIn(found, states)));
      }).pipe(Effect.withSpan("Machines.list")),
      get: Effect.fn("Machines.get")((id) =>
        Effect.flatMap(row(id), (found) =>
          Effect.map(stateOf(hosts, found), (state) => shown(found, state))
        )
      ),
      create: Effect.fn("Machines.create")(create),
      build: Effect.fn("Machines.build")(build),
      start: Effect.fn("Machines.start")((id) => asked(id, "running")),
      stop: Effect.fn("Machines.stop")((id) => asked(id, "stopped")),
      pause: Effect.fn("Machines.pause")((id) => asked(id, "paused")),
      resize: Effect.fn("Machines.resize")(resize),
      delete: Effect.fn("Machines.delete")(remove),
      fork: Effect.fn("Machines.fork")(fork),
      restore: Effect.fn("Machines.restore")(restore),
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
