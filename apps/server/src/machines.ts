import type { HostInfo, MachineState, Report } from "@clankerbox/host-contract";
import {
  newId,
  pinRefusal,
  resizeRefusal,
} from "@clankerbox/host-contract/traits";
import {
  buildId,
  execWait,
  isResting,
  labelledWith,
  NotBuilt,
  NotFound,
  NotMade,
  readTimeout,
  templateRef,
  Unavailable,
  sizedBy,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  CreateRequest,
  Declared,
  Executed,
  ExecRequest,
  ForkRequest,
  HostError,
  Labels,
  ListFilter,
  Machine,
  ResizeRequest,
  RestoreRequest,
  Setup,
  Sizing,
  Internal,
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
import type { Array as Arr, Scope } from "effect";

import { applied } from "./chart.ts";
import {
  checkpointChart,
  fromBuild,
  phaseOf as checkpointPhaseOf,
} from "./checkpoint-chart.ts";
import type { CheckpointRow } from "./checkpoint-chart.ts";
import {
  cloned,
  copied,
  refusedBySource,
  restingAs,
  uncopiable,
} from "./copies.ts";
import type { Spec } from "./copies.ts";
import { driver, untilRest } from "./driver.ts";
import type { Heard } from "./driver.ts";
import { capacity, recheckHosts, sweep } from "./fleet.ts";
import type { CapacityRead, Swept } from "./fleet.ts";
import { answering, Hosts } from "./hosts.ts";
import {
  activityOf,
  desiredOf,
  machineChart,
  phaseOf,
  toldNewReach,
  stageOf,
  wants,
} from "./machine-chart.ts";
import type { MachineEvent, MachineRow, Move, Wish } from "./machine-chart.ts";
import {
  machineOf,
  phaseShown,
  seenOf,
  readStates,
  stateIn,
  stateOf,
} from "./machine-view.ts";
import type { Seen } from "./machine-view.ts";
import {
  collect,
  cutShort,
  poll,
  unreported,
  Unsendable,
} from "./operations.ts";
import { builtUnder, holding, placing, unjoinedCopy } from "./placement.ts";
import type { BuiltUnder, Candidate } from "./placement.ts";
import { machineStep, refOf } from "./steps.ts";
import { madeOn, notFound, readUntil, Store } from "./store.ts";
import type {
  Interface as StoreInterface,
  Operation,
  TemplateRow,
} from "./store.ts";
import {
  checked,
  due,
  firstCheck,
  started,
  Tailnet,
  ticked,
  unchecked,
  unserved,
} from "./tailnet.ts";
import type { TailnetCheck } from "./tailnet.ts";

export interface Settings {
  readonly recheck: Duration.Duration;
  readonly failedRowsLast: Duration.Duration;
  readonly authorizedKeys: string;
  readonly hookTimeoutSeconds: number;
}

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
  /**
   * A machine for a template's build to capture, deleted if the control plane restarts: on the
   * first of `hosts`, and on `Capacity` on the next, as a create moves. `sending` is told each host
   * its make is sent to, as the read that sends it found that host, before the make goes.
   */
  readonly build: (
    name: string,
    spec: Spec & { readonly setup: Setup },
    hosts: Arr.NonEmptyReadonlyArray<HostInfo>,
    sending: (host: HostInfo) => Effect.Effect<void, Internal>
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
   * its row rests, and answers that row, failing with its error. A host that can't be reached for a
   * whole recheck ends the wait as `Unavailable`, whatever step the machine is in.
   */
  readonly rest: (
    name: string
  ) => Effect.Effect<Option.Option<MachineRow>, HostError>;
}

export class Machines extends Context.Service<Machines, Interface>()(
  "@clankerbox/server/Machines"
) {}

/**
 * What a machine asked to run rests failed with once its runtime stopped it unasked: the caller
 * must start it, as nothing else will, and its runtime's cause where it named one.
 */
export const stoppedUnasked = (machine: string, why: string | undefined) =>
  new WrongState({
    message: `${machine} was stopped by its runtime, not by a request${why === undefined ? ", and the runtime gave no cause" : `: ${why}`}. Its memory and processes are gone, and nothing will start it again: start it to boot it cold`,
    machine,
    state: "stopped",
  });

const movesOn = (error: MachineRow["error"]): boolean =>
  error?._tag === "Capacity" ||
  (error?._tag === "Missing" && error.checkpoint !== undefined);

interface CreateHeldInMemory {
  readonly setup: Setup | undefined;
  readonly untried: readonly Candidate[];
  readonly sending?: (host: HostInfo) => Effect.Effect<void, Internal>;
}

type TemplateCreate = Extract<CreateRequest, { readonly template: string }>;

type BaseCreate = Exclude<CreateRequest, TemplateCreate>;

const readyBuild = (
  found: Option.Option<TemplateRow>,
  { template, number }: ReturnType<typeof templateRef>
): Result.Result<BuiltUnder, NotBuilt> => {
  const builds = Option.match(found, {
    onNone: () => [],
    onSome: (row) => row.builds,
  });

  const ready = builds.filter(({ phase }) => phase === "ready");

  const build =
    number === undefined
      ? ready.at(-1)
      : ready.find((each) => each.number === number);

  if (build !== undefined) {
    return Result.succeed(builtUnder(template, build));
  }

  const asked =
    number === undefined
      ? builds.at(-1)
      : builds.find((each) => each.number === number);

  const kept = ready.map((each) => buildId(template, each.number));

  const why = [
    ...(asked === undefined
      ? []
      : [
          asked.phase === "building"
            ? `${buildId(template, asked.number)} is still building`
            : `${buildId(template, asked.number)} failed: ${asked.error?.message ?? "its build ended"}`,
        ]),
    kept.length === 0
      ? `run clankerbox template build on ${template}'s template file to make one`
      : `its ready builds are ${kept.join(", ")}`,
  ];

  return Result.fail(
    new NotBuilt({
      message: `template ${template} has no ready build${number === undefined ? "" : ` ${buildId(template, number)}`}: ${why.join("; ")}`,
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

const absent = ({ name, state, error }: MachineRow): NotFound => {
  switch (stageOf(state)) {
    case "undoing": {
      return new NotFound({
        message: `machine ${name}'s create failed, and is being undone: ${error?.message ?? "it ended"}`,
        id: name,
      });
    }

    case "undone": {
      return new NotFound({
        message: `machine ${name}'s create failed, so there is no machine ${name}: ${error?.message ?? "it ended"}; delete it, or create it again`,
        id: name,
      });
    }

    case "deleting": {
      return new NotFound({
        message: `machine ${name} is being deleted`,
        id: name,
      });
    }

    case "making":
    case "made": {
      return notFound("machine", name);
    }
  }
};

const unmade = (found: MachineRow): NotMade | NotFound =>
  stageOf(found.state) === "making"
    ? new NotMade({
        message: `machine ${found.name} isn't made yet: its create or setup still runs`,
        machine: found.name,
      })
    : absent(found);

export const madeMachine = (
  store: StoreInterface,
  name: string
): Effect.Effect<MachineRow, NotMade | NotFound | Internal> =>
  Effect.gen(function* () {
    const found = yield* store.findMachine(name);

    if (Option.isNone(found)) {
      return yield* notFound("machine", name);
    }

    if (stageOf(found.value.state) !== "made") {
      return yield* unmade(found.value);
    }

    return found.value;
  });

const restorable = (
  name: string,
  found: Option.Option<CheckpointRow>
): Result.Result<CheckpointRow, NotMade | NotFound> => {
  if (Option.isNone(found) || fromBuild(found.value)) {
    return Result.fail(notFound("checkpoint", name));
  }

  const record = found.value;

  switch (checkpointPhaseOf(record.state)) {
    case "ready": {
      return Result.succeed(record);
    }

    case "capturing": {
      return Result.fail(
        new NotMade({
          message: `checkpoint ${name} isn't made yet: its capture still runs`,
          checkpoint: name,
        })
      );
    }

    case "failed": {
      return Result.fail(
        new NotFound({
          message: `checkpoint ${name} failed, so nothing restores it: ${record.error?.message ?? "its capture ended"}; delete it`,
          id: name,
        })
      );
    }

    case "deleting": {
      return Result.fail(
        new NotFound({
          message: `checkpoint ${name} is being deleted`,
          id: name,
        })
      );
    }
  }
};

export const make = (
  settings: Settings
): Effect.Effect<Interface, Internal, Store | Hosts | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const hosts = yield* Hosts;
    const scope = yield* Effect.scope;

    const creates = new Map<string, CreateHeldInMemory>();
    const readings = new Map<string, Swept & { readonly taken: number }>();
    const tailnets = new Map<string, TailnetCheck>();
    const tailnet = yield* Effect.serviceOption(Tailnet);

    const minting = (
      key: (minter: Tailnet["Service"]) => Tailnet["Service"]["mint"]
    ) =>
      Option.match(tailnet, {
        onNone: () =>
          Effect.fail(
            new Unsendable({
              why: "the control plane has no tailnet in its config",
            })
          ),
        onSome: (minter) =>
          key(minter).pipe(
            Effect.mapError(
              ({ message }) =>
                new Unsendable({
                  why: `the control plane couldn't mint a tailnet key: ${message}`,
                })
            )
          ),
      });

    const mint = minting((minter) => minter.mint);
    const mintBuild = minting((minter) => minter.mintBuild);

    const row = (name: string) =>
      Effect.flatMap(store.findMachine(name), (found) =>
        Effect.fromOption(found, () => notFound("machine", name))
      );

    const applying = (name: string, event: MachineEvent) =>
      store.advance("machine", name, (found, op) =>
        applied(machineChart, found, event, op)
      );

    const shown = (found: MachineRow, seen?: MachineState) =>
      machineOf(found, seen, tailnets.get(found.name)?.status);

    const movedOn = (found: MachineRow): Move | undefined => {
      const [candidate] = creates.get(found.name)?.untried ?? [];
      const info = hosts.known(candidate?.host ?? "");

      return candidate === undefined ||
        info === undefined ||
        !movesOn(found.error)
        ? undefined
        : {
            host: candidate.host,
            instance: newId(),
            ...madeOn(info.traits),
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

      const move = op.kind === "remove" ? movedOn(found) : undefined;

      return {
        type: "reported",
        status: "done",
        outcome,
        at,
        ...(move === undefined ? {} : { move }),
      };
    };

    const sourceLost = (
      host: string,
      error: Report["error"],
      at: DateTime.Utc
    ) =>
      error?._tag === "Missing" && error.checkpoint !== undefined
        ? Effect.asVoid(
            store.advance("checkpoint", error.checkpoint, (record, held) =>
              applied(
                checkpointChart,
                record,
                { type: "missing", host, error, at },
                held
              )
            )
          )
        : Effect.void;

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
          creates.set(name, { ...held, untried: held.untried.slice(1) });
        } else if (next.state === "undone" || stageOf(next.state) === "made") {
          creates.delete(name);
        }

        return true;
      });

    const sizesRead = (found: MachineRow) =>
      hosts
        .call(found.host, (api) => api.readSizes({ machine: refOf(found) }))
        .pipe(
          Effect.matchEffect({
            onFailure: ({ message }) =>
              Effect.logWarning(
                `couldn't read the sizes of ${found.name}, so it keeps those it has: ${message}`
              ),
            onSuccess: (sizing) =>
              Effect.asVoid(applying(found.name, { type: "sized", sizing })),
          })
        );

    const following = (found: MachineRow, op: Operation, heard: Heard) =>
      Effect.gen(function* () {
        const { name } = found;

        switch (heard.at) {
          case "running": {
            const { handle, endpoint } = heard.report.outcome;

            const reach = {
              ...(handle === undefined ? {} : { handle }),
              ...(endpoint === undefined ? {} : { endpoint }),
            };

            if (toldNewReach(found, reach)) {
              yield* applying(name, { type: "ran", ...reach });
            }

            return;
          }

          case "ended": {
            const { report } = heard;

            const at = yield* DateTime.now;

            const written = yield* stored(
              name,
              reportedBy(found, op, report, at)
            );

            if (written && op.kind === "make") {
              yield* sourceLost(found.host, report.error, at);
            }

            if (written && (op.kind === "start" || op.kind === "make")) {
              tailnets.set(name, started);
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
              error: unreported(op, heard.why),
            });

            if (written && op.kind === "resize") {
              yield* sizesRead(found);
            }

            if (written && op.kind === "join") {
              tailnets.set(
                name,
                checked(tailnets.get(name) ?? unchecked, {
                  state: "failed",
                  error: heard.why,
                })
              );
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

    const sweptSince = (found: MachineRow, rested: number | undefined) => {
      const swept = rested === undefined ? undefined : readings.get(found.name);

      return swept !== undefined &&
        rested !== undefined &&
        swept.taken > rested &&
        swept.host === found.host
        ? swept
        : undefined;
    };

    const looking = (found: MachineRow, rested: number | undefined) =>
      Effect.gen(function* () {
        const { name } = found;
        const swept = sweptSince(found, rested);
        const info = swept?.info ?? (yield* hosts.read(found.host));

        const refused =
          found.state === "making.due"
            ? yield* refusedBySource(store, found, info.traits)
            : undefined;

        if (refused !== undefined) {
          return yield* applying(name, { type: "refused", error: refused });
        }

        const heard: Seen =
          stageOf(found.state) === "made"
            ? (swept?.heard ?? (yield* seenOf(hosts, found)))
            : { seen: "unknown" };

        const { seen } = heard;

        const check = tailnets.get(name) ?? firstCheck;

        const answer = yield* applying(name, {
          type: "read",
          seen,
          boot: info.boot,
          pin: info.pin,
          id: newId(),
          joins:
            seen === "running" &&
            found.tailnet &&
            !found.ephemeral &&
            due(check),
          awaiting:
            found.desired === "paused" &&
            found.after !== undefined &&
            (yield* unbegun(found.after)),
          at: yield* DateTime.now,
          reboot: heard.reboot,
          why: heard.why,
          stoppedUnasked: stoppedUnasked(name, heard.why),
        });

        if (answer.at === "written" && answer.next !== "removed") {
          if (answer.next.state === "made.settled") {
            tailnets.set(name, ticked(check));
          }

          const sending = creates.get(name)?.sending;

          if (answer.next.state === "making.sent" && sending !== undefined) {
            yield* sending(info);
          }
        }

        return answer;
      });

    const { drive, reading, rechecking } = yield* driver(
      settings.recheck,
      {
        kind: "machine",
        find: store.findMachine,
        store,
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
              settings.authorizedKeys,
              {
                mint,
                mintBuild,
                keyed: (tailnets.get(found.name) ?? firstCheck).keyed,
              },
              settings.hookTimeoutSeconds
            ),
          }),
        following,
      },
      true
    );

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
          ...madeOn(info.traits),
          base: spec.base,
          cpu: spec.cpu,
          ramMib: spec.ramMib,
          diskGib: spec.diskGib,
          labels,
          host: placed.host,
          handle: undefined,
          endpoint: undefined,
          desired: "running",
          state: "making.due",
          prepared: false,
          error: undefined,
          resize: undefined,
          ephemeral: ephemeral === true,
          tailnet: spec.tailnet,
          source: placed.source,
          template,
          hostKey: undefined,
          pin: info.pin,
          undoneAt: undefined,
          after: undefined,
          boots: 0,
          booting: false,
          reboot: undefined,
          unasked: undefined,
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
          : yield* absent(next);
      });

    const copy = (
      name: string,
      made: Made,
      info: HostInfo,
      placed: Candidate
    ) => born(name, made, placed, info, { setup: undefined, untried: [] });

    const fromBase = (request: BaseCreate) =>
      Effect.gen(function* () {
        const {
          id: name,
          labels,
          host,
          runtime,
          tailnet: asks,
          ...sizes
        } = request;

        const refused = unserved(asks, tailnet);

        if (refused !== undefined) {
          return yield* refused;
        }

        const [first, ...rest] = yield* Effect.fromResult(
          placing(yield* hosts.reachAll, sizes.base, runtime, {
            sizes,
            host,
            tailnet: asks === true,
          })
        );

        const spec = { ...sizes, tailnet: asks === true };

        return yield* born(name, { spec, labels }, onBase(first), first, {
          setup: undefined,
          untried: rest.map(onBase),
        });
      });

    const fromTemplate = (request: TemplateCreate) =>
      Effect.gen(function* () {
        const { id: name, template: ref, labels, host, ...sizing } = request;
        const pinned = templateRef(ref);
        const { template } = pinned;

        const made = yield* Effect.fromResult(
          readyBuild(yield* store.findTemplate(template), pinned)
        );

        const build = made.id;

        const records = (yield* store.checkpoints).filter(
          (record) =>
            record.build === build &&
            checkpointPhaseOf(record.state) !== "deleting"
        );

        const byHost = (ready: boolean) =>
          new Map(
            records.flatMap((record) =>
              (record.state === "ready") === ready
                ? [[record.host, record] as const]
                : []
            )
          );

        const [first, ...rest] = yield* Effect.fromResult(
          holding(
            yield* hosts.reachAll,
            byHost(true),
            template,
            made,
            { sizes: sizedBy(made, sizing), host, tailnet: made.tailnet },
            byHost(false)
          )
        );

        const onCopy = ([{ id }, held]: (typeof rest)[number]): Candidate => ({
          host: id,
          source: { kind: "checkpoint", name: held.name },
        });

        const [info, held] = first;

        return yield* born(
          name,
          {
            spec: yield* cloned(name, build, held, sizing, info.traits),
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

    const build: Interface["build"] = (name, spec, [first, ...rest], sending) =>
      born(
        name,
        { spec, labels: undefined, ephemeral: true },
        onBase(first),
        first,
        { setup: spec.setup, untried: rest.map(onBase), sending }
      ).pipe(Effect.asVoid);

    const fork = ({
      machine: id,
      name,
      labels,
      ...sizing
    }: ForkRequest & Sizing) =>
      Effect.gen(function* () {
        const from = yield* madeMachine(store, id);

        const info = yield* answering(hosts, from.host);
        const spec = yield* copied(name, "fork", from, sizing, info.traits);

        const seen = yield* stateOf(hosts, from);

        const refusal =
          unjoinedCopy(info, from, `machine ${id}`) ??
          uncopiable(from, seen, info.traits, "fork") ??
          (seen === "running"
            ? pinRefusal({ copy: id }, from.pin, info.pin)
            : undefined);

        if (refusal !== undefined) {
          return yield* refusal;
        }

        return yield* copy(name, { spec, labels }, info, {
          host: from.host,
          source: { kind: "machine", name: id },
        });
      });

    const restore = ({
      checkpoint,
      name,
      labels,
      ...sizing
    }: RestoreRequest & Sizing) =>
      Effect.gen(function* () {
        const record = yield* Effect.fromResult(
          restorable(checkpoint, yield* store.findCheckpoint(checkpoint))
        );

        const info = yield* answering(hosts, record.host);

        const refusal =
          unjoinedCopy(info, record, `checkpoint ${checkpoint}`) ??
          pinRefusal({ restore: checkpoint }, record.pin, info.pin);

        if (refusal !== undefined) {
          return yield* refusal;
        }

        return yield* copy(
          name,
          {
            spec: yield* copied(name, "restore", record, sizing, info.traits),
            labels,
          },
          info,
          {
            host: record.host,
            source: { kind: "checkpoint", name: checkpoint },
          }
        );
      });

    const stepless = (name: string) =>
      readUntil(
        store,
        "machine",
        name,
        row(name),
        (found) => activityOf(found.state) !== "follow"
      ).pipe(
        Effect.timeoutOrElse({ duration: readTimeout, orElse: () => row(name) })
      );

    const exec = ({ id, ...command }: ExecRequest) =>
      Effect.gen(function* () {
        yield* madeMachine(store, id);

        const found = yield* stepless(id);

        if (stageOf(found.state) !== "made") {
          return yield* unmade(found);
        }

        const ref = refOf(found);

        const { timeoutSeconds } = command;

        return yield* hosts
          .call(
            found.host,
            (api) => api.execMachine({ machine: ref, ...command }),
            execWait(timeoutSeconds)
          )
          .pipe(
            Effect.catchTags({
              Unsent: ({ message }) =>
                new Unavailable({ message, readOnly: true }),
              Unanswered: ({ message }) =>
                new Unavailable({ message, readOnly: false }),
              Incompatible: ({ message }) =>
                new Unavailable({ message, readOnly: false }),
            })
          );
      });

    const resize = (request: ResizeRequest) =>
      Effect.gen(function* () {
        const { id, ...sizing } = request;
        const found = yield* row(id);
        const info = hosts.known(found.host);

        if (info !== undefined && stageOf(found.state) === "made") {
          const refusal = resizeRefusal(
            info.traits,
            id,
            restingAs(found, yield* stateOf(hosts, found)),
            found,
            sizedBy(found, sizing)
          );

          if (refusal !== undefined) {
            return yield* refusal;
          }
        }

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
      Effect.gen(function* () {
        const first = yield* row(id);

        yield* Effect.timeoutOption(
          readUntil(
            store,
            "machine",
            id,
            store.findMachine(id),
            Option.match({
              onNone: () => true,
              onSome: (found: MachineRow) =>
                found.instance !== first.instance ||
                isResting(phaseOf(found.state)),
            })
          ),
          bound
        );
      });

    const read = (id: string) =>
      Effect.flatMap(row(id), (found) =>
        Effect.map(stateOf(hosts, found), (state) => shown(found, state))
      );

    const rest = (name: string) =>
      untilRest(store, "machine", name, settings.recheck, rests(name)).pipe(
        Effect.andThen(store.findMachine(name)),
        Effect.tap((found) =>
          Option.isSome(found) && found.value.error !== undefined
            ? Effect.fail(found.value.error)
            : Effect.void
        )
      );

    const tick = recheckHosts(store, hosts, settings.failedRowsLast);

    const sweeping = Effect.gen(function* () {
      const taken = yield* reading;

      const resting = (yield* store.machines).filter(
        ({ state }) => activityOf(state) === "recheck"
      );

      yield* sweep(hosts, resting, (found, swept) =>
        Effect.andThen(
          Effect.sync(() => readings.set(found.name, { ...swept, taken })),
          rechecking(found.name, taken)
        )
      );

      for (const [name, swept] of readings) {
        if (swept.taken < taken) {
          readings.delete(name);
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`the sweep failed:\n${Cause.pretty(cause)}`)
      )
    );

    yield* tick;

    for (const found of yield* store.machines) {
      if (found.ephemeral) {
        yield* applying(found.name, { type: "delete" });
      }

      yield* drive(found.name);
    }

    yield* Effect.forkIn(
      Effect.forever(
        Effect.andThen(
          sweeping,
          Effect.andThen(Effect.sleep(settings.recheck), tick)
        )
      ),
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
