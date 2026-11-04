import { setTimeout as sleep } from "node:timers/promises";

import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { DateTime, Effect, Layer, Predicate } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import type { HttpClient } from "effect/http";

import {
  buildId,
  builtFrom,
  Conflict,
  Http,
  Invalid,
  labelledWith,
  NotBuilt,
  NotFound,
  NotOffered,
  offered,
  offers,
  templateRef,
  version,
  versionCheck,
  versionHeader,
  WrongState,
} from "../src/index.ts";
import type {
  Build,
  BuildRequest,
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
  Sizing,
  Template,
} from "../src/index.ts";

/**
 * What one read of a resource sees: a phase, fields to write on its row, `gone` once it is deleted,
 * or `down` when the read gets no reply. A script's last `down` or `waiting` repeats, so an outage
 * of the control plane or of a host can outlast the wait.
 */
export type Step<Row, Stage> = Stage | Partial<Row> | "gone" | "down";

export type MachineStep = Step<Machine, Phase> | "versionless";

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
  readonly templates?: readonly Template[];
  readonly refuse?: Refusals;
  readonly takesHold?: boolean;
  readonly create?: (
    request: CreateRequest
  ) => Effect.Effect<Machine, Declared<"createMachine">>;
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

export const build = (id: string, fields?: Partial<Build>): Build => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  phase: "ready",
  host: "stub",
  image: "ubuntu",
  ...fields,
});

export const template = (
  id: string,
  fields?: Partial<Omit<Template, "current" | "state">>
): Template => {
  const builds = fields?.builds ?? [build(buildId(id, 1))];

  return {
    id,
    createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    base: "ubuntu",
    cpu: 1,
    ramMib: 1024,
    diskGib: 10,
    ...fields,
    builds,
    ...builtFrom(builds),
  };
};

const labelled = <A extends Machine | Checkpoint>(
  made: A,
  labels?: Labels
): A => ({
  ...made,
  ...(labels === undefined ? {} : { labels }),
});

