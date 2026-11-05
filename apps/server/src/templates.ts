import type { HostInfo } from "@clankerbox/host-contract";
import {
  buildId,
  builtFrom,
  checkpointKinds,
  Conflict,
  Internal,
  keptBuilds,
  NotFound,
  offers,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Build,
  BuildCopy,
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
  Semaphore,
} from "effect";
import type { Scope, Duration } from "effect";

import type { CheckpointRow } from "./checkpoint-chart.ts";
import { Checkpoints } from "./checkpoints.ts";
import { Hosts } from "./hosts.ts";
import type { Reached } from "./hosts.ts";
import { Machines } from "./machines.ts";
import { outdated, placing } from "./placement.ts";
import type { BuiltUnder } from "./placement.ts";
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

export interface Seen {
  readonly records: readonly CheckpointRow[];
  readonly reached: readonly Reached[];
}

const builtUnder = (template: TemplateRow, build: BuildRow): BuiltUnder => ({
  id: buildId(template.name, build.number),
  base: template.base,
  pin: build.pin,
  image: build.image,
});

const copyOf = (
  made: BuiltUnder,
  { host, state, error }: CheckpointRow,
  info: HostInfo | undefined
): BuildCopy | undefined => {
  if (state === "ready") {
    const why = info === undefined ? undefined : outdated(info, made);

    return why === undefined
      ? { host, phase: "ready" }
      : { host, phase: "outdated", reason: `${host} ${why}` };
  }

  if (state === "failed" || state.startsWith("discarding")) {
    return { host, phase: "failed", ...(error === undefined ? {} : { error }) };
  }

  return state.startsWith("fetching") ? { host, phase: "fetching" } : undefined;
};

const unfetched = (
  made: BuiltUnder,
  records: readonly CheckpointRow[],
  reached: readonly Reached[]
): readonly BuildCopy[] => {
  const kind = records[0]?.kind;

  return reached.flatMap(({ info }) => {
    const why =
      info === undefined ||
      info.kind !== kind ||
      !offers(info, made.base) ||
      records.some(({ host }) => host === info.id)
        ? undefined
        : outdated(info, made);

    return info === undefined || why === undefined
      ? []
      : [{ host: info.id, phase: "outdated", reason: `${info.id} ${why}` }];
  });
};

const shownBuild = (
  template: TemplateRow,
  row: BuildRow,
  seen: Seen
): Build => {
  const made = builtUnder(template, row);
  const records = seen.records.filter(({ build }) => build === made.id);

  return {
    id: made.id,
    createdAt: row.createdAt,
    phase: row.phase,
    host: row.host,
    image: row.image,
    ...(row.pin === undefined ? {} : { pin: row.pin }),
    ...(row.error === undefined ? {} : { error: row.error }),
    copies: [
      ...records.flatMap((record) => {
        const copy = copyOf(
          made,
          record,
          seen.reached.find(({ member }) => member.id === record.host)?.info
        );

        return copy === undefined ? [] : [copy];
      }),
      ...(row.phase === "ready" ? unfetched(made, records, seen.reached) : []),
    ],
  };
};

const shown = (row: TemplateRow, seen: Seen): Template => {
  const builds = row.builds.map((each) => shownBuild(row, each, seen));

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
  (
    found: Option.Option<TemplateRow>,
    lastBuild: number
  ): Result.Result<Begun, Conflict> => {
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
        number: lastBuild + 1,
        createdAt: now,
        phase: "building",
        error: undefined,
        host: host.id,
        pin: host.pin,
        image: host.images[asked.base] ?? asked.base,
      }),
    });
  };

const holds = ({ state }: CheckpointRow) =>
  state !== "failed" && !state.startsWith("deleting");

/**
 * The fetches due: of each ready build that was published, to each host of its kind that copies
 * builds, offers its base, runs its pin, names its image and holds no copy of it, each with the
 * copies that failed there, to clear first.
 */
