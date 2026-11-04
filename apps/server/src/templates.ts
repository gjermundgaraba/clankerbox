import type { HostInfo } from "@clankerbox/host-contract";
import {
  buildId,
  builtFrom,
  checkpointKinds,
  Conflict,
  Internal,
  Invalid,
  keptBuilds,
  NotFound,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Build,
  BuildRequest,
  Declared,
  Template,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  Cause,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
} from "effect";
import type { Scope } from "effect";

import { Checkpoints } from "./checkpoints.ts";
import { Hosts } from "./hosts.ts";
import { Machines } from "./machines.ts";
import { placing } from "./placement.ts";
import { newId, Store } from "./store.ts";
import type { BuildRow, TemplateRow } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<readonly Template[], Internal>;
  readonly get: (
    id: string
  ) => Effect.Effect<Template, Declared<"getTemplate">>;
  readonly build: (
    request: BuildRequest
  ) => Effect.Effect<Build, Declared<"buildTemplate">>;
  readonly delete: (
    id: string
  ) => Effect.Effect<void, Declared<"deleteTemplate">>;
}

export class Templates extends Context.Service<Templates, Interface>()(
  "@clankerbox/server/Templates"
) {}

const noTemplate = (id: string) =>
  new NotFound({ message: `no template ${id}`, id });

const shownBuild = (template: string, row: BuildRow): Build => ({
  id: buildId(template, row.number),
  createdAt: row.createdAt,
  phase: row.phase,
  host: row.host,
  image: row.image,
  ...(row.pin === undefined ? {} : { pin: row.pin }),
  ...(row.error === undefined ? {} : { error: row.error }),
});

const shown = (row: TemplateRow): Template => {
  const builds = row.builds.map((each) => shownBuild(row.name, each));

  return {
    id: row.name,
    createdAt: row.createdAt,
    base: row.base,
    cpu: row.cpu,
    ramMib: row.ramMib,
    diskGib: row.diskGib,
    ...(row.setupTimeoutSeconds === undefined
      ? {}
      : { setupTimeoutSeconds: row.setupTimeoutSeconds }),
    builds,
    ...builtFrom(builds),
  };
};

type Facts = Omit<TemplateRow, "name" | "createdAt" | "builds">;

const building = ({ builds }: TemplateRow) =>
  builds.find(({ phase }) => phase === "building");

const ended = (
  row: TemplateRow,
  number: number,
  end: Pick<BuildRow, "phase" | "error">
): TemplateRow => {
  const builds = row.builds.map((each) =>
    each.number === number ? { ...each, ...end } : each
  );

  const ready = new Set(
    builds.filter(({ phase }) => phase === "ready").slice(-keptBuilds)
  );

  return {
    ...row,
    builds: builds.filter((each) => each.number === number || ready.has(each)),
  };
};

type Begun = TemplateRow & {
  readonly builds: Arr.NonEmptyReadonlyArray<BuildRow>;
};

const begun =
  (name: string, asked: Facts, host: HostInfo, now: DateTime.Utc) =>
  (found: Option.Option<TemplateRow>): Result.Result<Begun, Conflict> => {
    const before = Option.getOrUndefined(found);
    const running = before === undefined ? undefined : building(before);

    if (running !== undefined) {
      return Result.fail(
        new Conflict({
          message: `template ${name} is building ${buildId(name, running.number)}: build it again once that ends`,
          id: name,
        })
      );
    }

    const earlier = before?.builds ?? [];

    const facts =
      before !== undefined && earlier.some(({ phase }) => phase === "ready")
        ? before
        : asked;

    return Result.succeed({
      ...facts,
      name,
      createdAt: before?.createdAt ?? now,
      builds: Arr.append(earlier, {
        number: (earlier.at(-1)?.number ?? 0) + 1,
        createdAt: now,
        phase: "building",
        error: undefined,
        host: host.id,
        pin: host.pin,
        image: host.images[asked.base] ?? asked.base,
      }),
    });
  };

export const make: Effect.Effect<
  Interface,
  Internal,
  Store | Hosts | Machines | Checkpoints | Scope.Scope
