import type {
  HostInfo,
  MachineRef,
  MachineState,
  Report,
  Step,
} from "@clankerbox/host-contract";
import {
  checkpointKinds,
  formatGib,
  formatMib,
  Internal,
  isResting,
  loginUser,
  NotFound,
  NotMade,
  NotOffered,
  Unavailable,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  CreateRequest,
  Declared,
  Machine,
  PrebuildRequest,
  ResizeRequest,
  Setup,
  Sizing,
  Usage,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Latch,
  Layer,
  Option,
} from "effect";
import type { Scope } from "effect";
import { Hex } from "effect/encoding";

import { applied } from "./chart.ts";
import { Hosts } from "./hosts.ts";
import {
  activityOf,
  desiredOf,
  machineChart,
  phaseOf,
  stageOf,
  wants,
} from "./machine-chart.ts";
import type { MachineEvent, MachineRow, Move, Wish } from "./machine-chart.ts";
import { Operations } from "./operations.ts";
import { placing, preferring } from "./placement.ts";
import { nameOf } from "./prebuilds.ts";
import { Store } from "./store.ts";
import type { Operation, Source } from "./store.ts";
import { checked, due, firstCheck, ticked, unchecked } from "./tailnet.ts";
import type { TailnetCheck } from "./tailnet.ts";

export interface Settings {
  readonly recheck: Duration.Duration;
  /** How long a failed create's row stays to tell why. */
  readonly failedRowsLast: Duration.Duration;
}

