import type { Adopted } from "@clankerbox/host-contract";
import type {
  Internal,
  Unreported,
  Usage,
} from "@gjermundgaraba/clankerbox-sdk";
import { Cause, DateTime, Effect, Option } from "effect";
import type { Duration } from "effect";

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
          unreportedBy(member.id, problem);

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

/** A tick of the recheck: it gives each restarted host its machines, and ends old failures. */
export const recheckHosts = (
  store: Store,
  hosts: Hosts,
  failedRowsLast: Duration.Duration
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const reached = yield* hosts.reachAll;

    yield* Effect.forEach(
      reached,
      ({ member, info }) =>
        info === undefined
          ? Effect.void
          : adopted(store, hosts, member.id, info.boot),
      { discard: true }
    );

    const now = yield* DateTime.now;

    yield* store.expire(DateTime.subtractDuration(now, failedRowsLast));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(`the recheck failed:\n${Cause.pretty(cause)}`)
    )
  );