> = Effect.gen(function* () {
  const store = yield* Store;
  const hosts = yield* Hosts;
  const machines = yield* Machines;
  const checkpoints = yield* Checkpoints;
  const scope = yield* Effect.scope;

  const ending = (
    name: string,
    number: number,
    end: Pick<BuildRow, "phase" | "error">,
    facts?: Facts
  ) =>
    store.advanceTemplate(name, (found) =>
      Result.succeed(
        Option.match(found, {
          onNone: () => "removed" as const,
          onSome: (row) => ({ ...ended(row, number, end), ...facts }),
        })
      )
    );

  const tidied = Effect.gen(function* () {
    const recorded = yield* store.checkpoints;

    const live = new Set(
      (yield* store.templates).flatMap(({ name, builds }) =>
        builds.flatMap(({ number, phase }) =>
          phase === "failed" ? [] : [buildId(name, number)]
        )
      )
    );

    for (const { name, build } of recorded) {
      if (build !== undefined && !live.has(build)) {
        yield* checkpoints.discard(name);
      }
    }
  });

  const run = (
    name: string,
    number: number,
    asked: Facts,
    script: string,
    host: string
  ) =>
    Effect.gen(function* () {
      const { setupTimeoutSeconds: timeoutSeconds, ...spec } = asked;
      const id = buildId(name, number);
      const builder = `building-${newId().slice(0, 16)}`;

      const deleted = machines.delete(builder).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catch((error) =>
          Effect.logWarning(
            `couldn't delete build ${id}'s builder ${builder}: ${error.message}`
          )
        )
      );

      const atRest = Effect.gen(function* () {
        const resting = yield* machines.rest(builder);

        if (Option.isNone(resting)) {
          return yield* new Internal({
            message: `build ${id}'s builder went before its setup ended`,
          });
        }

        if (resting.value.error !== undefined) {
          return yield* resting.value.error;
        }

        return resting.value;
      });

      yield* Effect.gen(function* () {
        yield* machines.build(
          builder,
          {
            ...spec,
            setup: {
              script,
              ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
            },
          },
          host
        );

        const made = yield* atRest;

        if (checkpointKinds[made.kind] === "disk") {
          yield* machines.stop(builder);
          yield* atRest;
        }

        yield* checkpoints.copy(builder, id);
      }).pipe(Effect.ensuring(deleted));
    }).pipe(
      Effect.matchCauseEffect({
        onSuccess: () =>
          ending(name, number, { phase: "ready", error: undefined }, asked),
        onFailure: (cause) => {
          const error = Cause.findError(cause);

          return ending(name, number, {
            phase: "failed",
            error: Result.isSuccess(error)
              ? error.success
              : new Internal({ message: Cause.pretty(cause) }),
          });
        },
      }),
      Effect.andThen(tidied),
      Effect.catchCause((cause) =>
        Effect.logError(
          `couldn't record how build ${buildId(name, number)} ended:\n${Cause.pretty(cause)}`
        )
      )
    );

  const build = (request: BuildRequest) =>
    Effect.gen(function* () {
      const { template: name } = request;
      const before = Option.getOrUndefined(yield* store.findTemplate(name));
      const base = request.base ?? before?.base;
      const cpu = request.cpu ?? before?.cpu;
      const ramMib = request.ramMib ?? before?.ramMib;
      const diskGib = request.diskGib ?? before?.diskGib;

      const setupTimeoutSeconds =
        request.setup.timeoutSeconds ?? before?.setupTimeoutSeconds;

      if (base === undefined) {
        return yield* new Invalid({
          message: `a first build of template ${name} gives its base`,
        });
      }

      if (cpu === undefined || ramMib === undefined || diskGib === undefined) {
        return yield* new Invalid({
          message: `a first build of template ${name} gives its vCPUs, RAM and disk`,
        });
      }

      const asked = { base, cpu, ramMib, diskGib, setupTimeoutSeconds };

      const [host] = yield* Effect.fromResult(
        placing(yield* hosts.reachAll, base)
      );

      const row = yield* store.advanceTemplate(
        name,
        begun(name, asked, host, yield* DateTime.now)
      );

      const begin = Arr.lastNonEmpty(row.builds);

      yield* Effect.forkIn(
        run(name, begin.number, asked, request.setup.script, host.id),
        scope
      );

      return shownBuild(name, begin);
    });

  const remove = (name: string) =>
    Effect.andThen(
      store.advanceTemplate(
        name,
        (found): Result.Result<"removed", NotFound | Conflict> => {
          if (Option.isNone(found)) {
            return Result.fail(noTemplate(name));
          }

          const running = building(found.value);

          return running === undefined
            ? Result.succeed("removed")
            : Result.fail(
                new Conflict({
                  message: `template ${name} is building ${buildId(name, running.number)}: delete it once that ends`,
                  id: name,
                })
              );
        }
      ),
      tidied
    );

  for (const row of yield* store.templates) {
    const running = building(row);

    if (running !== undefined) {
      yield* ending(row.name, running.number, {
        phase: "failed",
        error: new Internal({
          message: `the control plane restarted during build ${buildId(row.name, running.number)}, which ended it`,
        }),
      });
    }
  }

  yield* tidied;

  return {
    list: Effect.map(store.templates, (rows) => rows.map(shown)).pipe(
      Effect.withSpan("Templates.list")
    ),
    get: Effect.fn("Templates.get")((id) =>
      Effect.flatMap(store.findTemplate(id), (found) =>
        Effect.fromOption(Option.map(found, shown), () => noTemplate(id))
      )
    ),
    build: Effect.fn("Templates.build")(build),
    delete: Effect.fn("Templates.delete")(remove),
  } satisfies Interface;
});

export const layer: Layer.Layer<
  Templates,
  Internal,
  Store | Hosts | Machines | Checkpoints
> = Layer.effect(Templates, make);
