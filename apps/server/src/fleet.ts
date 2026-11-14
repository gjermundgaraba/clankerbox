import type { Adopted, Ref, Retired } from "@clankerbox/host-contract";
import type {
  Internal,
  Unreported,
  Usage,
} from "@gjermundgaraba/clankerbox-sdk";
import { Cause, DateTime, Duration, Effect, Option } from "effect";

import { applied } from "./chart.ts";
import { checkpointChart, phaseOf } from "./checkpoint-chart.ts";
import type { Interface as Hosts } from "./hosts.ts";
import { machineChart, stageOf } from "./machine-chart.ts";
import { identityOf, mayHoldVm, refOf } from "./steps.ts";
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
      problem: { readonly message: string; readonly incompatible?: true }
    ) => {
      unreported.push({
        host,
        state: problem.incompatible === true ? "incompatible" : "unreachable",
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

const unheldKey = (host: string, { name, instance }: Ref) =>
  `${host} ${name} ${instance}`;

const handled = (store: Store, { name, instance, handle }: Ref) =>
  handle === undefined
    ? Effect.void
    : store.advance("checkpoint", name, (found, op) =>
        applied(checkpointChart, found, { type: "found", instance, handle }, op)
      );

const located = (
  store: Store,
  hosts: Hosts,
  host: string,
  unheld: Set<string>
) =>
  Effect.gen(function* () {
    const unknown = (yield* store.checkpoints)
      .filter(
        (row) =>
          row.host === host &&
          row.handle === undefined &&
          phaseOf(row.state) === "ready"
      )
      .map(identityOf)
      .filter((ref) => !unheld.has(unheldKey(host, ref)));

    if (unknown.length === 0) {
      return;
    }

    const { found } = yield* hosts.call(host, (api) =>
      api.findCheckpoints({ checkpoints: unknown })
    );

    for (const ref of found) {
      if (ref.handle === undefined) {
        unheld.add(unheldKey(host, ref));
      }

      yield* handled(store, ref);
    }
  }).pipe(
    Effect.catch(({ message }) =>
      Effect.logWarning(
        `couldn't find the handles of host ${host}'s checkpoints, so the next recheck tries again: ${message}`
      )
    )
  );

/**
 * How long a store names an instance it retired, from the first sweep that reached its host and left
 * nothing of it. A make that lands at its provider later than this is left there.
 */
export const retiredLast = Duration.days(1);

const without = (instances: readonly string[], kept: readonly string[]) => {
  const still = new Set(kept);

  return instances.filter((instance) => !still.has(instance));
};

const goneOf = (retired: Retired, left: Retired): Retired => ({
  machines: without(retired.machines, left.machines),
  checkpoints: without(retired.checkpoints, left.checkpoints),
});

const swept = (store: Store, hosts: Hosts, host: string) =>
  Effect.gen(function* () {
    const retired = yield* store.retired(host);

    if (retired.machines.length === 0 && retired.checkpoints.length === 0) {
      return;
    }

    const left = yield* hosts
      .call(host, (api) => api.sweepRetired(retired))
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
      yield* store.told(
        host,
        { gone: goneOf(retired, left.value), left: left.value },
        yield* DateTime.now
      );
    }
  });

/**
 * The recheck, which remembers across its runs the checkpoints a host said its runtime keeps
 * nothing of its own for, so it asks for each row's handle only until it is found or so answered.
 */
export const recheckHosts = (
  store: Store,
  hosts: Hosts,
  failedRowsLast: Duration.Duration
): Effect.Effect<void> => {
  const unheld = new Set<string>();

  return Effect.gen(function* () {
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
        info === undefined
          ? Effect.void
          : located(store, hosts, member.id, unheld),
      { concurrency: "unbounded", discard: true }
    );

    yield* Effect.forEach(
      reached,
      ({ member, info }) =>
        info === undefined ? Effect.void : swept(store, hosts, member.id),
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
};