export const fetchesDue = (
  templates: readonly TemplateRow[],
  { records, reached }: Seen
) =>
  templates.flatMap((template) =>
    template.builds.flatMap((build) => {
      const made = builtUnder(template, build);
      const copies = records.filter((record) => record.build === made.id);

      const source = copies.find(
        (record) => record.published === record.name && record.state === "ready"
      );

      return build.phase !== "ready" || source === undefined
        ? []
        : reached.flatMap(({ info }) => {
            const here = copies.filter((record) => record.host === info?.id);

            return info !== undefined &&
              info.builds &&
              info.kind === source.kind &&
              offers(info, template.base) &&
              outdated(info, made) === undefined &&
              !here.some(holds)
              ? [{ source, host: info.id, failed: here }]
              : [];
          });
    })
  );

export const make = (settings: {
  readonly recheck: Duration.Duration;
}): Effect.Effect<
  Interface,
  Internal,
  Store | Hosts | Machines | Checkpoints | Scope.Scope
> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const hosts = yield* Hosts;
    const machines = yield* Machines;
    const checkpoints = yield* Checkpoints;
    const scope = yield* Effect.scope;
    const copying = yield* Semaphore.make(1);

    const seen = Effect.all({
      records: store.checkpoints,
      reached: hosts.reachAll,
    });

    const copied = copying
      .withPermits(1)(
        Effect.gen(function* () {
          const due = fetchesDue(yield* store.templates, yield* seen);

          for (const { source, host, failed } of due) {
            yield* Effect.forEach(failed, ({ name }) =>
              checkpoints.discard(name)
            );
            yield* checkpoints.fetch(source, host);
          }
        })
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `couldn't copy builds to every host:\n${Cause.pretty(cause)}`
          )
        )
      );

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
      host: HostInfo
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
            host.id
          );

          const made = yield* atRest;

          if (checkpointKinds[made.kind] === "disk") {
            yield* machines.stop(builder);
            yield* atRest;
          }

          const copy = yield* checkpoints.copy(builder, id);

          if (host.builds) {
            yield* checkpoints.publish(copy);
          }
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
        Effect.andThen(copied),
        Effect.catchCause((cause) =>
          Effect.logError(
            `couldn't record how build ${buildId(name, number)} ended:\n${Cause.pretty(cause)}`
          )
        )
      );

    const build = (request: BuildRequest) =>
      Effect.gen(function* () {
        const { template: name, base, cpu, ramMib, diskGib } = request;

        const asked = {
          base,
          cpu,
          ramMib,
          diskGib,
          setupTimeoutSeconds: request.setup.timeoutSeconds,
        };

        const [host] = yield* Effect.fromResult(
          placing(yield* hosts.reachAll, base)
        );

        const row = yield* store.advanceTemplate(
          name,
          begun(name, asked, host, yield* DateTime.now)
        );

        const begin = Arr.lastNonEmpty(row.builds);

        yield* Effect.forkIn(
          run(name, begin.number, asked, request.setup.script, host),
          scope
        );

        return shownBuild(row, begin, { records: [], reached: [] });
      });

    const remove = (name: string) =>
      copying.withPermits(1)(
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
        )
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

    yield* Effect.forkIn(
      Effect.forever(Effect.andThen(copied, Effect.sleep(settings.recheck))),
      scope
    );

    return {
      list: Effect.gen(function* () {
        const now = yield* seen;

        return (yield* store.templates).map((row) => shown(row, now));
      }).pipe(Effect.withSpan("Templates.list")),
      get: Effect.fn("Templates.get")(function* (id) {
        const found = yield* store.findTemplate(id);

        if (Option.isNone(found)) {
          return yield* noTemplate(id);
        }

        return shown(found.value, yield* seen);
      }),
      build: Effect.fn("Templates.build")(build),
      delete: Effect.fn("Templates.delete")(remove),
    } satisfies Interface;
  });

export const layer = (settings: {
  readonly recheck: Duration.Duration;
}): Layer.Layer<Templates, Internal, Store | Hosts | Machines | Checkpoints> =>
  Layer.effect(Templates, make(settings));
