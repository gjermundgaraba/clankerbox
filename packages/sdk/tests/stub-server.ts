import { setTimeout as sleep } from "node:timers/promises";

import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { DateTime, Effect, Layer, Predicate } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import type { HttpClient } from "effect/http";

import {
  Conflict,
  Http,
  labelledWith,
  NotFound,
  NotOffered,
  offered,
  offers,
  version,
  versionHeader,
  WrongState,
} from "../src/index.ts";
import type {
  Build,
  CapacityReport,
  Checkpoint,
  Client,
  CreateRequest,
  Declared,
  Executed,
  ExecRequest,
  Host,
  Kind,
  Labels,
  Machine,
  Phase,
  PrebuildRequest,
  Sizing,
} from "../src/index.ts";

/**
 * What one read of a resource sees: a phase, fields to write on its row, `gone` once it is deleted,
 * or `down` when the read gets no reply. A script's last `down` or `waiting` repeats, so an outage
 * of the control plane or of a host can outlast the wait.
 */
export type Step<Row, Stage> = Stage | Partial<Row> | "gone" | "down";

export type MachineStep = Step<Machine, Phase>;

export type CheckpointStep = Step<Checkpoint, Checkpoint["phase"]>;

export type BuildStep = Step<Build, Build["phase"]>;

export type Refusals = {
  readonly [N in Client.ServerAction]?: Declared<N>;
};

export interface StubServerOptions {
  readonly bases?: readonly string[];
  readonly kind?: Kind;
  readonly runtimeVersion?: string;
  readonly hosts?: readonly Host[];
  readonly capacity?: CapacityReport;
  readonly machines?: readonly Machine[];
  readonly checkpoints?: readonly Checkpoint[];
  readonly refuse?: Refusals;
  readonly create?: (
    request: CreateRequest
  ) => Effect.Effect<Machine, Declared<"createMachine">>;
  readonly prebuild?: (
    request: PrebuildRequest
  ) => Effect.Effect<Build, Declared<"prebuildCheckpoint">>;
  readonly exec?: (
    request: ExecRequest
  ) => Effect.Effect<Executed, Declared<"execMachine">>;
}

export const machine = (id: string, fields?: Partial<Machine>): Machine => ({
  id,
  kind: "linux",
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  state: "running",
  desired: "running",
  phase: "settled",
  ...fields,
});

export const checkpoint = (
  id: string,
  fields?: Partial<Checkpoint>
): Checkpoint => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  machine: id,
  kind: "disk",
  phase: "ready",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

const labelled = <A extends Machine | Checkpoint>(
  made: A,
  profile: string | undefined,
  labels?: Labels
): A => ({
  ...made,
  ...(profile === undefined ? {} : { profile }),
  ...(labels === undefined ? {} : { labels }),
});

const sized = (found: Machine | Checkpoint, sizes: Sizing) => ({
  cpu: sizes.cpu ?? found.cpu,
  ramMib: sizes.ramMib ?? found.ramMib,
  diskGib: sizes.diskGib ?? found.diskGib,
});

const atRest = (row: Machine): Machine => {
  if (row.desired === "deleted") {
    return { ...row, phase: "settled" };
  }

  const stays = row.desired === "paused" && row.state === "stopped";

  return { ...row, state: stays ? row.state : row.desired, phase: "settled" };
};

const nextStep = <S>(
  scripts: Map<string, readonly S[]>,
  id: string
): S | undefined => {
  const [step, ...rest] = scripts.get(id) ?? [];

  if (rest.length > 0) {
    scripts.set(id, rest);
  } else if (step !== "down" && step !== "waiting") {
    scripts.delete(id);
  }

  return step;
};

const noMachine = (id: string) =>
  new NotFound({ message: `no machine ${id}`, id });

const isUndone = ({ phase, state, desired }: Machine) =>
  phase === "failed" && state === "missing" && desired !== "deleted";

const noCheckpoint = (id: string) =>
  new NotFound({ message: `no checkpoint ${id}`, id });

const noBuild = (id: string) =>
  new NotFound({ message: `no prebuild ${id}`, id });

