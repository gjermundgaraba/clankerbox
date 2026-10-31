import type { Internal, Usage } from "@gjermundgaraba/clankerbox-sdk";
import { Cause, DateTime, Effect, Option } from "effect";
import type { Duration } from "effect";

import type { Interface as Hosts } from "./hosts.ts";
import { stageOf } from "./machine-chart.ts";
import { refOf } from "./steps.ts";
import type { Interface as Store } from "./store.ts";

export interface CapacityRead {
  readonly usage: readonly Usage[];
  readonly unreachable: readonly string[];
}

/** What each host reports its machines use, and which hosts couldn't say. */
export const capacity = (
  store: Store,
  hosts: Hosts
): Effect.Effect<CapacityRead, Internal> =>
  Effect.gen(function* () {
    const reached = yield* hosts.reachAll;
    const rows = yield* store.machines;
    const unreachable: string[] = [];

    const usage = yield* Effect.forEach(
      reached,
      ({ member }) =>
        hosts
          .call(member.id, (api) =>
            api.readCapacity({
              machines: rows.flatMap((found) => {
                const ref = found.host === member.id ? refOf(found) : undefined;

                return ref === undefined ? [] : [ref];
              }),
            })
          )
          .pipe(
            Effect.map((readings) =>
              readings.map((reading): Usage => ({
                host: member.id,
                ...reading,
              }))
            ),
            Effect.catchTag("Unreachable", () =>
              Effect.sync((): Usage[] => {
                unreachable.push(member.id);

                return [];
              })
            )
          ),
      { concurrency: "unbounded" }
    );

    return { usage: usage.flat(), unreachable };
  });

const adopted = (store: Store, hosts: Hosts, host: string, boot: string) =>
  Effect.gen(function* () {
    const known = yield* store.hostBoot(host);

    if (Option.contains(known, boot)) {
      return;
    }

    const rows = yield* store.machines;

    yield* hosts.call(host, (api) =>
      api.adoptMachines({
        machines: rows.flatMap((found) => {
          const ref =
            found.host === host && stageOf(found.state) === "made"
              ? refOf(found)
              : undefined;

          return ref === undefined ? [] : [ref];
        }),
      })
    );

    yield* store.recordBoot(host, boot);
  });

/**
 * What a recheck does beyond each resource's loop: tells a host that restarted which machines it
 * has, and ends the rows of failures older than `failedRowsLast`.
 */
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
          : adopted(store, hosts, member.id, info.boot).pipe(
              Effect.catchTag("Unreachable", (error) =>
                Effect.logWarning(error.message)
              )
            ),
      { discard: true }
    );

    const before = DateTime.subtractDuration(
      yield* DateTime.now,
      failedRowsLast
    );

    yield* store.expire(before);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(`the recheck failed:\n${Cause.pretty(cause)}`)
    )
  );
