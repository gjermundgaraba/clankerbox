import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Capacity,
  givenSizes,
  Internal,
  Missing,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type { HostError, Reading } from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  Duration,
  Effect,
  Layer,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { FileSystem } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import {
  CannotStart,
  Handle,
  missing,
  Runtime,
  timeoutFail,
} from "../../runtime.ts";
import type {
  Dial,
  Identity,
  Interface,
  MachineState,
  MarkedMachine,
  Observed,
  Origin,
  Target,
} from "../../runtime.ts";
import { KeyedApiUrl } from "../../settings.ts";
import type { HostSettings } from "../../settings.ts";
import { answerWithin } from "../process.ts";
import * as Api from "./api.ts";
import type { ApiError, Sandbox, SavedSnapshot, SshKey } from "./api.ts";
import * as Ssh from "./ssh.ts";
import type { Pin } from "./ssh.ts";
import { traits as traitsOf, typeOf, types } from "./traits.ts";

export const BoatSettings = Schema.Struct({
  apiKeyFile: Schema.String,
  api: Schema.optionalKey(KeyedApiUrl),
});

export type BoatSettings = typeof BoatSettings.Type;

const defaultApi = "https://boat.dev/api/v1";

export const image = "ubuntu-24.04";

const hostLabel = "cbx-host";

export const instanceLabel = "cbx-instance";

const snapshotPrefix = "cbx-";

const snapshotMark = /^cbx-[0-9a-f]{32}$/u;

const snapshotName = (checkpoint: Pick<Identity, "instance">): string =>
  `${snapshotPrefix}${checkpoint.instance}`;

const heldBy = (
  snapshots: readonly SavedSnapshot[],
  sandbox: string
): Handle[] =>
  snapshots.flatMap(({ name, sourceSandboxId }) =>
    sourceSandboxId === sandbox && snapshotMark.test(name)
      ? [Handle.make(name)]
      : []
  );

const running = new Set(["ready", "idle", "running"]);

const passing = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "archiving",
]);

const stateOf = (sandbox: Sandbox | undefined): MachineState => {
  if (
    sandbox === undefined ||
    sandbox.state === "cancelled" ||
    (sandbox.dataExpiredAt ?? null) !== null
  ) {
    return "missing";
  }

  if (running.has(sandbox.state)) {
    return "running";
  }

  return ["archived", "archiving", "error"].includes(sandbox.state)
    ? "stopped"
    : "unknown";
};

const capacityCodes = new Set([
  "limit_reached",
  "rate_limited",
  "out_of_capacity",
  "no_ready_machine",
]);

const settled = new Set(["ready", "failed"]);

const isType = Schema.is(Api.BoatType);

const pollEvery = Duration.millis(500);

const pollFor = Duration.minutes(10);

const triesAfterLoss = 3;

const internal =
  (what: string) =>
  (error: ApiError): Internal =>
    new Internal({
      message: `boat ${what}: ${error._tag === "Refused" ? `${error.code}: ` : ""}${error.message}`,
    });

const failure =
  (what: string) =>
  (error: ApiError): Internal | Capacity =>
    error._tag === "Refused" && capacityCodes.has(error.code)
      ? new Capacity({
          message: `boat refused ${what}: ${error.code}: ${error.message}`,
        })
      : internal(what)(error);

const sandboxType = (machine: Target, sandbox: Sandbox | undefined) =>
  sandbox?.type !== undefined && isType(sandbox.type)
    ? Effect.succeed(sandbox.type)
    : Effect.fail(
        new Internal({
          message: `boat answered no machine type clankerbox knows for ${machine.name}: ${sandbox?.type ?? "none"}`,
        })
      );

const reading = (
  resource: string,
  window: { readonly limit: number; readonly used: number } | null | undefined
): Reading[] =>
  window === undefined || window === null
    ? []
    : [{ resource, used: window.used, limit: window.limit }];

const createdFrom = (origin: Exclude<Origin, { _tag: "machine" }>) => {
  if (origin._tag === "checkpoint") {
    return { from: origin.checkpoint.handle };
  }

  return origin.image === image ? {} : { from: origin.image };
};