/**
 * The control plane, in memory. A mutation answers with the row it records, out of rest; the next
 * read rests it where the request asked, or removes it after a delete, unless `script`,
 * `scriptCheckpoint` or `scriptBuild` says what the next reads of an ID see, one step a read. Builds
 * are `prebuilt-0`, `prebuilt-1`. As on the control plane, a failed create's row whose VM is gone,
 * `failed` and `missing`, is replaced by a create of its name, cleared at once by a delete, and no
 * machine to any other request.
 */
export const stubServer = (options: StubServerOptions = {}) => {
  const kind = options.kind ?? "linux";
  const bases = options.bases ?? ["ubuntu"];
  const machines = new Map<string, Machine>();
  const checkpoints = new Map<string, Checkpoint>();
  const builds = new Map<string, Build>();
  const pendingBuilds = new Map<string, PrebuildRequest>();
  const machineScripts = new Map<string, readonly MachineStep[]>();
  const checkpointScripts = new Map<string, readonly CheckpointStep[]>();
  const buildScripts = new Map<string, readonly BuildStep[]>();
  const creates: CreateRequest[] = [];
  const prebuilds: PrebuildRequest[] = [];
  const execs: ExecRequest[] = [];
  const calls: string[] = [];
  const versions: Array<string | null> = [];
  let replyDropped = false;

  for (const held of options.machines ?? []) {
    machines.set(held.id, held);
  }

  for (const held of options.checkpoints ?? []) {
    checkpoints.set(held.id, held);
  }

  const recording = <N extends Client.ServerAction, A, E>(
    action: N,
    call: string,
    work: Effect.Effect<A, E>
  ): Effect.Effect<A, E | Declared<N>> =>
    Effect.suspend((): Effect.Effect<A, E | Declared<N>> => {
      const refusal: Declared<N> | undefined = options.refuse?.[action];

      calls.push(call);

      return refusal === undefined ? work : Effect.fail(refusal);
    });

  const find = (id: string) => {
    const found = machines.get(id);

    return found === undefined
      ? Effect.fail(noMachine(id))
      : Effect.succeed(found);
  };

  const findMade = (id: string) =>
    Effect.filterOrFail(
      find(id),
      (found) => !isUndone(found),
      () => noMachine(id)
    );

  const findCheckpoint = (id: string) => {
    const found = checkpoints.get(id);

    return found === undefined
      ? Effect.fail(noCheckpoint(id))
      : Effect.succeed(found);
  };

  const writeMachine = (row: Machine) => {
    machines.set(row.id, row);

    return row;
  };

  const writeCheckpoint = (row: Checkpoint) => {
    checkpoints.set(row.id, row);

    return row;
  };

  const restingMachine = (row: Machine): Effect.Effect<Machine, NotFound> => {
    if (row.phase !== "observing") {
      return Effect.succeed(row);
    }

    if (row.desired === "deleted") {
      machines.delete(row.id);

      return Effect.fail(noMachine(row.id));
    }

    return Effect.succeed(writeMachine(atRest(row)));
  };

  const readMachine = (id: string): Effect.Effect<Machine, NotFound> => {
    const step = nextStep(machineScripts, id);

    return Effect.flatMap(find(id), (found) => {
      if (step === undefined) {
        return restingMachine(found);
      }

      if (step === "down") {
        replyDropped = true;

        return Effect.succeed(found);
      }

      if (step === "gone") {
        machines.delete(id);

        return Effect.fail(noMachine(id));
      }

      if (step === "settled") {
        return Effect.succeed(writeMachine(atRest(found)));
      }

      return Effect.succeed(
        writeMachine(
          Predicate.isString(step)
            ? { ...found, phase: step }
            : { ...found, ...step }
        )
      );
    });
  };

  const restingCheckpoint = (
    row: Checkpoint
  ): Effect.Effect<Checkpoint, NotFound> => {
    if (row.phase === "capturing") {
      return Effect.succeed(writeCheckpoint({ ...row, phase: "ready" }));
    }

    if (row.phase === "deleting") {
      checkpoints.delete(row.id);

      return Effect.fail(noCheckpoint(row.id));
    }

    return Effect.succeed(row);
  };

  const readCheckpoint = (id: string): Effect.Effect<Checkpoint, NotFound> => {
    const step = nextStep(checkpointScripts, id);

    return Effect.flatMap(findCheckpoint(id), (found) => {
      if (step === undefined) {
        return restingCheckpoint(found);
      }

      if (step === "down") {
        replyDropped = true;

        return Effect.succeed(found);
      }

      if (step === "gone") {
        checkpoints.delete(id);

        return Effect.fail(noCheckpoint(id));
      }

      return Effect.succeed(
        writeCheckpoint(
          Predicate.isString(step)
            ? { ...found, phase: step }
            : { ...found, ...step }
        )
      );
    });
  };

  const built = (build: Build) => {
    const request = pendingBuilds.get(build.id);

    if (request !== undefined) {
      pendingBuilds.delete(build.id);
      writeCheckpoint(
        labelled<Checkpoint>(
          checkpoint(build.id, {
            base: request.base,
            cpu: request.cpu,
            ramMib: request.ramMib,
            diskGib: request.diskGib,
          }),
          request.profile
        )
      );
    }

    builds.set(build.id, build);

    return build;
  };

  const readBuild = (id: string): Effect.Effect<Build, NotFound> => {
    const step = nextStep(buildScripts, id);
    const found = builds.get(id);

    if (found === undefined) {
      return Effect.fail(noBuild(id));
    }

    if (step === undefined) {
      return Effect.succeed(
        found.phase === "building" ? built({ ...found, phase: "built" }) : found
      );
    }

    if (step === "down") {
      replyDropped = true;

      return Effect.succeed(found);
    }

    if (step === "gone") {
      builds.delete(id);

      return Effect.fail(noBuild(id));
    }

    const now: Build = Predicate.isString(step)
      ? { ...found, phase: step }
      : { ...found, ...step };

    builds.set(id, now);

    return Effect.succeed(now.phase === "built" ? built(now) : now);
  };

  const add = (made: Machine) => {
    const taken = machines.get(made.id);

    return taken === undefined || isUndone(taken)
      ? Effect.sync(() => writeMachine(made))
      : Effect.fail(
          new Conflict({ message: `${made.id} exists`, id: made.id })
        );
  };

  const asked = (id: string, desired: Machine["desired"]) =>
    Effect.map(findMade(id), (found) =>
      found.desired === "deleted"
        ? found
        : writeMachine({ ...found, desired, phase: "observing" })
    );

  const deleted = (id: string) =>
    Effect.flatMap(find(id), (found) =>
      isUndone(found)
        ? Effect.sync(() => {
            machines.delete(id);
          })
        : Effect.asVoid(asked(id, "deleted"))
    );

  const recordCreate = (request: CreateRequest) =>
    Effect.gen(function* () {
      if (options.create !== undefined) {
        return yield* options.create(request);
      }

      if (!offers({ kind, bases }, request.base)) {
        return yield* new NotOffered({
          message: `no host offers ${request.base}: the host offers ${offered({ kind, bases })}`,
          base: request.base,
        });
      }

      return yield* add(
        labelled(
          machine(request.id, {
            kind,
            base: request.base,
            cpu: request.cpu,
            ramMib: request.ramMib,
            diskGib: request.diskGib,
            state: "unknown",
            phase: "observing",
          }),
          request.profile,
          request.labels
        )
      );
    });

  const recordRestore = (
    source: string,
    name: string,
    sizes: Sizing,
    labels: Labels | undefined
  ) =>
    Effect.flatMap(findCheckpoint(source), (found) =>
      add(
        labelled(
          machine(name, {
            kind,
            base: found.base,
            ...sized(found, sizes),
            state: "unknown",
            phase: "observing",
          }),
          found.profile,
          labels
        )
      )
    );

  const recordCapture = (
    source: string,
    name: string,
    fields: Pick<Checkpoint, "labels" | "expiresAt">
  ) =>
    Effect.flatMap(findMade(source), (found) =>
      checkpoints.has(name)
        ? Effect.fail(new Conflict({ message: `${name} exists`, id: name }))
        : Effect.sync(() =>
            writeCheckpoint(
              labelled<Checkpoint>(
                checkpoint(name, {
                  createdAt: found.createdAt,
                  machine: found.id,
                  phase: "capturing",
                  base: found.base,
                  cpu: found.cpu,
                  ramMib: found.ramMib,
                  diskGib: found.diskGib,
                  ...(fields.expiresAt === undefined
                    ? {}
                    : { expiresAt: fields.expiresAt }),
                }),
                found.profile,
                fields.labels
              )
            )
          )
    );

  const recordPause = ({
    id,
    capture,
  }: Parameters<Client.Interface["pauseMachine"]>[0]) =>
    Effect.gen(function* () {
      if (capture !== undefined) {
        const found = yield* findMade(id);

        if (found.state !== "running") {
          return yield* new WrongState({
            message: `machine ${id} is ${found.state}, and a capture takes a running one`,
            machine: id,
            state: found.state,
          });
        }

        yield* recordCapture(id, capture.name, capture);
      }

      return yield* asked(id, "paused");
    });

  const recordExec = (request: ExecRequest) =>
    Effect.gen(function* () {
      execs.push(request);

      const found = yield* findMade(request.id);

      if (found.state !== "running") {
        return yield* new WrongState({
          message: `machine ${request.id} is ${found.state}, and a command runs only in a running machine: start it first`,
          machine: request.id,
          state: found.state,
        });
      }

      return options.exec === undefined
        ? { exitCode: 0, output: "", truncated: false }
        : yield* options.exec(request);
    });

  const recordPrebuild = (
    request: PrebuildRequest
  ): Effect.Effect<Build, Declared<"prebuildCheckpoint">> => {
    if (options.prebuild !== undefined) {
      return options.prebuild(request);
    }

    if (!offers({ kind, bases }, request.base)) {
      return Effect.fail(
        new NotOffered({
          message: `no host offers ${request.base}: the host offers ${offered({ kind, bases })}`,
          base: request.base,
        })
      );
    }

    return Effect.sync(() => {
      const build: Build = { id: `prebuilt-${builds.size}`, phase: "building" };

      pendingBuilds.set(build.id, request);
      builds.set(build.id, build);

      return build;
    });
  };

  const host: Host = {
    id: "stub",
    state: "up",
    kind,
    version,
    runtimeVersion: options.runtimeVersion ?? "0.0.0-test",
    bases,
  };

  const app = Action.implement(Http.actions, {
    listMachines: ({ labels }) =>
      recording(
        "listMachines",
        "machine.list",
        Effect.sync(() =>
          [...machines.values()].filter((row) =>
            labelledWith(row.labels, labels)
          )
        )
      ),
    getMachine: ({ id }) =>
      recording("getMachine", "machine.get", readMachine(id)),
    createMachine: (request) =>
      recording(
        "createMachine",
        "machine.create",
        Effect.andThen(
          Effect.sync(() => creates.push(request)),
          recordCreate(request)
        )
      ),
    startMachine: ({ id }) =>
      recording("startMachine", "machine.start", asked(id, "running")),
    stopMachine: ({ id }) =>
      recording("stopMachine", "machine.stop", asked(id, "stopped")),
    pauseMachine: (request) =>
      recording("pauseMachine", "machine.pause", recordPause(request)),
    resizeMachine: ({ id, ...sizes }) =>
      recording(
        "resizeMachine",
        "machine.resize",
        Effect.map(findMade(id), (found) =>
          writeMachine({
            ...found,
            ...sized(found, sizes),
            phase: "observing",
          })
        )
      ),
    deleteMachine: ({ id }) =>
      recording("deleteMachine", "machine.delete", deleted(id)),
    forkMachine: ({ machine: source, name, labels, ...sizes }) =>
      recording(
        "forkMachine",
        "machine.fork",
        Effect.flatMap(findMade(source), (found) =>
          add(
            labelled(
              machine(name, {
                kind: found.kind,
                base: found.base,
                ...sized(found, sizes),
                state: "unknown",
                phase: "observing",
              }),
              found.profile,
              labels
            )
          )
        )
      ),
    restoreMachine: ({ checkpoint: source, name, labels, ...sizes }) =>
      recording(
        "restoreMachine",
        "machine.restore",
        recordRestore(source, name, sizes, labels)
      ),
    execMachine: (request) =>
      recording("execMachine", "machine.exec", recordExec(request)),
    listCheckpoints: ({ labels }) =>
      recording(
        "listCheckpoints",
        "checkpoint.list",
        Effect.sync(() =>
          [...checkpoints.values()].filter(
            (row) => row.phase === "ready" && labelledWith(row.labels, labels)
          )
        )
      ),
    getCheckpoint: ({ id }) =>
      recording("getCheckpoint", "checkpoint.get", readCheckpoint(id)),
    captureCheckpoint: ({ machine: source, name, ...fields }) =>
      recording(
        "captureCheckpoint",
        "checkpoint.capture",
        recordCapture(source, name, fields)
      ),
    deleteCheckpoint: ({ id }) =>
      recording(
        "deleteCheckpoint",
        "checkpoint.delete",
        Effect.map(findCheckpoint(id), (found) => {
          writeCheckpoint({ ...found, phase: "deleting" });
        })
      ),
    prebuildCheckpoint: (request) =>
      recording(
        "prebuildCheckpoint",
        "checkpoint.prebuild",
        Effect.andThen(
          Effect.sync(() => prebuilds.push(request)),
          recordPrebuild(request)
        )
      ),
    getPrebuild: ({ id }) =>
      recording("getPrebuild", "prebuild.get", readBuild(id)),
    listHosts: () =>
      recording(
        "listHosts",
        "host.list",
        Effect.succeed(options.hosts ?? [host])
      ),
    getCapacity: () =>
      recording(
        "getCapacity",
        "host.capacity",
        Effect.succeed(options.capacity ?? { usage: [], unreachable: [] })
      ),
  });

  const routes = ActionHttp.layer(Http, [app]);

  const web = HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(HttpServer.layerServices)),
    {
      disableLogger: true,
    }
  );

  return {
    creates,
    prebuilds,
    execs,
    calls,
    versions,
    hold: (held: Machine) => {
      machines.set(held.id, held);
    },
    holdCheckpoint: (held: Checkpoint) => {
      checkpoints.set(held.id, held);
    },
    script: (id: string, steps: readonly MachineStep[]) => {
      machineScripts.set(id, steps);
    },
    scriptCheckpoint: (id: string, steps: readonly CheckpointStep[]) => {
      checkpointScripts.set(id, steps);
    },
    scriptBuild: (id: string, steps: readonly BuildStep[]) => {
      buildScripts.set(id, steps);
    },
    held: () => [...machines.keys()],
    heldCheckpoints: () => [...checkpoints.keys()],
    row: (id: string) => machines.get(id),
    routes,
    handler: async (request: Request) => {
      versions.push(request.headers.get(versionHeader));

      const response = await web.handler(request);

      if (replyDropped) {
        replyDropped = false;

        throw new TypeError("fetch failed", {
          cause: new Error("connect ECONNREFUSED"),
        });
      }

      return response;
    },
    dispose: async () => {
      await web.dispose();
    },
  };
};

