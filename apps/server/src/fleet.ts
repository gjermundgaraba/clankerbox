import type { Adopted, Retired } from "@clankerbox/host-contract";
import { readTimeout } from "@gjermundgaraba/clankerbox-sdk";
import type {
  Internal,
  Unreported,
  Usage,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Scope } from "effect";
import { Cause, DateTime, Duration, Effect, FiberMap, Option } from "effect";

import { applied } from "./chart.ts";
import { unread } from "./hosts.ts";
import type { Interface as Hosts } from "./hosts.ts";
import { machineChart, stageOf } from "./machine-chart.ts";
import { mayHoldVm, refOf } from "./steps.ts";
import type { Interface as Store } from "./store.ts";

export interface CapacityRead {
  readonly usage: readonly Usage[];
  readonly unreported: readonly Unreported[];
}

/** What each host reports its machines use, and which hosts couldn't say. */
export const capacity = (
  store: Store,
  hosts: Hosts
): Effect.Effect<CapacityRead, Internal> =>
  Effect.gen(function* () {
    const reached = yield* hosts.reachAll;
    const rows = yield* store.machines;
    const unreported: Unreported[] = [];

    const unreportedBy = (
      host: string,
      problem: { readonly _tag: string; readonly message: string }
    ) => {
      unreported.push({
        host,
        state: unread(problem),
        problem: problem.message,
      });
    };

    const usage = yield* Effect.forEach(
      reached,
      ({ member, info, problem }) => {
        if (info === undefined) {
          if (problem !== undefined) {
            unreportedBy(member.id, problem);
          }

          return Effect.succeed<Usage[]>([]);
        }

        return hosts
          .call(member.id, (api) =>
            api.readCapacity({
              machines: rows
                .filter((found) => found.host === member.id && mayHoldVm(found))
                .map(refOf),
            })
          )
          .pipe(
            Effect.map((readings) =>
              readings.map((reading): Usage => ({
                host: member.id,
                ...reading,
              }))
            ),
            Effect.catch((error) =>
              Effect.sync((): Usage[] => {
                unreportedBy(member.id, error);

                return [];
              })
            )
          );
      },
      { concurrency: "unbounded" }
    );

    return { usage: usage.flat(), unreported };
  });

const holding = (store: Store, { name, ...reach }: Adopted) =>
  store.advance("machine", name, (found, op) =>
    applied(machineChart, found, { type: "adopted", ...reach }, op)
  );

const adopted = (store: Store, hosts: Hosts, host: string, boot: string) =>
  Effect.gen(function* () {
    const known = yield* store.hostBoot(host);

    if (Option.contains(known, boot)) {
      return;
    }

    const rows = yield* store.machines;

    const told = yield* hosts
      .call(host, (api) =>
        api.adoptMachines({
          machines: rows
            .filter(
              (found) => found.host === host && stageOf(found.state) === "made"
            )
            .map(refOf),
        })
      )
      .pipe(
        Effect.tap(({ adopted: held }) =>
          Effect.forEach(held, (each) => holding(store, each))
        ),
        Effect.flatMap(({ unresolved }) =>
          unresolved.length === 0
            ? Effect.succeed(true)
            : Effect.as(
                Effect.logWarning(
                  `host ${host} couldn't find ${unresolved.join(", ")}, so the next recheck gives it its machines again`
                ),
                false
              )
        ),
        Effect.catch(({ message }) =>
          Effect.as(
            Effect.logWarning(
              `couldn't give host ${host} its machines, so the next recheck tries again: ${message}`
            ),
            false
          )
        )
      );

    if (told) {
      yield* store.recordBoot(host, boot);
    }
  });

/**
 * How long a store names an instance it retired, from the first sweep that reached its host and left
 * nothing of it. A make that lands at its provider later than this is left there.
 */
export const retiredLast = Duration.days(1);

const swept = (
  store: Store,
  hosts: Hosts,
  host: string,
  sweeps: Duration.Duration | undefined
) =>
  Effect.gen(function* () {
    const retired = yield* store.retired(host);

    if (retired.machines.length === 0) {
      return;
    }

    const left =
      sweeps === undefined
        ? Option.some<Retired>({ machines: [] })
        : yield* hosts
            .call(
              host,
              (api) => api.sweepRetired(retired),
              Duration.sum(sweeps, readTimeout)
            )
            .pipe(
              Effect.asSome,
              Effect.catch(({ message }) =>
                Effect.as(
                  Effect.logWarning(
                    `host ${host} couldn't sweep what the store retired, so the next recheck tries again: ${message}`
                  ),
                  Option.none<Retired>()
                )
              )
            );

    if (Option.isSome(left)) {
      const kept = new Set(left.value.machines);

      yield* store.told(
        host,
        {
          gone: {
            machines: retired.machines.filter(
              (instance) => !kept.has(instance)
            ),
          },
          left: left.value,
        },
        yield* DateTime.now
      );
    }
  });

/**
 * The recheck, a tick at a time: it gives each restarted host its machines, starts a sweep of what
 * the store retired on each host whose last sweep has ended, and ends old failures. A sweep waits as
 * long as its host says one takes, so it runs on beside the ticks after it.
 */
export const recheckHosts = (
  store: Store,
  hosts: Hosts,
  failedRowsLast: Duration.Duration
): Effect.Effect<{ readonly tick: Effect.Effect<void> }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sweeping = yield* FiberMap.make<string>();

    const sweep = (host: string, sweeps: Duration.Duration | undefined) =>
      FiberMap.run(sweeping, host, { onlyIfMissing: true })(
        swept(store, hosts, host, sweeps).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              `the sweep of host ${host} failed:\n${Cause.pretty(cause)}`
            )
          )
        )
      );

    const tick = Effect.gen(function* () {
      const reached = yield* hosts.reachAll;

      yield* Effect.forEach(
        reached,
        ({ member, info }) =>
          info === undefined
            ? Effect.void
            : adopted(store, hosts, member.id, info.boot),
        { discard: true }
      );

      yield* Effect.forEach(
        reached,
        ({ member, info }) =>
          info === undefined ? Effect.void : sweep(member.id, info.sweeps),
        { discard: true }
      );

      const now = yield* DateTime.now;

      yield* store.expire(DateTime.subtractDuration(now, failedRowsLast));
      yield* store.forgetRetired(DateTime.subtractDuration(now, retiredLast));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`the recheck failed:\n${Cause.pretty(cause)}`)
      )
    );

    return { tick };
  });
