import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Capacity,
  Conflict,
  Internal,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  HostError,
  Reading,
  Sizing,
  Missing,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { Hex } from "effect/encoding";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";

import { CannotStart, missing, Runtime, timeoutFail } from "../../runtime.ts";
import type {
  Command,
  Execution,
  Handle,
  Identity,
  Interface,
  MachineState,
  Observed,
  Origin,
  Sizes,
  Target,
} from "../../runtime.ts";
import { KeyedApiUrl } from "../../settings.ts";
import type { HostSettings } from "../../settings.ts";
import { sentUntilHeld, triesAfterLoss, untilRest } from "../provider-http.ts";
import * as Api from "./api.ts";
import type { ApiError, MachineRecord, Refused } from "./api.ts";
import { traits } from "./traits.ts";
import { tunnel } from "./tunnel.ts";

export const defaultApi = "https://api.smolmachines.com";

export const SmolCloudSettings = Schema.Struct({
  apiKeyFile: Schema.String.check(Schema.isNonEmpty()),
  api: Schema.optionalKey(KeyedApiUrl),
  ttlSeconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export type SmolCloudSettings = typeof SmolCloudSettings.Type;

/** The provider caps a name at 63 characters, which `cbx-`, a host ID of this length and an instance fill. */
export const longestHostId = 26;

const idleStopSeconds = 86_400;

const bodyLimit = 1024 * 1024;

const unstageTimeout = Duration.seconds(30);

const stepTimeout = Duration.minutes(10);

const poll = Duration.seconds(1);

const instancePattern = /^[0-9a-f]{32}$/u;

type Goal = "running" | "stopped" | "paused" | "gone";

type Move = Api.Verb | "delete" | "wait" | "done" | "stuck" | "missing";

const moves: Readonly<Record<Goal, Readonly<Record<string, Move>>>> = {
  running: {
    started: "done",
    running: "done",
    stopped: "start",
    created: "start",
    paused: "resume",
    missing: "missing",
    deleted: "missing",
  },
  stopped: {
    started: "stop",
    running: "stop",
    stopped: "done",
    created: "done",
    paused: "resume",
    missing: "done",
    deleted: "done",
  },
  paused: {
    started: "pause",
    running: "pause",
    stopped: "done",
    created: "done",
    paused: "done",
    missing: "missing",
    deleted: "missing",
  },
  gone: { missing: "done", deleted: "done" },
};

const transitional = new Set(["creating", "pausing", "starting", "stopping"]);

const checkpointEnds = new Set(["available", "failed"]);

const apiErrors = ["Refused", "Unanswered", "Busy", "Unreadable"] as const;

const standingAfter = 3;

interface Conflicted {
  readonly state: string;
  readonly times: number;
  readonly refusal: Refused;
}

const moveOf = (goal: Goal, state: string): Move => {
  const move = moves[goal][state];

  if (move !== undefined) {
    return move;
  }

  if (transitional.has(state)) {
    return "wait";
  }

  return goal === "gone" ? "delete" : "stuck";
};

const stateOf = (record: MachineRecord | undefined): MachineState => {
  switch (record?.state) {
    case undefined:
    case "deleted": {
      return "missing";
    }

    case "started":
    case "running": {
      return "running";
    }

    case "stopped":
    case "created": {
      return "stopped";
    }

    case "paused": {
      return "paused";
    }

    default: {
      return "unknown";
    }
  }
};

const unknownOutcome = (error: ApiError) =>
  error._tag === "Unanswered" || (error._tag === "Refused" && error.retryable);

const isGone = (error: ApiError) =>
  error._tag === "Refused" && error.status === 404;

const isConflict = (error: ApiError): error is Refused =>
  error._tag === "Refused" && error.status === 409;

const oversized = (error: Refused) =>
  error.status === 422 && error.detail.startsWith("machine size exceeds");

const internal = (what: string) => (error: ApiError) =>
  new Internal({ message: `${what}: ${error.message}` });

const waited = (error: ApiError) =>
  Effect.sleep(
    error._tag === "Refused" ? Duration.seconds(error.retryAfterSeconds) : poll
  );

const bounded =
  (what: string) =>
  <A, E>(step: Effect.Effect<A, E>): Effect.Effect<A, E | Internal> =>
    step.pipe(
      timeoutFail(
        stepTimeout,
        () =>
          new Internal({
            message: `${what} didn't end at smol cloud within ${Duration.format(stepTimeout)}`,
          })
      ),
      Effect.uninterruptible
    );

const read = <A>(
  what: string,
  call: Effect.Effect<A, ApiError>
): Effect.Effect<A, Internal> =>
  call.pipe(
    Effect.retry({
      while: unknownOutcome,
      times: 3,
      schedule: Schedule.spaced(poll),
    }),
    Effect.mapError(internal(what))
  );

const targetOf = (machine: Identity, handle: Handle): Target => ({
  name: machine.name,
  instance: machine.instance,
  handle,
});

const holds = (record: MachineRecord, asked: Api.Sizes) =>
  (asked.cpus ?? record.resources.cpus) === record.resources.cpus &&
  (asked.memoryMb ?? record.resources.memoryMb) === record.resources.memoryMb &&
  (asked.diskGb ?? record.resources.diskGb) === record.resources.diskGb;

const sizesOf = (record: MachineRecord, asked: Sizes): Sizes => ({
  cpu: record.resources.cpus,
  ramMib: record.resources.memoryMb,
  diskGib: record.resources.diskGb ?? asked.diskGib,
});

const encoder = new TextEncoder();

const asciiLengths = Array.from(
  { length: 0x80 },
  (_, code) => JSON.stringify(String.fromCodePoint(code)).length - 2
);

const characterLength = (character: string): number => {
  const code = character.codePointAt(0) ?? 0;

  if (code < 0x80) {
    return asciiLengths[code] ?? 6;
  }

  return code >= 0xd8_00 && code <= 0xdf_ff
    ? 6
    : encoder.encode(character).length;
};

const pieces = (text: string, room: number): readonly string[] => {
  const chunks: string[] = [];
  let chunk = "";
  let used = 0;

  for (const character of text) {
    const length = characterLength(character);

    if (used + length > room && chunk !== "") {
      chunks.push(chunk);
      chunk = "";
      used = 0;
    }

    chunk += character;
    used += length;
  }

  return chunk === "" ? chunks : [...chunks, chunk];
};

const bodyLength = (body: Api.ExecBody) =>
  encoder.encode(JSON.stringify(body)).length;

const stagedStdin = () =>
  `/dev/shm/clankerbox-stdin-${Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(8)))}`;

export const make = (
  settings: SmolCloudSettings,
  host: Pick<HostSettings, "id" | "listen">,
  api: Api.Api,
  sockets: Socket.WebSocketConstructor["Service"]
): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const prefix = `cbx-${host.id}-`;
    const nameOf = (instance: string) => `${prefix}${instance}`;

    const instanceOf = (name: string | null | undefined) => {
      const rest =
        name?.startsWith(prefix) === true ? name.slice(prefix.length) : "";

      return instancePattern.test(rest) ? rest : undefined;
    };

    const markedMachine = (marks: Api.Marks) =>
      instanceOf(marks.name) !== undefined;

    const listed = api.machines(markedMachine);

    const checkpointsOf = (handles: ReadonlySet<string>) =>
      api.checkpoints(
        ({ machineId }) => machineId !== undefined && handles.has(machineId)
      );

    const record = (handle: Handle) =>
      api.machine(handle).pipe(Effect.catchIf(isGone, () => Effect.undefined));

    const atRest = (handle: Handle) =>
      untilRest(
        api.machine(handle),
        (found) => !transitional.has(found.state),
        poll
      );

    const resized = (machine: Target, asked: Api.Sizes) =>
      sentUntilHeld({
        send: api.resize(machine.handle, asked),
        rested: atRest(machine.handle),
        holds: (found) => holds(found, asked),
        unheld: (found) =>
          new Internal({
            message: `smol cloud answered none of ${triesAfterLoss} resizes of ${machine.name}, and holds it at ${found.resources.cpus} CPUs, ${found.resources.memoryMb} MiB and ${found.resources.diskGb ?? "an unknown"} GiB of disk`,
          }),
      });

    const atLimit = Effect.map(
      Effect.all([api.account, api.inUse], { concurrency: "unbounded" }),
      ([account, inUse]) =>
        inUse.startedMachines >= account.effectiveMaxConcurrentMachines ||
        inUse.machines >= account.effectiveMaxMachines
    );

    const failed =
      (what: string) =>
      (error: ApiError): Effect.Effect<never, Capacity | Internal> => {
        if (
          error._tag === "Refused" &&
          (error.status === 402 || error.code === "insufficient_capacity")
        ) {
          return Effect.fail(
            new Capacity({ message: `${what}: ${error.message}` })
          );
        }

        if (
          error._tag === "Refused" &&
          error.status === 422 &&
          !oversized(error)
        ) {
          return Effect.flatMap(
            Effect.orElseSucceed(atLimit, () => false),
            (full) =>
              Effect.fail(
                full
                  ? new Capacity({
                      message: `${what}: the account is at its limits: ${error.message}`,
                    })
                  : internal(what)(error)
              )
          );
        }

        return Effect.fail(internal(what)(error));
      };

    const autoStopSeconds = yield* Effect.cachedWithTTL(
      Effect.map(api.account, (account) =>
        account.plan.allowAlwaysOn ? 0 : idleStopSeconds
      ),
      (exit) => (exit._tag === "Success" ? Duration.infinity : Duration.zero)
    );

    const settle = (
      machine: Target,
      goal: Goal,
      conflicted?: Conflicted
    ): Effect.Effect<void, ApiError | Missing | WrongState> =>
      Effect.gen(function* () {
        const found = yield* record(machine.handle);
        const state = found?.state ?? "missing";
        const move = moveOf(goal, state);

        if (move === "done") {
          return;
        }

        if (move === "missing") {
          return yield* missing(traits.runtime, machine);
        }

        if (move === "stuck") {
          return yield* new WrongState({
            message: `${machine.name} is ${state} at smol cloud, and can't be brought ${goal} from there`,
            machine: machine.name,
            state,
          });
        }

        if (move === "wait") {
          yield* Effect.sleep(poll);

          return yield* settle(machine, goal);
        }

        const times = conflicted?.state === state ? conflicted.times : 0;

        if (conflicted !== undefined && times >= standingAfter) {
          return yield* new WrongState({
            message: `smol cloud refused to ${move} ${machine.name} ${times} times while it stayed ${state}: ${conflicted.refusal.detail}`,
            machine: machine.name,
            state,
          });
        }

        const refusal = yield* (
          move === "delete"
            ? api.deleteMachine(machine.handle)
            : api.act(machine.handle, move)
        ).pipe(
          Effect.as(undefined),
          Effect.catchIf(isGone, () => Effect.undefined),
          Effect.catchIf(unknownOutcome, (error) =>
            Effect.as(waited(error), undefined)
          ),
          Effect.catchIf(isConflict, (error) => Effect.as(waited(error), error))
        );

        return yield* settle(
          machine,
          goal,
          refusal === undefined
            ? undefined
            : { state, times: times + 1, refusal }
        );
      });

    const toward = (machine: Target, goal: Goal) => {
      const refused = failed(
        `${goal === "gone" ? "delete" : goal} ${machine.name}`
      );

      return settle(machine, goal).pipe(Effect.catchTag(apiErrors, refused));
    };

    const settled = (machine: Target, goal: Goal) =>
      bounded(`bringing ${machine.name} ${goal}`)(toward(machine, goal));

    const byName = (name: string) =>
      Effect.map(listed, (all) => all.find((found) => found.name === name)?.id);

    const made = (machine: Identity & Sizes, origin: Origin) => {
      const name = nameOf(machine.instance);

      switch (origin._tag) {
        case "image": {
          return Effect.flatMap(autoStopSeconds, (autoStop) =>
            api.create({
              name,
              image: origin.image,
              sizes: {
                cpus: machine.cpu,
                memoryMb: machine.ramMib,
                diskGb: machine.diskGib,
              },
              ttlSeconds: settings.ttlSeconds,
              autoStopSeconds: autoStop,
            })
          );
        }

        case "checkpoint": {
          return Effect.flatMap(autoStopSeconds, (autoStop) =>
            api.restore(origin.checkpoint.handle, name, autoStop)
          );
        }

        case "machine": {
          return api.branch(origin.machine.handle, name);
        }
      }
    };

    const created = (
      machine: Identity & Sizes,
      origin: Origin,
      tries = 5
    ): Effect.Effect<Handle, ApiError> =>
      Effect.flatMap(Effect.result(made(machine, origin)), (answered) => {
        if (answered._tag === "Success") {
          return Effect.succeed(answered.success.id);
        }

        const error = answered.failure;

        if (!unknownOutcome(error) && !isConflict(error)) {
          return Effect.fail(error);
        }

        return Effect.andThen(
          waited(error),
          Effect.flatMap(byName(nameOf(machine.instance)), (handle) =>
            Effect.fromNullishOr(handle).pipe(
              Effect.catch(() =>
                tries > 1 && unknownOutcome(error)
                  ? created(machine, origin, tries - 1)
                  : Effect.fail(error)
              )
            )
          )
        );
      });

    const pruned = (machine: Target, checkpoint: Handle) =>
      api.deleteCheckpoint(checkpoint).pipe(
        Effect.catchIf(isGone, () => Effect.void),
        Effect.mapError(
          internal(
            `delete checkpoint ${checkpoint} of ${machine.name}, which no row keeps`
          )
        )
      );

    const unkept = (machine: Target, keep: ReadonlySet<Handle>) =>
      Effect.flatMap(
        read(
          `the checkpoints of ${machine.name}`,
          checkpointsOf(new Set([machine.handle]))
        ),
        (all) =>
          Effect.forEach(
            all.filter(
              (checkpoint) =>
                checkpoint.machineId === machine.handle &&
                !keep.has(checkpoint.id)
            ),
            (checkpoint) => pruned(machine, checkpoint.id),
            { discard: true }
          )
      );

    const available = (machine: Target, checkpoint: Handle) =>
      Effect.map(
        read(
          `capture ${machine.name}`,
          untilRest(
            api.checkpoint(checkpoint),
            ({ status }) => checkpointEnds.has(status),
            poll
          )
        ),
        ({ status }) => status === "available"
      );

    const streamed = (
      machine: Target,
      body: Api.ExecBody
    ): Effect.Effect<Execution, Internal, Scope.Scope> =>
      Effect.gen(function* () {
        const what = `exec in ${machine.name}`;

        const frames = yield* Effect.mapError(
          api.exec(machine.handle, body),
          internal(what)
        );

        const exit = yield* Deferred.make<number, Internal>();

        const output = frames.pipe(
          Stream.mapError(internal(what)),
          Stream.mapEffect((frame) => {
            switch (frame._tag) {
              case "output": {
                return Effect.succeed([encoder.encode(frame.data)]);
              }

              case "exit": {
                return Effect.as(Deferred.succeed(exit, frame.exitCode), []);
              }

              case "error": {
                return Effect.fail(
                  new Internal({ message: `${what}: ${frame.data}` })
                );
              }
            }
          }),
          Stream.flattenIterable,
          Stream.onExit((ended) =>
            ended._tag === "Failure"
              ? Deferred.failCause(exit, ended.cause)
              : Deferred.fail(
                  exit,
                  new Internal({ message: `${what} ended with no exit code` })
                )
          )
        );

        return { output, exitCode: Deferred.await(exit) };
      });

    const exitOf = (machine: Target, body: Api.ExecBody) =>
      Effect.scoped(
        Effect.flatMap(streamed(machine, body), ({ output, exitCode }) =>
          Effect.andThen(Stream.runDrain(output), exitCode)
        )
      );

    const staging = (
      machine: Target,
      file: string,
      user: string | undefined,
      stdin: string
    ) => {
      const command = ["sh", "-c", 'umask 077 && cat >>"$1"', "sh", file];
      const room = bodyLimit - bodyLength({ command, user, stdin: "" });

      return Effect.forEach(
        pieces(stdin, room),
        (piece) =>
          Effect.flatMap(
            exitOf(machine, { command, user, stdin: piece }),
            (code) =>
              code === 0
                ? Effect.void
                : Effect.fail(
                    new Internal({
                      message: `couldn't stage stdin for a command in ${machine.name}: cat exited ${code}`,
                    })
                  )
          ),
        { discard: true }
      );
    };

    const unstaged = (
      machine: Target,
      file: string,
      user: string | undefined
    ) =>
      exitOf(machine, { command: ["rm", "-f", file], user }).pipe(
        Effect.timeout(unstageTimeout),
        Effect.ignore
      );

    const exec = (machine: Target, command: Command) => {
      const inline: Api.ExecBody = {
        command: command.argv,
        user: command.user,
        stdin: command.stdin,
      };

      if (command.stdin === undefined || bodyLength(inline) <= bodyLimit) {
        return streamed(machine, inline);
      }

      const { stdin } = command;
      const file = stagedStdin();

      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() => unstaged(machine, file, command.user));
        yield* staging(machine, file, command.user, stdin);

        return yield* streamed(machine, {
          command: [
            "sh",
            "-c",
            'f=$1; shift; exec <"$f"; rm -f "$f"; exec "$@"',
            "sh",
            file,
            ...command.argv,
          ],
          user: command.user,
        });
      });
    };

    const capacity = Effect.gen(function* () {
      const [account, inUse, all] = yield* Effect.all(
        [api.account, api.inUse, listed],
        { concurrency: "unbounded" }
      );

      const cpus = all
        .filter((found) => stateOf(found) === "running")
        .reduce((sum, found) => sum + found.resources.cpus, 0);

      const readings: readonly Reading[] = [
        {
          resource: "runningMachines",
          used: inUse.startedMachines,
          limit: account.effectiveMaxConcurrentMachines,
        },
        {
          resource: "machines",
          used: inUse.machines,
          limit: account.effectiveMaxMachines,
        },
        { resource: "cpu", used: cpus },
        { resource: "ramMib", used: inUse.startedMemoryMb },
      ];

      return readings;
    });

    const marked = Effect.gen(function* () {
      const ours = (yield* listed).filter((found) => markedMachine(found));

      const checkpoints = yield* checkpointsOf(
        new Set(ours.map(({ id }) => id))
      );

      return ours.flatMap((found) => {
        const instance = instanceOf(found.name);

        return instance === undefined
          ? []
          : [
              {
                instance,
                handle: found.id,
                checkpoints: checkpoints
                  .filter(({ machineId }) => machineId === found.id)
                  .map(({ id }) => id),
              },
            ];
      });
    });

    const observe = (machines: readonly Target[]) => {
      const [only] = machines;

      if (machines.length === 1 && only !== undefined) {
        return Effect.map(
          record(only.handle),
          (found): Observed => new Map([[only.name, stateOf(found)]])
        );
      }

      return Effect.map(listed, (all): Observed => {
        const byHandle = new Map(all.map((found) => [found.id, found]));

        return new Map(
          machines.map(({ name, handle }) => [
            name,
            stateOf(byHandle.get(handle)),
          ])
        );
      });
    };

    const runtime: Interface = {
      traits,
      guest: "debian",
      version: "v1",
      pin: undefined,
      prepares: "always",
      reach: {
        _tag: "relayed",
        address: host.listen.address,
        dial: tunnel(api, sockets),
      },
      admission: undefined,
      files: undefined,
      owned: {
        machines: read("the machines this host made", marked),
        checkpoints: Effect.succeed([]),
      },
      sizable: () => Effect.void,
      startup: Effect.void,
      find: (what, ref) =>
        what === "machine"
          ? read(
              `the search for machine ${ref.name}`,
              byName(nameOf(ref.instance))
            )
          : Effect.undefined,
      observe: (machines) => read("the machines' states", observe(machines)),
      capacity: () => read("the account's capacity", capacity),
      make: (machine, origin) =>
        Effect.gen(function* () {
          const handle = yield* created(machine, origin).pipe(
            Effect.catchIf(
              (error) => error._tag === "Refused" && oversized(error),
              (error) =>
                Effect.fail(
                  new Capacity({
                    message: `make ${machine.name}: smol cloud makes no machine of these sizes on this account: ${error.message}`,
                  })
                )
            ),
            Effect.catchTag(apiErrors, failed(`make ${machine.name}`))
          );

          yield* toward(targetOf(machine, handle), "running");

          const found = yield* read(
            `the read of ${machine.name}`,
            record(handle)
          );

          if (found === undefined) {
            return yield* missing(traits.runtime, machine);
          }

          return { handle, sizes: sizesOf(found, machine) };
        }).pipe(bounded(`make ${machine.name}`)),
      start: (machine, keep) =>
        Effect.andThen(
          toward(machine, "running"),
          unkept(machine, keep).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `${error.message}, so the machine's next start or remove prunes it`
              )
            )
          )
        ).pipe(bounded(`start ${machine.name}`)),
      stop: (machine) =>
        Effect.mapError(
          settled(machine, "stopped"),
          (error) => new Internal({ message: error.message })
        ),
      pause: (machine) =>
        Effect.catchTag(settled(machine, "paused"), "Capacity", (error) =>
          Effect.fail(new Internal({ message: error.message }))
        ),
      delete: (machine, keep) =>
        Effect.andThen(toward(machine, "gone"), unkept(machine, keep)).pipe(
          bounded(`delete ${machine.name}`),
          Effect.mapError((error) => new Internal({ message: error.message }))
        ),
      capture: (machine) =>
        Effect.gen(function* () {
          const checkpoint = yield* api.capture(machine.handle).pipe(
            Effect.catch(
              (error): Effect.Effect<never, Capacity | Internal | WrongState> =>
                isConflict(error)
                  ? Effect.fail(
                      new WrongState({
                        message: `capture ${machine.name}: ${error.message}`,
                        machine: machine.name,
                        state: error.code,
                      })
                    )
                  : failed(`capture ${machine.name}`)(error)
            )
          );

          if (!(yield* available(machine, checkpoint.id))) {
            yield* Effect.ignore(api.deleteCheckpoint(checkpoint.id));

            return yield* new Internal({
              message: `capture ${machine.name}: smol cloud's checkpoint ${checkpoint.id} failed`,
            });
          }

          return checkpoint.id;
        }).pipe(bounded(`capture ${machine.name}`)),
      resize: (machine, to) =>
        resized(machine, {
          cpus: to.cpu,
          memoryMb: to.ramMib,
          diskGb: to.diskGib,
        }).pipe(
          Effect.catchTag(apiErrors, (error) =>
            Effect.fail(
              error._tag === "Refused" &&
                (error.status === 400 || error.status === 422)
                ? new Unsizable({
                    message: `resize ${machine.name}: ${error.detail}`,
                  })
                : internal(`resize ${machine.name}`)(error)
            )
          ),
          bounded(`resize ${machine.name}`)
        ),
      sizes: (machine) =>
        Effect.map(
          read(`the read of ${machine.name}`, api.machine(machine.handle)),
          (found): Sizing => ({
            cpu: found.resources.cpus,
            ramMib: found.resources.memoryMb,
            diskGib: found.resources.diskGb ?? undefined,
          })
        ),
      deleteCheckpoint: (checkpoint) =>
        api.deleteCheckpoint(checkpoint.handle).pipe(
          Effect.catchIf(isGone, () => Effect.void),
          Effect.retry({
            while: unknownOutcome,
            schedule: Schedule.spaced(poll),
            times: 5,
          }),
          Effect.mapError((error) =>
            isConflict(error)
              ? new Conflict({
                  message: `smol cloud keeps checkpoint ${checkpoint.name}: ${error.detail}`,
                })
              : internal(`delete checkpoint ${checkpoint.name}`)(error)
          ),
          bounded(`delete checkpoint ${checkpoint.name}`)
        ),
      exec,
    };

    return runtime;
  });

export const layer = (
  settings: SmolCloudSettings,
  host: HostSettings
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
> =>
  Layer.effect(
    Runtime,
    Effect.gen(function* () {
      if (host.id.length > longestHostId) {
        return yield* new CannotStart({
          message: `a smol cloud host's ID is at most ${longestHostId} characters, as the provider caps a machine's name at 63, and ${host.id} has ${host.id.length}`,
        });
      }

      const fs = yield* FileSystem.FileSystem;

      const key = yield* fs.readFileString(settings.apiKeyFile).pipe(
        Effect.map((text) => Redacted.make(text.trim())),
        Effect.mapError(
          () =>
            new CannotStart({
              message: `couldn't read the smol cloud API key from ${settings.apiKeyFile}`,
            })
        )
      );

      const api = yield* Api.make(settings.api ?? defaultApi, key);

      return yield* make(
        settings,
        host,
        api,
        yield* Socket.WebSocketConstructor
      );
    }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor))
  );