const pinOf = (answer: SshKey): Pin => {
  const [host, port] = (answer.sshEndpoint ?? "").split(":");

  return host === undefined || host === "" || port === undefined
    ? { host: answer.machineIp ?? "", port: 22, hostKey: answer.hostKey }
    : { host, port: Number(port), hostKey: answer.hostKey };
};

const tcp =
  (pin: Pin): Dial =>
  (input) =>
    Stream.pipeThroughChannelOrFail(
      input,
      NodeSocket.makeNetChannel({ host: pin.host, port: pin.port })
    ).pipe(
      Stream.filter((chunk) => chunk instanceof Uint8Array),
      Stream.catchIf(
        (error) =>
          error.reason._tag === "SocketCloseError" &&
          error.reason.code === 1000,
        () => Stream.empty
      ),
      Stream.mapError(
        (error) =>
          new Internal({
            message: `relay to ${pin.host}:${pin.port}: ${error.message}`,
          })
      )
    );

export const make = (
  settings: BoatSettings,
  host: Pick<HostSettings, "id" | "stateDir" | "listen">
): Effect.Effect<
  Interface,
  HostError | CannotStart,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const api = yield* Api.make({
      api: settings.api ?? defaultApi,
      apiKeyFile: settings.apiKeyFile,
    });

    const limits = yield* api.limits.pipe(
      Effect.mapError(internal("couldn't read the account's limits"))
    );

    const offered = (limits.machineTypes ?? []).flatMap(({ type, available }) =>
      available && isType(type) ? [type] : []
    );

    if (!Arr.isReadonlyArrayNonEmpty(offered)) {
      return yield* new CannotStart({
        message:
          "boat's GET /limits offers this account no machine type it can start",
      });
    }

    const traits = traitsOf(offered);
    const channel = yield* Ssh.make(`${host.stateDir}/boat`);
    const pins = new Map<string, Pin>();
    const mark = { [hostLabel]: host.id };

    const read = (machine: Target) =>
      api
        .sandbox(machine.handle)
        .pipe(
          Effect.mapError(internal(`couldn't read machine ${machine.name}`))
        );

    const until = (
      machine: Target,
      done: (sandbox: Sandbox | undefined) => boolean,
      what: string
    ) =>
      read(machine).pipe(
        Effect.repeat({ until: done, schedule: Schedule.spaced(pollEvery) }),
        timeoutFail(
          pollFor,
          () =>
            new Internal({
              message: `boat didn't ${what} machine ${machine.name} within ${Duration.format(pollFor)}`,
            })
        )
      );

    const pinned = (machine: Target) =>
      api.sshKey(machine.handle, channel.publicKey).pipe(
        Effect.map(pinOf),
        Effect.tap((pin) => Effect.sync(() => pins.set(machine.handle, pin))),
        Effect.mapError(internal(`couldn't read ${machine.name}'s ssh key`))
      );

    const lastPin = (machine: Target) =>
      Effect.suspend(() => {
        const pin = pins.get(machine.handle);

        return pin === undefined ? pinned(machine) : Effect.succeed(pin);
      });

    const ready = (machine: Target, what: string) =>
      Effect.gen(function* () {
        const sandbox = yield* until(
          machine,
          (found) => found === undefined || running.has(found.state),
          what
        );

        if (sandbox === undefined) {
          return yield* new Capacity({
            message: `boat gave machine ${machine.name} no machine to run on`,
          });
        }

        yield* pinned(machine);
      });

    const stopped = (machine: Target) =>
      Effect.gen(function* () {
        yield* api.stop(machine.handle).pipe(
          Effect.catchTag("Refused", (error) =>
            error.status === 404 ? Effect.void : Effect.fail(error)
          ),
          Effect.mapError(internal(`couldn't stop ${machine.name}`))
        );

        yield* until(
          machine,
          (sandbox) => sandbox === undefined || sandbox.state === "archived",
          "stop"
        );
      });

    const typeFor = (sizes: Parameters<typeof typeOf>[1], name: string) => {
      const type = typeOf(offered, sizes);

      return type === undefined
        ? Effect.fail(
            new Unsizable({
              message: `boat gives ${givenSizes(traits)}, and ${name} was asked ${sizes.cpu} vCPUs, ${sizes.ramMib} MiB of RAM and ${sizes.diskGib} GiB of disk`,
            })
          )
        : Effect.succeed(type);
    };

    const labelsOf = (machine: Identity) => ({
      ...mark,
      [instanceLabel]: machine.instance,
    });

    const sourceStopped = (source: Target) =>
      Effect.flatMap(read(source), (sandbox) =>
        sandbox?.state === "archived"
          ? Effect.void
          : Effect.fail(
              new WrongState({
                message: `boat copies a stopped machine, and ${source.name} is ${stateOf(sandbox)}: stop it first`,
                machine: source.name,
                state: stateOf(sandbox),
              })
            )
      );

    const snapshots = api.savedSnapshots(snapshotPrefix, (name) =>
      snapshotMark.test(name)
    );

    const searched = (machine: Identity) =>
      Effect.map(api.sandboxes(labelsOf(machine)), (found) =>
        found.find(({ state }) => state !== "cancelled")
      );

    const markedMachines = Effect.gen(function* () {
      const sandboxes = yield* api.sandboxes(mark);
      const saved = yield* snapshots;

      return sandboxes.flatMap((sandbox): MarkedMachine[] => {
        const instance = sandbox.labels?.[instanceLabel];

        return instance === undefined
          ? []
          : [
              {
                instance,
                handle: Handle.make(sandbox.id),
                checkpoints: heldBy(saved, sandbox.id),
              },
            ];
      });
    }).pipe(Effect.mapError(internal("couldn't list what this host marked")));

    const prune = (machine: Target, keep: ReadonlySet<Handle>) =>
      Effect.gen(function* () {
        const saved = yield* snapshots.pipe(
          Effect.mapError(internal("couldn't list saved snapshots"))
        );

        yield* Effect.forEach(
          heldBy(saved, machine.handle).filter((handle) => !keep.has(handle)),
          (handle) =>
            api
              .unsave(handle)
              .pipe(
                Effect.mapError(internal(`couldn't delete snapshot ${handle}`))
              ),
          { discard: true }
        );
      });

    const awaited = (machine: Identity, inProgress: Api.Refused) =>
      searched(machine).pipe(
        Effect.repeat({
          until: (found) => found !== undefined,
          schedule: Schedule.spaced(pollEvery),
        }),
        timeoutFail(answerWithin.change, () => inProgress),
        Effect.filterOrFail(
          (found): found is Sandbox => found !== undefined,
          () => inProgress
        )
      );

    const landed = (
      machine: Identity,
      sent: Effect.Effect<Sandbox, ApiError>,
      tries: number
    ): Effect.Effect<Sandbox, ApiError> =>
      sent.pipe(
        Effect.catchTag("Unanswered", (lost) =>
          searched(machine).pipe(
            Effect.filterOrElse(
              (found): found is Sandbox => found !== undefined,
              () =>
                tries > 1 ? landed(machine, sent, tries - 1) : Effect.fail(lost)
            )
          )
        ),
        Effect.catchIf(
          (error): error is Api.Refused =>
            error._tag === "Refused" &&
            error.code === "idempotency_in_progress",
          (inProgress) => awaited(machine, inProgress)
        )
      );

    const retyped = (
      machine: Target,
      type: Api.BoatType
    ): Effect.Effect<void, Internal | Unsizable> =>
      Effect.gen(function* () {
        const sandbox = yield* read(machine);
        const state = sandbox?.state ?? "missing";

        if (state === "archived" && sandbox?.type === type) {
          return;
        }

        if (state === "archived") {
          yield* api.retype(machine.handle, type).pipe(
            Effect.catchTag("Unanswered", () => Effect.sleep(pollEvery)),
            Effect.catchIf(
              (error) =>
                error._tag === "Refused" &&
                error.code === "sandbox_running_stop_first",
              () => Effect.void
            ),
            Effect.mapError((error) =>
              error._tag === "Refused" && error.code === "type_too_small"
                ? new Unsizable({
                    message: `boat keeps ${machine.name} off ${type}: ${error.message}`,
                  })
                : internal(`couldn't resize ${machine.name}`)(error)
            )
          );
          pins.delete(machine.handle);
        } else if (running.has(state)) {
          yield* stopped(machine);
        } else if (passing.has(state)) {
          yield* Effect.sleep(pollEvery);
        } else {
          return yield* new Internal({
            message: `boat holds machine ${machine.name} ${state}, and can't resize it from there`,
          });
        }

        return yield* retyped(machine, type);
      });

    return {
      traits,
      guest: "debian",
      version: "api v1",
      pin: undefined,
      prepares: "always",
      admission: undefined,
      files: undefined,
      owned: { machines: markedMachines, checkpoints: Effect.succeed([]) },
      reach: {
        _tag: "relayed",
        address: host.listen.address,
        dial: (machine) => (input) =>
          Stream.unwrap(Effect.map(lastPin(machine), (pin) => tcp(pin)(input))),
      },
      startup: Effect.void,
      sizable: (machine, _from, to) => Effect.asVoid(typeFor(to, machine.name)),
      find: (what, ref) =>
        what === "machine"
          ? searched(ref).pipe(
              Effect.map((sandbox) =>
                sandbox === undefined ? undefined : Handle.make(sandbox.id)
              ),
              Effect.mapError(internal(`couldn't search for ${ref.name}`))
            )
          : api.saved(snapshotName(ref)).pipe(
              Effect.map((snapshot) =>
                snapshot === undefined ? undefined : Handle.make(snapshot.name)
              ),
              Effect.mapError(internal(`couldn't search for ${ref.name}`))
            ),
      observe: (machines) =>
        api.sandboxes(mark).pipe(
          Effect.map((sandboxes): Observed => {
            const byId = new Map(
              sandboxes.map((sandbox) => [sandbox.id, sandbox])
            );

            return new Map(
              machines.map((machine) => [
                machine.name,
                stateOf(byId.get(machine.handle)),
              ])
            );
          }),
          Effect.mapError(internal("couldn't list this host's machines"))
        ),
      capacity: () =>
        api.limits.pipe(
          Effect.map((now) => [
            {
              resource: "activeSandboxes",
              used: now.activeSandboxes,
              limit: now.maxActiveSandboxes,
            },
            ...reading("startsPerMinute", now.starts?.minute),
            ...reading("startsPerHour", now.starts?.hour),
            ...reading("startsPerDay", now.starts?.day),
          ]),
          Effect.mapError(internal("couldn't read the account's limits"))
        ),
      make: (machine, origin) =>
        Effect.gen(function* () {
          const type = yield* typeFor(machine, machine.name);
          const labels = labelsOf(machine);

          const key = `${snapshotPrefix}${host.id}-${machine.instance}`;

          if (origin._tag === "machine") {
            yield* sourceStopped(origin.machine);
          }

          const sent =
            origin._tag === "machine"
              ? api.fork(origin.machine.handle, { type, labels }, key)
              : api.create(
                  { type, labels, name: machine.name, ...createdFrom(origin) },
                  key
                );

          const sandbox = yield* landed(machine, sent, triesAfterLoss).pipe(
            Effect.mapError(failure(`make ${machine.name}`))
          );

          const handle = Handle.make(sandbox.id);

          yield* ready({ ...machine, handle }, "start");

          return { handle, sizes: types[type] };
        }).pipe(Effect.uninterruptible),
      start: (machine, keep) =>
        Effect.gen(function* () {
          const answer = yield* api.resume(machine.handle).pipe(
            Effect.mapError((error) => {
              if (error._tag === "Refused" && error.status === 404) {
                return missing(traits.runtime, machine);
              }

              if (
                error._tag === "Refused" &&
                error.code === "snapshot_data_expired"
              ) {
                return new Missing({
                  message: `boat dropped machine ${machine.name}'s disk after its long stop; delete it`,
                  machine: machine.name,
                });
              }

              return failure(`start ${machine.name}`)(error);
            })
          );

          yield* Effect.logInfo(
            `start ${machine.name}: boat ${answer === "kept" ? "gave back the machine it kept" : "started a machine"}`
          );
          yield* ready(machine, "start");
          yield* prune(machine, keep).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `${error.message}, so the machine's next start or delete prunes it`
              )
            )
          );
        }).pipe(Effect.uninterruptible),
      stop: (machine) => Effect.uninterruptible(stopped(machine)),
      pause: (machine) => Effect.uninterruptible(stopped(machine)),
      delete: (machine, keep) =>
        Effect.gen(function* () {
          yield* prune(machine, keep);
          yield* api
            .remove(machine.handle)
            .pipe(Effect.mapError(internal(`couldn't delete ${machine.name}`)));
          yield* until(machine, (sandbox) => sandbox === undefined, "delete");
          yield* prune(machine, keep);
          pins.delete(machine.handle);
        }).pipe(Effect.uninterruptible),
      capture: (machine, checkpoint) =>
        Effect.gen(function* () {
          const name = snapshotName(checkpoint);

          yield* sourceStopped(machine);
          yield* api.save(machine.handle, name).pipe(
            Effect.catchTag("Unanswered", (lost) =>
              Effect.flatMap(api.saved(name), (found) =>
                found === undefined ? Effect.fail(lost) : Effect.void
              )
            ),
            Effect.mapError(failure(`capture ${machine.name}`))
          );

          const snapshot = yield* api.saved(name).pipe(
            Effect.mapError(internal(`couldn't read snapshot ${name}`)),
            Effect.repeat({
              until: (found) =>
                found === undefined || settled.has(found.status),
              schedule: Schedule.spaced(pollEvery),
            }),
            timeoutFail(
              pollFor,
              () =>
                new Internal({
                  message: `boat didn't save ${machine.name} as ${name} within ${Duration.format(pollFor)}`,
                })
            )
          );

          if (snapshot?.status !== "ready") {
            return yield* new Internal({
              message: `boat's save of ${machine.name} as ${name} failed: ${snapshot?.error ?? "it is gone"}`,
            });
          }

          return Handle.make(name);
        }).pipe(Effect.uninterruptible),
      resize: (machine, to, live) =>
        Effect.gen(function* () {
          if (live) {
            return yield* new Internal({
              message: `boat changes ${machine.name}'s machine type only while it is stopped`,
            });
          }

          const type = yield* typeFor(
            {
              cpu: to.cpu ?? machine.cpu,
              ramMib: to.ramMib ?? machine.ramMib,
              diskGib: to.diskGib ?? machine.diskGib,
            },
            machine.name
          );

          yield* retyped(machine, type).pipe(
            timeoutFail(
              pollFor,
              () =>
                new Internal({
                  message: `boat didn't resize machine ${machine.name} within ${Duration.format(pollFor)}`,
                })
            )
          );
        }).pipe(Effect.uninterruptible),
      sizes: (machine) =>
        Effect.flatMap(read(machine), (sandbox) =>
          Effect.map(sandboxType(machine, sandbox), (type) => types[type])
        ),
      deleteCheckpoint: (checkpoint) =>
        api
          .unsave(checkpoint.handle)
          .pipe(
            Effect.mapError(
              internal(`couldn't delete snapshot ${checkpoint.handle}`)
            )
          ),
      exec: (machine, command) =>
        channel.exec(
          machine.handle,
          { last: lastPin(machine), fresh: pinned(machine) },
          command
        ),
    } satisfies Interface;
  });

export const layer = (
  settings: BoatSettings,
  host: Pick<HostSettings, "id" | "stateDir" | "listen">
): Layer.Layer<
  Runtime,
  HostError | CannotStart,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
> => Layer.effect(Runtime, make(settings, host));
