import {
  formatSizes,
  givenSizes,
  isId,
} from "@clankerbox/host-contract/traits";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  sizedBy,
  Capacity,
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
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { FileSystem, Scope } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import {
  CannotStart,
  Handle,
  missing,
  missingCheckpoint,
  Runtime,
  unshared,
} from "../../runtime.ts";
import type {
  Dial,
  Identity,
  Interface,
  MachineState,
  Observed,
  Origin,
  Sighting,
  Target,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import {
  KeyedApiUrl,
  apiKey,
  bounded,
  sentUntilHeld,
  triesAfterLoss,
  untilRest,
} from "../provider-http.ts";
import { rented } from "../tombstones.ts";
import type { Found, MarkedMachine } from "../tombstones.ts";
import * as Api from "./api.ts";
import type { ApiError, ListedSnapshot, Sandbox, SshKey } from "./api.ts";
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

const snapshotMark = (name: string): boolean =>
  name.startsWith(snapshotPrefix) && isId(name.slice(snapshotPrefix.length));

const snapshotName = (checkpoint: Pick<Identity, "instance">): string =>
  `${snapshotPrefix}${checkpoint.instance}`;

const heldBy = (
  snapshots: readonly ListedSnapshot[],
  sandbox: string
): Handle[] =>
  snapshots.flatMap(({ name, sourceSandboxId }) =>
    sourceSandboxId === sandbox && snapshotMark(name) ? [Handle.make(name)] : []
  );

const running = new Set(["ready", "idle", "running"]);

/**
 * `cancelled`, `error` and `expired` as https://docs.boat.dev/openapi/boat-v1.yaml's
 * `Sandbox.state` and `dataExpiredAt`, and https://docs.boat.dev/llms-full.txt's "A sandbox is in
 * error", define them: a create or fork that got no machine, read once before a 404; a machine
 * boat lost or failed to start, unbilled, which the docs say a resume recovers; and a sandbox whose
 * data boat deleted 14 days into a stop, which no resume or fork can bring back.
 */
type Held =
  | "running"
  | "stopping"
  | "stopped"
  | "expired"
  | "error"
  | "moving"
  | "cancelled"
  | "gone";

type Rested = Exclude<Held, "moving" | "stopping">;

const rests = (held: Held): held is Rested =>
  held !== "moving" && held !== "stopping";

const heldOf = (sandbox: Sandbox | undefined): Held => {
  if (sandbox === undefined) {
    return "gone";
  }

  if ((sandbox.dataExpiredAt ?? null) !== null) {
    return "expired";
  }

  if (running.has(sandbox.state)) {
    return "running";
  }

  switch (sandbox.state) {
    case "archiving": {
      return "stopping";
    }

    case "archived": {
      return "stopped";
    }

    case "error":
    case "cancelled": {
      return sandbox.state;
    }

    default: {
      return "moving";
    }
  }
};

const readAs: Readonly<Record<Held, MachineState>> = {
  running: "running",
  stopping: "stopped",
  stopped: "stopped",
  expired: "missing",
  error: "stopped",
  moving: "unknown",
  cancelled: "missing",
  gone: "missing",
};

const whyOf = (held: Held, error: string | undefined): string | undefined => {
  if (held === "expired") {
    return "boat deleted its disk 14 days into a stop";
  }

  return held === "error"
    ? (error ?? "boat holds it in error, saying nothing")
    : error;
};

/**
 * A sandbox as `observe` reads it. `reboot` is when its kernel last restarted on its machine, and
 * `why` boat's `error`, which https://docs.boat.dev/openapi/boat-v1.yaml's `Sandbox.error` gives
 * for a sandbox stopped, failed or cancelled, or its dropped data.
 */
const sightingOf = (sandbox: Sandbox | undefined): Sighting => {
  const held = heldOf(sandbox);
  const reboot = sandbox?.lastReboot?.at;

  const why = whyOf(held, sandbox?.error ?? undefined);

  return {
    state: readAs[held],
    ...(reboot === undefined ? {} : { reboot }),
    ...(why === undefined || readAs[held] === "running" ? {} : { why }),
  };
};

const rebootReads = 8;

const rebootReadBudget = Duration.seconds(4);

type Goal = "running" | "stopped" | "gone";

const ends = {
  running: ["running", "expired", "error", "cancelled", "gone"],
  stopped: ["stopped", "expired", "error", "cancelled", "gone"],
  gone: ["cancelled", "gone"],
} as const satisfies Readonly<Record<Goal, readonly Held[]>>;

type End<G extends Goal> = (typeof ends)[G][number];

const endsAt =
  <G extends Goal>(goal: G) =>
  (held: Held): held is End<G> =>
    ends[goal].some((end: Held) => end === held);

interface Restoring {
  readonly held: Held;
  readonly hydrated: boolean;
}

const restoringOf = (sandbox: Sandbox | undefined): Restoring => ({
  held: heldOf(sandbox),
  hydrated: sandbox?.hydrated !== false,
});

/**
 * Ends where a make or start does, a running sandbox only once it is `hydrated`, as
 * https://docs.boat.dev/openapi/boat-v1.yaml's `Sandbox.hydrated` defines it: boat copies a resumed
 * or forked sandbox's files in while it runs, and moves them onto its disk under the programs
 * started before that ends.
 */
const restored = (
  found: Restoring
): found is Restoring & { readonly held: End<"running"> } =>
  endsAt("running")(found.held) && (found.held !== "running" || found.hydrated);

const dropped = (machine: Pick<Target, "name">) =>
  new Missing({
    message: `boat dropped machine ${machine.name}'s disk after its long stop; delete it`,
    machine: machine.name,
  });

const settled = new Set(["ready", "failed"]);

const isType = Schema.is(Api.BoatType);

const pollEvery = Duration.millis(500);

const listedWithin = Duration.seconds(5);

const internal =
  (what: string) =>
  (error: ApiError): Internal =>
    new Internal({
      message: `boat ${what}: ${error._tag === "Refused" ? `${error.code}: ` : ""}${error.message}`,
    });

const failure =
  (what: string) =>
  (error: ApiError): Internal | Capacity =>
    error._tag === "Refused" && Api.noRoom.has(error.code)
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

const bracketed = /^\[(?<host>[^\]]+)\]$/u;

