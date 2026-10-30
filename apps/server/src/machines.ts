import type {
  HostInfo,
  MachineRef,
  MachineState,
  Step,
} from "@clankerbox/host-contract";
import {
  checkpointKinds,
  formatGib,
  formatMib,
  Internal,
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
  Desired,
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

import { Hosts } from "./hosts.ts";
import { Operations } from "./operations.ts";
import { placing, preferring } from "./placement.ts";
import { nameOf } from "./prebuilds.ts";
import { cuts, holds, lost, next as nextFrom, settled } from "./reconcile.ts";
import type { Next, Patch } from "./reconcile.ts";
import { Store } from "./store.ts";
import type { Lease, Operation, Row, RowPatch, Source } from "./store.ts";
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
  /** Waits until a machine rests or is gone, for a prebuild's own steps. */
  readonly rest: (name: string) => Effect.Effect<Option.Option<Row>, Internal>;
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

const stepPhases = {
  creating: "make",
  starting: "start",
  stopping: "stop",
  pausing: "pause",
  resizing: "resize",
  deleting: "remove",
} as const satisfies Partial<Record<Next, Operation["kind"]>>;

type Stepped = keyof typeof stepPhases;

const isStep = (target: Next): target is Stepped => target in stepPhases;

const phaseOfKind: Partial<Record<Operation["kind"], Machine["phase"]>> = {
  make: "creating",
  start: "starting",
  stop: "stopping",
  pause: "pausing",
  resize: "resizing",
  remove: "deleting",
};

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

const refOf = (row: Row): MachineRef | undefined =>
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

const nextOf = (found: Row, seen: MachineState): Next =>
  nextFrom({ ...found, resizing: found.resize !== undefined }, seen);

const pinned = (pin: string | undefined) => (pin === undefined ? {} : { pin });

const leasesOf = (found: Row, kind: Operation["kind"]): readonly Lease[] => {
  const self: Lease = {
    resource: "machine",
    name: found.name,
    mode: kind === "join" ? "share" : "own",
  };

  if (kind !== "make" || found.source.kind === "base") {
    return [self];
  }

  return [
    self,
    {
      resource: found.source.kind,
      name: found.source.name,
      mode: "share",
    },
  ];
};

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

const made = (found: Row) =>
  found.stage === "made"
    ? Effect.void
    : Effect.fail(
        new NotMade({
          message: `machine ${found.name} isn't made yet: its create or setup still runs`,
          machine: found.name,
        })
      );

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

    const notFailedCreate = (name: string) =>
      row(name).pipe(
        Effect.filterOrFail(
          ({ stage }) => stage === "making" || stage === "made",
          () => notFound(name)
        )
      );

    const readStates = (rows: readonly Row[]) =>
      Effect.gen(function* () {
        const groups = Map.groupBy(
          rows.filter(({ stage }) => stage !== "undone"),
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

    const stateOf = (found: Row) =>
      Effect.map(
        readStates([found]),
        (states): MachineState => states.get(found.name) ?? "unknown"
      );

    const resource = (found: Row, state: MachineState): Machine => {
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
        desired: found.desired,
        phase: found.phase,
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

    const shown = (found: Row) =>
      Effect.map(readStates([found]), (states) =>
        resource(
          found,
          found.stage === "undone"
            ? "missing"
            : (states.get(found.name) ?? "unknown")
        )
      );

    const others = (found: Row) =>
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

    const sourceStep = (found: Row) =>
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
      found: Row,
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
          const setup = creates.get(name)?.setup;
          const source = yield* sourceStep(found);

          if (source === undefined || (found.scripted && setup === undefined)) {
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
              to: found.resize ?? {},
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

    const begin = (
      found: Row,
      kind: Operation["kind"],
      seen: MachineState,
      phase: Machine["phase"] | undefined
    ) =>
      Effect.gen(function* () {
        const info = yield* hosts.read(found.host);

        const begun = yield* store.begin(
          {
            id: newId(),
            kind,
            resource: "machine",
            name: found.name,
            host: found.host,
            boot: info.boot,
            generation: found.generation,
            seen,
            leases: leasesOf(found, kind),
          },
          phase,
          kind === "start" && seen === "stopped" ? { pin: info.pin } : {}
        );

        if (Option.isNone(begun)) {
          yield* Effect.sleep(busyWait);
        }

        return "again" as const;
      }).pipe(
        Effect.catchTag("Unreachable", (error) =>
          Effect.logWarning(error.message).pipe(
            Effect.andThen(
              store.patch(found.name, found.generation, { phase: "waiting" })
            ),
            Effect.as("rest" as const)
          )
        )
      );

    const movedPastCapacity = (found: Row): RowPatch | undefined => {
      const held = creates.get(found.name);
      const [candidate, ...untried] = held?.untried ?? [];
      const info = hosts.known(candidate?.host ?? "");

      if (
        held === undefined ||
        candidate === undefined ||
        info === undefined ||
        found.error?._tag !== "Capacity"
      ) {
        return undefined;
      }

      creates.set(found.name, { setup: held.setup, untried });

      return {
        stage: "making",
        host: candidate.host,
        kind: info.kind,
        pin: info.pin,
        source: candidate.source,
        prebuild: candidate.prebuild,
        scripted: candidate.source.kind === "base" && held.setup !== undefined,
        error: undefined,
        port: undefined,
        phase: "observing",
      };
    };

    const ended = (found: Row, op: Operation, patch: Patch | "removed") =>
      Effect.gen(function* () {
        if (patch === "removed") {
          creates.delete(found.name);
          tailnets.delete(found.name);

          return yield* operations.finish(op, { row: "removed" });
        }

        if (op.kind === "join") {
          return yield* operations.finish(op, { row: "kept" });
        }

        if (patch.stage === "undone") {
          const moved = movedPastCapacity(found);

          if (moved === undefined) {
            creates.delete(found.name);
          }

          return yield* operations.finish(op, {
            row: "patch",
            generation: found.generation,
            patch: moved ?? { ...patch, undoneAt: yield* DateTime.now },
          });
        }

        if (patch.stage === "made" && creates.has(found.name)) {
          creates.delete(found.name);
        }

        if (op.kind === "start" && patch.prepared === true) {
          tailnets.set(found.name, firstCheck);
        }

        yield* operations.finish(op, {
          row: "patch",
          generation: found.generation,
          patch,
        });
      }).pipe(
        Effect.andThen(
          Effect.forEach(op.leases, ({ name }) => wake(name), { discard: true })
        )
      );

    const sizesRead = (found: Row) => {
      const ref = refOf(found);

      return ref === undefined
        ? Effect.void
        : hosts
            .call(found.host, (api) => api.readSizes({ machine: ref }))
            .pipe(
              Effect.flatMap((read) =>
                store.patch(found.name, found.generation, {
                  cpu: read.cpu ?? found.cpu,
                  ramMib: read.ramMib ?? found.ramMib,
                  diskGib: read.diskGib ?? found.diskGib,
                })
              ),
              Effect.catchTag("Unreachable", (error) =>
                Effect.logWarning(
                  `couldn't read the sizes of ${found.name}, so it keeps those it has: ${error.message}`
                )
              )
            );
    };

    const follow = (found: Row, op: Operation, latch: Latch.Latch) =>
      Effect.gen(function* () {
        const doing = phaseOfKind[op.kind];

        if (doing !== undefined && found.phase === "observing") {
          yield* store.patch(found.name, found.generation, { phase: doing });
        }

        const polled = yield* Effect.raceFirst(
          operations.poll(op, {
            cut: cuts(found, op),
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

            const resting =
              doing !== undefined && found.phase === "waiting"
                ? { phase: doing }
                : {};

            if (
              (port !== undefined && found.port !== port) ||
              "phase" in resting
            ) {
              yield* store.patch(found.name, found.generation, {
                ...(port === undefined ? {} : { port }),
                ...resting,
              });
            }

            return;
          }

          case "ended": {
            if (op.kind === "join") {
              tailnets.set(
                found.name,
                checked(
                  tailnets.get(found.name) ?? unchecked,
                  polled.report.outcome.tailnet
                )
              );
            }

            return yield* ended(found, op, settled(found, op, polled.report));
          }

          case "lost": {
            yield* Effect.logWarning(
              `machine ${found.name}'s ${op.kind} is gone from host ${op.host}`
            );

            yield* ended(
              found,
              op,
              lost(
                found,
                op,
                new Internal({
                  message: `the ${op.kind} of machine ${found.name} ended before its host reported it: its host restarted, or the setup left with a restart of the control plane`,
                })
              )
            );

            if (op.kind === "resize") {
              yield* sizesRead(found);
            }

            return;
          }

          case "unreachable": {
            if (found.phase !== "waiting" && op.kind !== "join") {
              yield* Effect.logWarning(polled.error.message);
              yield* store.patch(found.name, found.generation, {
                phase: "waiting",
              });
            }

            yield* Effect.timeoutOption(latch.await, unreachableWait);
          }
        }
      });

    const joining = (found: Row, seen: MachineState) =>
      Effect.gen(function* () {
        const check = tailnets.get(found.name) ?? firstCheck;

        if (
          seen !== "running" ||
          found.ephemeral ||
          !due(check) ||
          hosts.known(found.host)?.joins !== true
        ) {
          tailnets.set(found.name, ticked(check));

          return "rest" as const;
        }

        return yield* begin(found, "join", seen, undefined);
      });

    const outgrownBySource = (found: Row) =>
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

    const advance = (name: string, latch: Latch.Latch, rechecked: boolean) =>
      Effect.gen(function* () {
        const present = yield* store.findMachine(name);

        if (Option.isNone(present)) {
          return "gone" as const;
        }

        const found = present.value;
        const inFlight = yield* store.operationOn("machine", name);

        if (Option.isSome(inFlight)) {
          yield* follow(found, inFlight.value, latch);

          return "again" as const;
        }

        if (found.stage === "undone") {
          return "gone" as const;
        }

        if (holds(found) || (found.phase === "failed" && !rechecked)) {
          return "rest" as const;
        }

        const seen =
          found.stage === "made" && found.desired !== "deleted"
            ? yield* stateOf(found)
            : "unknown";

        const target = nextOf(found, seen);

        const refused =
          target === "creating" ? yield* outgrownBySource(found) : undefined;

        if (refused !== undefined) {
          yield* store.patch(name, found.generation, {
            stage: "undoing",
            error: refused,
            phase: "observing",
          });

          return "again" as const;
        }

        if (isStep(target)) {
          return yield* begin(found, stepPhases[target], seen, target);
        }

        const rested = yield* store.patch(name, found.generation, {
          phase: target,
        });

        return rested && target === "settled"
          ? yield* joining(found, seen)
          : ("rest" as const);
      });

    const looped = (name: string, latch: Latch.Latch) =>
      Effect.gen(function* () {
        let rechecked = false;

        for (;;) {
          yield* latch.close;

          const at = yield* advance(name, latch, rechecked).pipe(
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
        const created: Row = {
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
          generation: 1,
          phase: "observing",
          stage: "making",
          prepared: false,
          error: undefined,
          resize: undefined,
          ephemeral,
          source: placed.source,
          scripted: placed.source.kind === "base" && held.setup !== undefined,
          prebuild: placed.prebuild,
          hostKey: undefined,
          pin: info.pin,
          undoneAt: undefined,
        };

        yield* store.insertMachine(created);
        creates.set(name, held);
        yield* driven(name);

        return resource(created, "unknown");
      });

    const asked = (name: string, desired: Exclude<Desired, "deleted">) =>
      Effect.gen(function* () {
        yield* notFailedCreate(name);

        const recorded = yield* store.desire(name, desired);

        yield* wake(name);

        return yield* Effect.fromOption(recorded, () => notFound(name));
      }).pipe(Effect.map((recorded) => resource(recorded, "unknown")));

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
                  ? { kind: "base" }
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
          { host, source: { kind: "base" }, prebuild: undefined },
          info,
          true,
          { setup: request.setup, untried: [] }
        );
      });

    const fork = (id: string, name: string, sizing?: Sizing) =>
      Effect.gen(function* () {
        const from = yield* notFailedCreate(id);

        yield* made(from);

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

        yield* made(yield* notFailedCreate(id));

        const recorded = yield* store.resize(id, sizing);

        yield* wake(id);

        return resource(
          yield* Effect.fromOption(recorded, () => notFound(id)),
          "unknown"
        );
      });

    const remove = (name: string) =>
      Effect.gen(function* () {
        const found = yield* row(name);

        if (found.stage === "undone") {
          return yield* store.removeMachine(name);
        }

        yield* store.desire(name, "deleted");
        yield* wake(name);
      });

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
                found.host === host && found.stage === "made"
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
          const inFlight = yield* store.operationOn("machine", name);

          if (Option.isNone(found)) {
            return found;
          }

          if (
            Option.isNone(inFlight) &&
            ["settled", "failed", "lost", "waiting"].includes(found.value.phase)
          ) {
            return found;
          }

          yield* Effect.sleep(restPoll);
        }
      });

    yield* tick;

    for (const found of yield* store.machines) {
      if (found.ephemeral && found.desired !== "deleted") {
        yield* store.desire(found.name, "deleted");
      }

      if (found.stage !== "undone") {
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

        return rows.map((found) =>
          resource(
            found,
            found.stage === "undone"
              ? "missing"
              : (states.get(found.name) ?? "unknown")
          )
        );
      }).pipe(Effect.withSpan("Machines.list")),
      get: Effect.fn("Machines.get")((id) => Effect.flatMap(row(id), shown)),
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