const sized = (
  found: Pick<Machine, "cpu" | "ramMib" | "diskGib">,
  sizes: Sizing
) => ({
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

const noTemplate = (id: string) =>
  new NotFound({ message: `no template ${id}`, id });

/**
 * The control plane, in memory. A mutation answers with the row it records, out of rest; the next
 * read rests it where the request asked, or removes it after a delete, unless `script`,
 * `scriptCheckpoint` or `scriptBuild` says what the next reads of an ID see, one step a read. A
 * build is read through its template, and `gone` deletes the template. As on the control plane, a
 * failed create's row whose VM is gone, `failed` and `missing`, is replaced by a create of its
 * name, cleared at once by a delete, and no machine to any other request.
 */
export const stubServer = (options: StubServerOptions = {}) => {
  const kind = options.kind ?? "linux";
  const bases = options.bases ?? ["ubuntu"];
  const machines = new Map<string, Machine>();
  const checkpoints = new Map<string, Checkpoint>();
  const templates = new Map<string, Template>();
  const machineScripts = new Map<string, readonly MachineStep[]>();
  const checkpointScripts = new Map<string, readonly CheckpointStep[]>();
  const buildScripts = new Map<string, readonly BuildStep[]>();
  const creates: CreateRequest[] = [];
  const execs: ExecRequest[] = [];
  const calls: string[] = [];
  const versions: Array<string | null> = [];
  const holds: Array<number | undefined> = [];
  let replyDropped = false;
  let replyVersionless = false;

  for (const held of options.machines ?? []) {
    machines.set(held.id, held);
  }

  for (const held of options.checkpoints ?? []) {
    checkpoints.set(held.id, held);
  }

  for (const held of options.templates ?? []) {
    templates.set(held.id, held);
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

      if (step === "versionless") {
        replyVersionless = true;

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

  const writeTemplate = (row: Template, written: readonly Build[]) => {
    const { current: _current, ...rest } = row;
    const next: Template = { ...rest, builds: written, ...builtFrom(written) };

    templates.set(row.id, next);

    return next;
  };

  const readBuild = (found: Build): Build | "gone" => {
    if (found.phase !== "building") {
      return found;
    }

    const step = nextStep(buildScripts, found.id);

    if (step === undefined) {
      return { ...found, phase: "ready" };
    }

    if (step === "down") {
      replyDropped = true;

      return found;
    }

    if (step === "gone") {
      return step;
    }

    return Predicate.isString(step)
      ? { ...found, phase: step }
      : { ...found, ...step };
  };

  const readTemplate = (id: string): Effect.Effect<Template, NotFound> => {
    const found = templates.get(id);

    if (found === undefined) {
      return Effect.fail(noTemplate(id));
    }

    const read = found.builds.map(readBuild);
    const kept = read.filter((each): each is Build => each !== "gone");

    if (kept.length < read.length) {
      templates.delete(id);

      return Effect.fail(noTemplate(id));
    }

    return Effect.succeed(writeTemplate(found, kept));
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

  const notOffered = (base: string) =>
    new NotOffered({
      message: `no host offers ${base}: the host offers ${offered({ kind, bases })}`,
      base,
    });

  const cloned = (ref: string) => {
    const { template: name, number } = templateRef(ref);
    const found = templates.get(name);
    const id = number === undefined ? found?.current : ref;

    const ready = found?.builds.find(
      (each) => each.id === id && each.phase === "ready"
    );

    return found === undefined || ready === undefined
      ? Effect.fail(
          new NotBuilt({
            message: `template ${name} has no ready build${id === undefined ? "" : ` ${id}`}: run clankerbox template build ${name} to make one`,
            template: name,
          })
        )
      : Effect.succeed({ found, id: ready.id });
  };

  const recordCreate = (request: CreateRequest) =>
    Effect.gen(function* () {
      if (options.create !== undefined) {
        return yield* options.create(request);
      }

      if ("template" in request) {
        const { found, id } = yield* cloned(request.template);

        return yield* add(
          labelled(
            machine(request.id, {
              kind,
              base: found.base,
              ...sized(found, request),
              template: id,
              state: "unknown",
              phase: "observing",
            }),
            request.labels
          )
        );
      }

      if (!offers({ kind, bases }, request.base)) {
        return yield* notOffered(request.base);
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

  const recordBuild = (
    request: BuildRequest
  ): Effect.Effect<Build, Declared<"buildTemplate">> =>
    Effect.gen(function* () {
      const found = templates.get(request.template);
      const base = request.base ?? found?.base;
      const cpu = request.cpu ?? found?.cpu;
      const ramMib = request.ramMib ?? found?.ramMib;
      const diskGib = request.diskGib ?? found?.diskGib;

      if (
        base === undefined ||
        cpu === undefined ||
        ramMib === undefined ||
        diskGib === undefined
      ) {
        return yield* new Invalid({
          message: `a first build of template ${request.template} gives its base, vCPUs, RAM and disk`,
        });
      }

      const earlier = found?.builds ?? [];

      const made = build(buildId(request.template, earlier.length + 1), {
        phase: "building",
        image: base,
      });

      writeTemplate(
        template(request.template, {
          ...found,
          base,
          cpu,
          ramMib,
          diskGib,
        }),
        [...earlier, made]
      );

      return made;
    });

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
    getMachine: ({ id, holdSeconds }) =>
      recording(
        "getMachine",
        "machine.get",
        Effect.andThen(
          Effect.sync(() => holds.push(holdSeconds)),
          readMachine(id)
        )
      ),
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
    buildTemplate: (request) =>
      recording("buildTemplate", "template.build", recordBuild(request)),
    listTemplates: () =>
      recording(
        "listTemplates",
        "template.list",
        Effect.sync(() => [...templates.values()])
      ),
    getTemplate: ({ id }) =>
      recording("getTemplate", "template.get", readTemplate(id)),
    deleteTemplate: ({ id }) =>
      recording(
        "deleteTemplate",
        "template.delete",
        Effect.suspend(() =>
          templates.delete(id) ? Effect.void : Effect.fail(noTemplate(id))
        )
      ),
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

  const routes =
    options.takesHold === true
      ? ActionHttp.layer(Http, [app]).pipe(
          Layer.provide(versionCheck("stub control plane").layer)
        )
      : ActionHttp.layer(Http, [app]);

  const web = HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(HttpServer.layerServices)),
    {
      disableLogger: true,
    }
  );

  return {
    creates,
    execs,
    calls,
    versions,
    holds,
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
    handler: async (request: Request): Promise<Response> => {
      versions.push(request.headers.get(versionHeader));

      const response = await web.handler(request);

      if (replyDropped) {
        replyDropped = false;

        throw new TypeError("fetch failed", {
          cause: new Error("connect ECONNREFUSED"),
        });
      }

      if (replyVersionless) {
        replyVersionless = false;

        const headers = new Headers(response.headers);

        headers.delete(versionHeader);

        return new Response(response.body, {
          status: response.status,
          headers,
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