/**
 * boat's `/sshkey` names where the guest's sshd answers as `sshEndpoint`, `host:port` or
 * `[v6]:port`, or else only as `machineIp`, on port 22.
 */
export const endpointOf = (
  answer: SshKey
): { readonly host: string; readonly port: number } | undefined => {
  const endpoint = answer.sshEndpoint ?? "";

  if (endpoint === "") {
    const ip = answer.machineIp ?? "";

    return ip === "" ? undefined : { host: ip, port: 22 };
  }

  const at = endpoint.lastIndexOf(":");
  const named = endpoint.slice(0, at);

  const host =
    bracketed.exec(named)?.groups?.["host"] ??
    (named.includes(":") ? "" : named);

  const port = Number(endpoint.slice(at + 1));

  return host !== "" && Number.isInteger(port) && port > 0 && port < 65_536
    ? { host, port }
    : undefined;
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
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const api = yield* Api.make(
      settings.api ?? defaultApi,
      yield* apiKey("boat", settings.apiKeyFile)
    );

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

    const toward = <G extends Goal>(machine: Target, goal: G) =>
      untilRest(Effect.map(read(machine), heldOf), endsAt(goal), pollEvery);

    const rested = (machine: Target) =>
      untilRest(Effect.map(read(machine), heldOf), rests, pollEvery);

    const pinned = (machine: Target) =>
      api.sshKey(machine.handle, channel.publicKey).pipe(
        Effect.mapError(internal(`couldn't read ${machine.name}'s ssh key`)),
        Effect.flatMap((answer) => {
          const endpoint = endpointOf(answer);

          return endpoint === undefined
            ? Effect.fail(
                new Internal({
                  message: `boat answered ${machine.name}'s ssh endpoint as ${answer.sshEndpoint ?? "none"} and its address as ${answer.machineIp ?? "none"}, which name no host and port`,
                })
              )
            : Effect.succeed({ ...endpoint, hostKey: answer.hostKey });
        }),
        Effect.tap((pin) => Effect.sync(() => pins.set(machine.handle, pin)))
      );

    const lastPin = (machine: Target) =>
      Effect.suspend(() => {
        const pin = pins.get(machine.handle);

        return pin === undefined ? pinned(machine) : Effect.succeed(pin);
      });

    const ready = (machine: Target, what: "make" | "start") =>
      Effect.gen(function* () {
        const { held } = yield* untilRest(
          Effect.map(read(machine), restoringOf),
          restored,
          pollEvery
        );

        switch (held) {
          case "running": {
            yield* pinned(machine);

            return;
          }

          case "expired": {
            return yield* dropped(machine);
          }

          case "error": {
            return yield* new Internal({
              message: `boat's ${what} of machine ${machine.name} ended in error`,
            });
          }

          case "cancelled": {
            return yield* what === "make"
              ? new Capacity({
                  message: `boat found machine ${machine.name} no machine to run on, and removed it`,
                })
              : missing(traits.runtime, machine);
          }

          case "gone": {
            return yield* missing(traits.runtime, machine);
          }
        }
      });

    const stopped = (machine: Target) =>
      Effect.gen(function* () {
        yield* api.stop(machine.handle).pipe(
          Effect.catchTag("Refused", (error) =>
            error.status === 404 ? Effect.void : Effect.fail(error)
          ),
          Effect.mapError(internal(`couldn't stop ${machine.name}`))
        );

        yield* toward(machine, "stopped");
      });

    const typeFor = (sizes: Parameters<typeof typeOf>[1], name: string) => {
      const type = typeOf(offered, sizes);

      return type === undefined
        ? Effect.fail(
            new Unsizable({
              message: `boat gives ${givenSizes(traits)}, and ${name} was asked ${formatSizes(sizes)}`,
            })
          )
        : Effect.succeed(type);
    };

    const labelsOf = (machine: Identity) => ({
      ...mark,
      [instanceLabel]: machine.instance,
    });

    const copyable = (
      source: Target
    ): Effect.Effect<"running" | "stopped", Internal | Missing | WrongState> =>
      Effect.flatMap(
        rested(source),
        (held): Effect.Effect<"running" | "stopped", Missing | WrongState> => {
          switch (held) {
            case "running":
            case "stopped": {
              return Effect.succeed(held);
            }

            case "expired": {
              return Effect.fail(dropped(source));
            }

            case "cancelled":
            case "gone": {
              return Effect.fail(missing(traits.runtime, source));
            }

            case "error": {
              return Effect.fail(
                new WrongState({
                  message: `boat holds ${source.name} in error, which it copies from no snapshot: a start may recover it, or delete it`,
                  machine: source.name,
                  state: "error",
                })
              );
            }
          }
        }
      );

    // A save of a running sandbox is a fresh capture, which can run minutes, where a fork reads the
    // newest automatic snapshot, up to a minute old:
    // https://docs.boat.dev/snapshots/resume-and-fork
    const savedAs = (machine: Target, name: string, what: string) =>
      Effect.gen(function* () {
        yield* api.save(machine.handle, name).pipe(
          Effect.catchTag("Unanswered", (lost) =>
            Effect.flatMap(api.saved(name), (found) =>
              found === undefined ? Effect.fail(lost) : Effect.void
            )
          ),
          Effect.mapError(failure(`${what} ${machine.name}`))
        );

        const snapshot = yield* untilRest(
          api
            .saved(name)
            .pipe(Effect.mapError(internal(`couldn't read snapshot ${name}`))),
          (found) => found === undefined || settled.has(found.status),
          pollEvery
        );

        if (snapshot?.status !== "ready") {
          return yield* new Internal({
            message: `boat's save of ${machine.name} as ${name} failed: ${snapshot?.error ?? "it is gone"}`,
          });
        }
      });

    const snapshots = api.savedSnapshots(snapshotPrefix, (name) =>
      snapshotMark(name)
    );

    const searched = (machine: Identity) =>
      Effect.map(api.sandboxes(labelsOf(machine)), (found) =>
        found.find((sandbox) => heldOf(sandbox) !== "cancelled")
      );

    /**
     * The reboot marks of the sandboxes a list read finds running, from their own records, read
     * only where boat may have set one since. boat's list answers `lastReboot: null` where
     * `GET /sandboxes/{id}` holds one, though https://docs.boat.dev/openapi/boat-v1.yaml types both
     * as `Sandbox`, as a live account showed three times on 2026-11-21; so a host never reads the
     * mark from the list, until a live run shows boat fills it there.
     *
     * It rests on `updatedAt`, which the list does fill: a sandbox's own record is read the first
     * time a list finds it running, and again only once its `updatedAt` differs from the one its
     * last read of its own record saw. On that account on 2026-11-21, a running sandbox's
     * `updatedAt` held still through 5 idle minutes, its minutely snapshots included, and moved
     * 15 s after a `systemctl reboot` set `lastReboot`, to the same value in the list and the
     * record. That is one reboot of one sandbox, and boat documents neither. Should boat stop moving
     * `updatedAt` on a reboot, or move it before it sets `lastReboot`, a host of two or more boat
     * machines misses each reboot in place; should it move it more often, the host only reads more.
     *
     * A list that finds a sandbox not running forgets it, so its next run is read afresh, as the
     * control plane takes a new reboot mark after each start that boots a machine. A read that
     * fails, that boat throttles with a 429, or that `rebootReadBudget` cuts short, inside the 9 s
     * a host's read is bounded to, records nothing, so the next list reads it again: the observe
     * answers the list's state meanwhile, the control plane keeps the mark it last read, and the
     * reboot counts a check later. Steady, that is the list alone; a host's first read after it
     * starts reads every running sandbox once, about 300 within the budget, and the rest at the
     * checks after.
     */
    const ownRead = new Map<string, string | undefined>();

    const remember = (sandbox: Sandbox | undefined, handle: string) => {
      if (sandbox !== undefined && heldOf(sandbox) === "running") {
        ownRead.set(handle, sandbox.updatedAt ?? undefined);
      } else {
        ownRead.delete(handle);
      }
    };

    const rebootsOf = (inList: readonly Sandbox[]) =>
      Effect.gen(function* () {
        const found = new Map<string, string>();

        for (const sandbox of inList) {
          if (heldOf(sandbox) !== "running") {
            ownRead.delete(sandbox.id);
          }
        }

        const due = inList.filter(
          (sandbox) =>
            heldOf(sandbox) === "running" &&
            (!ownRead.has(sandbox.id) ||
              ownRead.get(sandbox.id) !== (sandbox.updatedAt ?? undefined))
        );

        yield* Effect.forEach(
          due,
          ({ id }) =>
            api.sandbox(id).pipe(
              Effect.tap((own) =>
                Effect.sync(() => {
                  const at = own?.lastReboot?.at;

                  if (at !== undefined) {
                    found.set(id, at);
                  }

                  remember(own, id);
                })
              ),
              Effect.catch((error) =>
                Effect.logDebug(
                  `couldn't read ${id}'s reboot mark, so this read keeps the last: ${error.message}`
                )
              )
            ),
          { concurrency: rebootReads, discard: true }
        ).pipe(Effect.timeoutOption(rebootReadBudget));

        return found;
      });

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

    const listed = (machine: Identity) =>
      searched(machine).pipe(
        Effect.repeat({
          until: (found) => found !== undefined,
          schedule: Schedule.spaced(pollEvery),
        }),
        Effect.timeoutOption(listedWithin),
        Effect.map(Option.getOrUndefined)
      );

    const landed = (
      machine: Identity,
      sent: Effect.Effect<Sandbox, ApiError>
    ): Effect.Effect<Sandbox, ApiError> =>
      sentUntilHeld({
        send: sent,
        rested: listed(machine),
        holds: (found): found is Sandbox => found !== undefined,
        unheld: (_, last) => last,
      }).pipe(
        Effect.catchIf(
          (error): error is Api.Refused =>
            error._tag === "Refused" &&
            error.code === "idempotency_in_progress",
          (inProgress) =>
            listed(machine).pipe(
              Effect.filterOrFail(
                (found): found is Sandbox => found !== undefined,
                () => inProgress
              )
            )
        )
      );

    /**
     * Moves stopped machine `machine` to `type` through boat's resume, which counts a start. A
     * resume boat refuses `type_too_small` is sent once and never again: boat's limits say a
     * refused `rate_limited` start counts none, and say nothing of this refusal, so it spends at
     * most one start whichever way boat counts it.
     * https://docs.boat.dev/limits
     */
    const retyped = (
      machine: Target,
      type: Api.BoatType
    ): Effect.Effect<void, Internal | Unsizable> =>
      Effect.gen(function* () {
        const untaken: string[] = [];
        let taken = false;

        while (true) {
          const sandbox = yield* read(machine);
          const held = heldOf(sandbox);
          const now = sandbox?.type ?? "none";

          if (
            taken &&
            (held === "running" || held === "stopped") &&
            now !== type
          ) {
            if (held === "running") {
              yield* stopped(machine);
            }

            return yield* new Internal({
              message: `boat took the resize of ${machine.name} to ${type}, and resumed it at ${now}, so the host stopped it again`,
            });
          }

          switch (held) {
            case "gone":
            case "cancelled": {
              return yield* new Internal({
                message: `boat holds no machine ${machine.name} to resize`,
              });
            }

            case "error": {
              return yield* new Internal({
                message: `boat holds ${machine.name} in error, which it resizes from no snapshot: a start may recover it, or delete it`,
              });
            }

            case "expired": {
              return yield* new Internal({
                message: dropped(machine).message,
              });
            }

            case "moving":
            case "stopping": {
              yield* Effect.sleep(pollEvery);
              break;
            }

            case "running": {
              yield* stopped(machine);
              break;
            }

            case "stopped": {
              if (now === type) {
                return;
              }

              if (untaken.length === triesAfterLoss) {
                return yield* new Internal({
                  message: `boat took none of ${triesAfterLoss} resizes of ${machine.name} to ${type}, and holds it at ${now}: ${untaken.join("; ")}`,
                });
              }

              pins.delete(machine.handle);

              const unsent = yield* api.retype(machine.handle, type).pipe(
                Effect.as(undefined),
                Effect.catchTags({
                  Unanswered: () => Effect.succeed("its answer was lost"),
                  Refused: (error) =>
                    error.code === "sandbox_running_stop_first"
                      ? Effect.succeed(
                          `boat refused it as running while it read archived, ${error.code}: ${error.message}`
                        )
                      : Effect.fail(error),
                }),
                Effect.mapError((error) =>
                  error._tag === "Refused" && error.code === "type_too_small"
                    ? new Unsizable({
                        message: `machine ${machine.name} holds more data than boat's ${type} type takes, and boat keeps it at ${now}: ${error.message}`,
                      })
                    : internal(`couldn't resize ${machine.name}`)(error)
                )
              );

              taken = unsent === undefined;

              if (unsent !== undefined) {
                untaken.push(unsent);
                yield* Effect.sleep(pollEvery);
              }

              break;
            }
          }
        }
      });

    const runtime: Found = {
      traits,
      guest: "debian",
      kernel: "own",
      version: "api v1",
      pin: undefined,
      prepares: "always",
      admission: undefined,
      builds: unshared(traits.runtime),
      reach: {
        _tag: "relayed",
        address: host.listen.address,
        dial: (machine) => (input) =>
          Stream.unwrap(Effect.map(lastPin(machine), (pin) => tcp(pin)(input))),
      },
      startup: Effect.void,
      sizable: (machine, _from, to) => Effect.asVoid(typeFor(to, machine.name)),
      find: (machine) =>
        searched(machine).pipe(
          Effect.map((sandbox) =>
            sandbox === undefined ? undefined : Handle.make(sandbox.id)
          ),
          Effect.mapError(internal(`couldn't search for ${machine.name}`))
        ),
      checkpointHandle: (checkpoint) => Handle.make(snapshotName(checkpoint)),
      observe: (machines) => {
        const [only] = machines;

        if (machines.length === 1 && only !== undefined) {
          return api.sandbox(only.handle).pipe(
            Effect.map((sandbox): Observed => {
              remember(sandbox, only.handle);

              return new Map([[only.name, sightingOf(sandbox)]]);
            }),
            Effect.mapError(internal(`couldn't read ${only.name}`))
          );
        }

        return api.sandboxes(mark).pipe(
          Effect.mapError(internal("couldn't list this host's machines")),
          Effect.flatMap((sandboxes) => {
            const byId = new Map(
              sandboxes.map((sandbox) => [sandbox.id, sandbox])
            );

            const seen = machines.map(
              (machine) =>
                [machine, sightingOf(byId.get(machine.handle))] as const
            );

            return Effect.map(
              rebootsOf(
                machines.flatMap(({ handle }) => {
                  const found = byId.get(handle);

                  return found === undefined ? [] : [found];
                })
              ),
              (reboots): Observed =>
                new Map(
                  seen.map(([machine, sighting]) => {
                    const reboot = reboots.get(machine.handle);

                    return [
                      machine.name,
                      reboot === undefined ? sighting : { ...sighting, reboot },
                    ];
                  })
                )
            );
          })
        );
      },

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

          const through =
            origin._tag === "machine" &&
            (yield* copyable(origin.machine)) === "running"
              ? snapshotName(machine)
              : undefined;

          if (origin._tag === "machine" && through !== undefined) {
            yield* savedAs(origin.machine, through, "fork");
          }

          if (origin._tag === "checkpoint") {
            const { checkpoint } = origin;

            const snapshot = yield* api
              .saved(checkpoint.handle)
              .pipe(
                Effect.mapError(
                  internal(`couldn't read snapshot ${checkpoint.handle}`)
                )
              );

            if (snapshot === undefined) {
              return yield* missingCheckpoint(traits.runtime, checkpoint);
            }
          }

          const fromMachine = (source: Target) =>
            through === undefined
              ? api.fork(source.handle, { type, labels }, key)
              : api.create(
                  { type, labels, name: machine.name, from: through },
                  key
                );

          const sent =
            origin._tag === "machine"
              ? fromMachine(origin.machine)
              : api.create(
                  { type, labels, name: machine.name, ...createdFrom(origin) },
                  key
                );

          const sandbox = yield* landed(machine, sent).pipe(
            Effect.mapError((error) =>
              error._tag === "Refused" && error.code === "type_too_small"
                ? new Unsizable({
                    message: `machine ${machine.name}'s source holds more data than boat's ${type} type takes: ${error.message}`,
                  })
                : failure(`make ${machine.name}`)(error)
            )
          );

          const handle = Handle.make(sandbox.id);

          yield* ready({ ...machine, handle }, "make");

          if (through !== undefined) {
            yield* api
              .unsave(through)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    `make ${machine.name}: couldn't delete snapshot ${through}, which its source's next start or delete deletes: ${error.message}`
                  )
                )
              );
          }

          return { handle, sizes: types[type] };
        }).pipe(bounded("boat", `make ${machine.name}`)),
      start: (machine, keep) =>
        Effect.gen(function* () {
          yield* sentUntilHeld({
            send: api.resume(machine.handle).pipe(
              Effect.catchTag(
                ["Refused", "Busy", "Unreadable"],
                (
                  error
                ): Effect.Effect<never, Missing | Capacity | Internal> => {
                  if (error._tag === "Refused" && error.status === 404) {
                    return Effect.fail(missing(traits.runtime, machine));
                  }

                  if (
                    error._tag === "Refused" &&
                    error.code === "snapshot_data_expired"
                  ) {
                    return Effect.fail(dropped(machine));
                  }

                  return Effect.fail(failure(`start ${machine.name}`)(error));
                }
              ),
              Effect.flatMap((answer) =>
                Effect.logInfo(
                  `start ${machine.name}: boat ${answer === "kept" ? "gave back the machine it kept" : "started a machine"}`
                )
              )
            ),
            rested: rested(machine),
            holds: (held) => held === "running",
            unheld: (held) =>
              new Internal({
                message: `boat answered none of ${triesAfterLoss} starts of ${machine.name}, and holds it ${held}`,
              }),
          });
          yield* ready(machine, "start");
          yield* prune(machine, keep).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `${error.message}, so the machine's next start or delete prunes it`
              )
            )
          );
        }).pipe(bounded("boat", `start ${machine.name}`)),
      stop: (machine) =>
        bounded("boat", `stop ${machine.name}`)(stopped(machine)),
      delete: (machine, keep) =>
        Effect.gen(function* () {
          yield* prune(machine, keep);
          yield* api
            .remove(machine.handle)
            .pipe(Effect.mapError(internal(`couldn't delete ${machine.name}`)));
          yield* toward(machine, "gone");
          yield* prune(machine, keep);
          pins.delete(machine.handle);
        }).pipe(bounded("boat", `delete ${machine.name}`)),
      capture: (machine, checkpoint) =>
        Effect.gen(function* () {
          const name = snapshotName(checkpoint);

          yield* copyable(machine);
          yield* savedAs(machine, name, "capture");

          return Handle.make(name);
        }).pipe(bounded("boat", `capture ${machine.name}`)),
      resize: (machine, to) =>
        Effect.gen(function* () {
          const type = yield* typeFor(sizedBy(machine, to), machine.name);

          yield* retyped(machine, type);
        }).pipe(bounded("boat", `resize ${machine.name}`)),
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
            ),
            bounded("boat", `delete checkpoint ${checkpoint.name}`)
          ),
      exec: (machine, command) =>
        channel.exec(
          machine.handle,
          { last: lastPin(machine), fresh: pinned(machine) },
          command
        ),
    };

    return yield* rented(runtime, {
      dir: `${host.stateDir}/boat`,
      marked: markedMachines,
    });
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