export interface CapacityRead {
  readonly usage: readonly Usage[];
  readonly unreachable: readonly string[];
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
  /** Tells a machine's loop that something it may be waiting on changed. */
  readonly wake: (name: string) => Effect.Effect<void>;
  /**
   * Waits until a machine rests or is gone, for a prebuild's own steps. A machine that can't be read
   * ends the wait as `Unavailable`, as nothing it would go on to do can begin.
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

interface Candidate {
  readonly host: string;
  readonly source: Source;
  readonly prebuild: string | undefined;
}

const busyWait = Duration.millis(100);

const unreachableWait = Duration.seconds(1);

const restPoll = Duration.millis(100);

const newId = (): string =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));

const notFound = (name: string): NotFound =>
  new NotFound({ message: `no machine ${name}`, id: name });

interface Spec {
  readonly base: string;
  readonly profile?: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

const sizedBy = (from: Spec, sizing: Sizing | undefined): Spec => ({
  base: from.base,
  profile: from.profile,
  cpu: sizing?.cpu ?? from.cpu,
  ramMib: sizing?.ramMib ?? from.ramMib,
  diskGib: sizing?.diskGib ?? from.diskGib,
});

const refOf = (row: MachineRow): MachineRef | undefined =>
  row.port === undefined
    ? undefined
    : {
        name: row.name,
        instance: row.instance,
        cpu: row.cpu,
        ramMib: row.ramMib,
        diskGib: row.diskGib,
        port: row.port,
      };

const stateIn = (
  found: MachineRow,
  states: ReadonlyMap<string, MachineState>
): MachineState =>
  found.state === "undone" ? "missing" : (states.get(found.name) ?? "unknown");

const phaseShown = (
  found: MachineRow,
  seen: MachineState
): Machine["phase"] => {
  const phase = phaseOf(found.state);

  return seen === "unknown" && phase !== "failed" ? "waiting" : phase;
};

const pinned = (pin: string | undefined) => (pin === undefined ? {} : { pin });

const cutShort = ({ kind, name }: Operation) =>
  new Internal({ message: `the ${kind} of ${name} ended on its host` });

const copied = (
  name: string,
  from: Spec,
  sizing: Sizing | undefined,
  kind: Machine["kind"]
) =>
  Effect.gen(function* () {
    const spec = sizedBy(from, sizing);

    if (spec.diskGib < from.diskGib) {
      return yield* new Unsizable({
        message: `machine ${name}'s disk of ${formatGib(spec.diskGib)} is below its source's ${formatGib(from.diskGib)}, and a disk only grows`,
      });
    }

    if (
      checkpointKinds[kind] === "ram" &&
      (spec.cpu < from.cpu || spec.ramMib < from.ramMib)
    ) {
      return yield* new Unsizable({
        message: `a ${kind} copy holds its source's RAM, so machine ${name}'s vCPUs and RAM only grow from the source's ${from.cpu} vCPUs and ${formatMib(from.ramMib)}`,
      });
    }

    return spec;
  });

const unmade = (found: MachineRow): NotMade | NotFound =>
  stageOf(found.state) === "making"
    ? new NotMade({
        message: `machine ${found.name} isn't made yet: its create or setup still runs`,
        machine: found.name,
      })
    : notFound(found.name);

export const make = (
  settings: Settings
): Effect.Effect<
  Interface,
  Internal,
  Store | Hosts | Operations | Scope.Scope
> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const hosts = yield* Hosts;
    const operations = yield* Operations;
    const scope = yield* Effect.scope;

    const wakes = new Map<string, Latch.Latch>();
    const creates = new Map<string, CreateHeldInMemory>();
    const tailnets = new Map<string, TailnetCheck>();

    const wake = (name: string) =>
      Effect.sync(() => {
        wakes.get(name)?.openUnsafe();
      });

    const row = (name: string) =>
      Effect.flatMap(store.findMachine(name), (found) =>
        Effect.fromOption(found, () => notFound(name))
      );

    const applying = (name: string, event: MachineEvent) =>
      store.advance("machine", name, (found, op) =>
        applied(machineChart, found, event, op)
      );

    const recorded = (name: string, event: MachineEvent) =>
      Effect.gen(function* () {
        const answer = yield* applying(name, event);

        yield* wake(name);

        return answer.at === "written" && answer.next !== "removed"
          ? { next: answer.next, moved: answer.moved }
          : yield* notFound(name);
      });

    const readStates = (rows: readonly MachineRow[]) =>
      Effect.gen(function* () {
        const groups = Map.groupBy(
          rows.filter(({ state }) => state !== "undone"),
          ({ host }) => host
        );

        const answers = yield* Effect.forEach(
          [...groups],
          ([host, onHost]) =>
            hosts
              .call(host, (api) =>
                api.readMachines({
                  machines: onHost.map(({ name, instance }) => ({
                    name,
                    instance,
                  })),
                })
              )
              .pipe(Effect.orElseSucceed(() => [])),
          { concurrency: "unbounded" }
        );

        return new Map<string, MachineState>(
          answers.flat().map(({ name, state }) => [name, state])
        );
      });

    const stateOf = (found: MachineRow) =>
      Effect.map(readStates([found]), (states) => stateIn(found, states));

    const resource = (
      found: MachineRow,
      state: MachineState,
      phase: Machine["phase"]
    ): Machine => {
      const address = hosts.known(found.host)?.publishAddress;
      const tailnet = tailnets.get(found.name)?.status;
      const running = state === "running";

      return {
        id: found.name,
        kind: found.kind,
        createdAt: found.createdAt,
        base: found.base,
        cpu: found.cpu,
        ramMib: found.ramMib,
        diskGib: found.diskGib,
        state,
        desired: desiredOf(found),
        phase,
        ...(found.profile === undefined ? {} : { profile: found.profile }),
        ...(found.prebuild === undefined ? {} : { prebuild: found.prebuild }),
        ...(found.error === undefined ? {} : { error: found.error }),
        ...(running && found.port !== undefined && address !== undefined
          ? { ssh: { user: loginUser, host: address, port: found.port } }
          : {}),
        ...(found.hostKey === undefined ? {} : { hostKey: found.hostKey }),
        ...(running && tailnet !== undefined ? { tailnet } : {}),
      };
    };

    const unread = (found: MachineRow) =>
      resource(found, "unknown", phaseOf(found.state));

    const shown = (found: MachineRow, state: MachineState) =>
      resource(found, state, phaseShown(found, state));

    const others = (found: MachineRow) =>
      Effect.map(store.machines, (rows) => {
        const onHost = rows.filter(
          ({ host, name }) => host === found.host && name !== found.name
        );

        return {
          machines: onHost.flatMap((other) => {
            const ref = refOf(other);

            return ref === undefined ? [] : [ref];
          }),
          ports: onHost.flatMap(({ port }) =>
            port === undefined ? [] : [port]
          ),
        };
      });

    const sourceStep = (found: MachineRow) =>
      Effect.gen(function* () {
        const { source } = found;

        if (source.kind === "base") {
          return { _tag: "base", base: found.base } as const;
        }

        if (source.kind === "machine") {
          const from = yield* store.findMachine(source.name);
          const ref = Option.flatMapNullishOr(from, refOf);

          return Option.isSome(ref) && Option.isSome(from)
            ? ({
                _tag: "machine",
                machine: ref.value,
                ...pinned(from.value.pin),
              } as const)
            : undefined;
        }

        const from = yield* store.findCheckpoint(source.name);

        return Option.isSome(from) && from.value.phase === "ready"
          ? ({
              _tag: "checkpoint",
              checkpoint: {
                name: from.value.name,
                instance: from.value.instance,
                cpu: from.value.cpu,
                ramMib: from.value.ramMib,
                diskGib: from.value.diskGib,
                port: from.value.port,
              },
              ...pinned(from.value.pin),
            } as const)
          : undefined;
      });

    const stepOf = (
      found: MachineRow,
      op: Operation
    ): Effect.Effect<Step | undefined, Internal> =>
      Effect.gen(function* () {
        const ref = refOf(found);
        const { name, instance } = found;
        const { machines, ports } = yield* others(found);

        if (op.kind === "remove") {
          return { _tag: "remove", machine: { name, instance } };
        }

        if (op.kind === "make") {
          const scripted =
            found.source.kind === "base" && found.source.scripted;

          const setup = scripted ? creates.get(name)?.setup : undefined;
          const source = yield* sourceStep(found);

          if (source === undefined || (scripted && setup === undefined)) {
            return undefined;
          }

          return {
            _tag: "make",
            machine: {
              name,
              instance,
              cpu: found.cpu,
              ramMib: found.ramMib,
              diskGib: found.diskGib,
            },
            source,
            ...(setup === undefined ? {} : { setup }),
            ports,
            machines,
          };
        }

        if (ref === undefined) {
          return undefined;
        }

        switch (op.kind) {
          case "start":
          case "stop": {
            return {
              _tag: op.kind,
              machine: ref,
              seen: op.seen,
              ...pinned(found.pin),
              machines,
            };
          }

          case "pause": {
            return { _tag: "pause", machine: ref, ...pinned(found.pin) };
          }

          case "resize": {
            return {
              _tag: "resize",
              machine: ref,
              to: op.to ?? {},
              machines,
            };
          }

          case "join": {
            return {
              _tag: "join",
              machine: ref,
              hostname: `cbx-${name}`,
            };
          }

          case "capture":
          case "deleteCheckpoint": {
            return undefined;
          }
        }
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

    const collected = (op: Operation) =>
      Effect.andThen(
        operations.collect(op),
        Effect.forEach(op.leases, ({ name }) => wake(name), { discard: true })
      );

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

    const following = (found: MachineRow, op: Operation, latch: Latch.Latch) =>
      Effect.gen(function* () {
        const { name } = found;

        const polled = yield* Effect.raceFirst(
          operations.poll(op, {
            cut: !wants(op.kind, desiredOf(found)),
            step: stepOf(found, op),
          }),
          Effect.as(latch.await, { at: "woken" } as const)
        );

        switch (polled.at) {
          case "woken": {
            return;
          }

          case "running": {
            const { port } = polled.report.outcome;

            if (port !== undefined && found.port !== port) {
              yield* applying(name, { type: "ran", port });
            }

            return;
          }

          case "ended": {
            const { report } = polled;

            const written = yield* stored(
              name,
              reportedBy(found, op, report, yield* DateTime.now)
            );

            if (!written) {
              return;
            }

            if (op.kind === "join") {
              tailnets.set(
                name,
                checked(tailnets.get(name) ?? unchecked, report.outcome.tailnet)
              );
            } else if (op.kind === "start" && report.status === "done") {
              tailnets.set(name, firstCheck);
            }

            return yield* collected(op);
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

            if (!written) {
              return;
            }

            if (op.kind === "resize") {
              yield* sizesRead(found);
            }

            return yield* collected(op);
          }

          case "unreachable": {
            yield* Effect.timeoutOption(latch.await, unreachableWait);
          }
        }
      });

    const outgrownBySource = (found: MachineRow) =>
      Effect.gen(function* () {
        const { source } = found;

        if (source.kind === "base") {
          return undefined;
        }

        const from: Option.Option<Spec> =
          source.kind === "machine"
            ? yield* store.findMachine(source.name)
            : yield* store.findCheckpoint(source.name);

        return Option.isNone(from)
          ? undefined
          : yield* copied(found.name, from.value, found, found.kind).pipe(
              Effect.match({
                onFailure: (refusal) => refusal,
                onSuccess: () => undefined,
              })
            );
      });

    const looking = (found: MachineRow) =>
      Effect.gen(function* () {
        const { name } = found;

        const refused =
          found.state === "making.due"
            ? yield* outgrownBySource(found)
            : undefined;

        if (refused !== undefined) {
          yield* applying(name, { type: "refused", error: refused });

          return "again" as const;
        }

        const seen =
          stageOf(found.state) === "made" ? yield* stateOf(found) : "unknown";

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

        switch (answer.at) {
          case "absent": {
            return "gone" as const;
          }

          case "busy": {
            yield* Effect.sleep(busyWait);

            return "again" as const;
          }

          case "written": {
            if (
              answer.next !== "removed" &&
              answer.next.state === "made.settled"
            ) {
              tailnets.set(name, ticked(check));
            }

            return answer.moved ? ("again" as const) : ("rest" as const);
          }
        }
      }).pipe(
        Effect.catchTag("Unreachable", (error) =>
          Effect.as(Effect.logWarning(error.message), "rest" as const)
        )
      );

    const turn = (name: string, latch: Latch.Latch, rechecked: boolean) =>
      Effect.gen(function* () {
        const present = yield* store.findMachine(name);

        if (Option.isNone(present) || present.value.state === "undone") {
          return "gone" as const;
        }

        const found = present.value;

        switch (activityOf(found.state)) {
          case "read": {
            return yield* looking(found);
          }

          case "follow": {
            const op = yield* Effect.fromOption(
              yield* store.operationOn("machine", name),
              () =>
                new Internal({
                  message: `machine ${name} is at ${found.state} with no operation`,
                })
            );

            yield* following(found, op, latch);

            return "again" as const;
          }

          case "recheck": {
            return rechecked ? yield* looking(found) : ("rest" as const);
          }

          case "none": {
            return "rest" as const;
          }
        }
      });

    const looped = (name: string, latch: Latch.Latch) =>
      Effect.gen(function* () {
        let rechecked = true;

        for (;;) {
          yield* latch.close;

          const at = yield* turn(name, latch, rechecked).pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logError(
                  `machine ${name}'s loop failed, and runs again at the next recheck:\n${Cause.pretty(cause)}`
                ),
                "rest" as const
              )
            )
          );

          if (at === "gone") {
            return;
          }

          rechecked = false;

          if (at === "rest") {
            rechecked = Option.isNone(
              yield* Effect.timeoutOption(latch.await, settings.recheck)
            );
          }
        }
      });

    const drive = (name: string) =>
      Effect.flatMap(Latch.make(false), (latch) => {
        wakes.set(name, latch);

        return looped(name, latch).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (wakes.get(name) === latch) {
                wakes.delete(name);
              }
            })
          )
        );
      });

    const driven = (name: string) =>
      Effect.asVoid(Effect.forkIn(drive(name), scope));

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
        yield* driven(name);

        return unread(created);
      });

    const asked = (name: string, desired: Wish) =>
      Effect.gen(function* () {
        const { next, moved } = yield* recorded(name, {
          type: "ask",
          desired,
        });

        return moved || stageOf(next.state) === "deleting"
          ? unread(next)
          : yield* notFound(name);
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

            if (Option.isSome(found) && found.value.phase === "ready") {
              prebuilds.set(host.id, prebuilt);
            }
          }
        }

        const candidates = preferring(placed, new Set(prebuilds.keys())).map(
          ({ id }): Candidate => {
            const prebuilt = prebuilds.get(id);

            return {
              host: id,
              source:
                prebuilt === undefined
                  ? { kind: "base", scripted: setup !== undefined }
                  : { kind: "checkpoint", name: prebuilt },
              prebuild: prebuilt,
            };
          }
        );

        const [first, ...untried] = candidates;
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
        const info = yield* hosts
          .read(host)
          .pipe(
            Effect.mapError(
              ({ message }) => new Unavailable({ message, readOnly: true })
            )
          );

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
        const stage = stageOf(from.state);

        if (stage !== "made" && stage !== "deleting") {
          return yield* unmade(from);
        }

        const info = yield* hosts
          .read(from.host)
          .pipe(
            Effect.mapError(
              ({ message }) => new Unavailable({ message, readOnly: true })
            )
          );

        return yield* born(
          name,
          yield* copied(name, from, sizing, from.kind),
          {
            host: from.host,
            source: { kind: "machine", name: id },
            prebuild: undefined,
          },
          info,
          false,
          { setup: undefined, untried: [] }
        );
      });

    const restore = (checkpoint: string, name: string, sizing?: Sizing) =>
      Effect.gen(function* () {
        const present = yield* store.findCheckpoint(checkpoint);

        if (Option.isNone(present) || present.value.phase !== "ready") {
          return yield* new NotFound({
            message: `no checkpoint ${checkpoint}`,
            id: checkpoint,
          });
        }

        const record = present.value;

        const info = yield* hosts
          .read(record.host)
          .pipe(
            Effect.mapError(
              ({ message }) => new Unavailable({ message, readOnly: true })
            )
          );

        return yield* born(
          name,
          yield* copied(name, record, sizing, info.kind),
          {
            host: record.host,
            source: { kind: "checkpoint", name: checkpoint },
            prebuild: undefined,
          },
          info,
          false,
          { setup: undefined, untried: [] }
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
          ? unread(next)
          : yield* unmade(next);
      });

    const remove = (name: string) =>
      Effect.flatMap(applying(name, { type: "delete" }), (answer) =>
        answer.at === "absent" ? Effect.fail(notFound(name)) : wake(name)
      );

    const capacity = Effect.gen(function* () {
      const reached = yield* hosts.reachAll;
      const rows = yield* store.machines;
      const unreachable: string[] = [];

      const usage = yield* Effect.forEach(
        reached,
        ({ member }) =>
          hosts
            .call(member.id, (api) =>
              api.readCapacity({
                machines: rows.flatMap((found) => {
                  const ref =
                    found.host === member.id ? refOf(found) : undefined;

                  return ref === undefined ? [] : [ref];
                }),
              })
            )
            .pipe(
              Effect.map((readings) =>
                readings.map((reading): Usage => ({
                  host: member.id,
                  ...reading,
                }))
              ),
              Effect.catchTag("Unreachable", () =>
                Effect.sync((): Usage[] => {
                  unreachable.push(member.id);

                  return [];
                })
              )
            ),
        { concurrency: "unbounded" }
      );

      return { usage: usage.flat(), unreachable };
    });

    const adopted = (host: string, boot: string) =>
      Effect.gen(function* () {
        const known = yield* store.hostBoot(host);

        if (Option.contains(known, boot)) {
          return;
        }

        const rows = yield* store.machines;

        yield* hosts.call(host, (api) =>
          api.adoptMachines({
            machines: rows.flatMap((found) => {
              const ref =
                found.host === host && stageOf(found.state) === "made"
                  ? refOf(found)
                  : undefined;

              return ref === undefined ? [] : [ref];
            }),
          })
        );

        yield* store.recordBoot(host, boot);
      });

    const tick = Effect.gen(function* () {
      const reached = yield* hosts.reachAll;

      yield* Effect.forEach(
        reached,
        ({ member, info }) =>
          info === undefined
            ? Effect.void
            : adopted(member.id, info.boot).pipe(
                Effect.catchTag("Unreachable", (error) =>
                  Effect.logWarning(error.message)
                )
              ),
        { discard: true }
      );

      const before = DateTime.subtractDuration(
        yield* DateTime.now,
        settings.failedRowsLast
      );

      yield* store.expire(before);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`the recheck failed:\n${Cause.pretty(cause)}`)
      )
    );

    const rest = (name: string) =>
      Effect.gen(function* () {
        for (;;) {
          const found = yield* store.findMachine(name);

          if (Option.isNone(found)) {
            return found;
          }

          if (activityOf(found.value.state) !== "follow") {
            const phase = phaseShown(found.value, yield* stateOf(found.value));

            if (phase === "waiting") {
              return yield* new Unavailable({
                message: `machine ${name}'s host can't be reached`,
                readOnly: true,
              });
            }

            if (isResting(phase)) {
              return found;
            }
          }

          yield* Effect.sleep(restPoll);
        }
      });

    yield* tick;

    for (const found of yield* store.machines) {
      if (found.ephemeral) {
        yield* applying(found.name, { type: "delete" });
      }

      if (found.state !== "undone") {
        yield* driven(found.name);
      }
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

        const states = yield* readStates(rows);

        return rows.map((found) => shown(found, stateIn(found, states)));
      }).pipe(Effect.withSpan("Machines.list")),
      get: Effect.fn("Machines.get")((id) =>
        Effect.flatMap(row(id), (found) =>
          Effect.map(stateOf(found), (state) => shown(found, state))
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
      capacity: capacity.pipe(Effect.withSpan("Machines.capacity")),
      wake,
      rest,
    } satisfies Interface;
  });

export const layer = (
  settings: Settings
): Layer.Layer<Machines, Internal, Store | Hosts | Operations> =>
  Layer.effect(Machines, make(settings));