export type StubServer = ReturnType<typeof stubServer>;

export class Silent {
  aborted = 0;
  readonly #reached = Promise.withResolvers<undefined>();
  readonly reached = Effect.promise(async () => {
    await this.#reached.promise;
  });

  arrive() {
    this.#reached.resolve(undefined);
  }
}

export type Endpoint =
  | StubServer
  | "down"
  | Silent
  | { readonly slow: StubServer }
  | { readonly lost: StubServer };

const requestUrl = (input: string | URL | Request): URL =>
  new URL(input instanceof Request ? input.url : input);

const unanswered = async (
  silent: Silent,
  signal: AbortSignal | null | undefined
) => {
  const { promise, reject } = Promise.withResolvers<Response>();

  signal?.addEventListener("abort", () => {
    silent.aborted += 1;
    reject(new Error("aborted"));
  });

  return await promise;
};

/** Requests reach the endpoint of their URL's origin, and any other origin refuses them. */
export const transport = (
  endpoints: ReadonlyMap<string, Endpoint>
): Layer.Layer<HttpClient.HttpClient> => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const endpoint = endpoints.get(requestUrl(input).origin);

    if (endpoint === undefined || endpoint === "down") {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED"),
      });
    }

    if (endpoint instanceof Silent) {
      endpoint.arrive();

      return await unanswered(endpoint, init?.signal);
    }

    if ("slow" in endpoint) {
      await sleep(100);

      return await endpoint.slow.handler(new Request(input, init));
    }

    if ("lost" in endpoint) {
      await endpoint.lost.handler(new Request(input, init));

      throw new TypeError("fetch failed", {
        cause: new Error("other side closed"),
      });
    }

    return await endpoint.handler(new Request(input, init));
  };

  return FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  );
};
