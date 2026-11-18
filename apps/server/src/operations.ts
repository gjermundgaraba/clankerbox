import type { Report, Step } from "@clankerbox/host-contract";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Data, Effect } from "effect";

import type { Interface as Hosts } from "./hosts.ts";
import type { Operation } from "./store.ts";

/**
 * Where a step stands, as far as a look at its host can tell. `lost` is a step its host doesn't hold
 * and won't run, and `why` says how the look knows.
 */
export type Polled =
  | { readonly at: "running"; readonly report: Report }
  | { readonly at: "ended"; readonly report: Report }
  | { readonly at: "lost"; readonly why: string }
  | { readonly at: "unreachable" };

/** Why a step its host never had can't be sent, as `why` says, such as a source that went. */
export class Unsendable extends Data.TaggedError("Unsendable")<{
  readonly why: string;
}> {}

export const cutShort = ({ kind, name }: Operation) =>
  new Internal({ message: `the ${kind} of ${name} ended on its host` });

/** Why an operation its host no longer holds, as `why` tells, ended unreported. */
export const unreported = ({ kind, resource, name }: Operation, why: string) =>
  new Internal({
    message: `the ${kind} of ${resource} ${name} ended before its host reported it: ${why}`,
  });

/**
 * One look at an operation: sends it when its host hasn't had it, and asks for `cancel` first when
 * `cut`. A step `cut` before its host had it is lost, never built or sent, so a later request never
 * waits on building it, as on minting a join's key. `step` builds the step afresh, or fails
 * `Unsendable`, saying why it can't be sent. `absent` under another boot means the host restarted
 * and took the step with it, and a host that refuses the step, as one that has seen a later step
 * of its resource or is another process, never runs it. A host that refuses the request itself, as
 * one of another version does, is unreachable until it takes it.
 */
export const poll = (
  hosts: Hosts,
  op: Operation,
  {
    cut,
    step,
  }: {
    readonly cut: boolean;
    readonly step: Effect.Effect<Step, Internal | Unsendable>;
  }
): Effect.Effect<Polled, Internal> =>
  Effect.gen(function* () {
    if (cut) {
      yield* Effect.ignore(
        hosts.call(op.host, (api) => api.cancelOperation({ id: op.id }))
      );
    }

    const report = yield* hosts.call(op.host, (api) =>
      api.waitOperation({ id: op.id })
    );

    if (report.status === "running") {
      return { at: "running", report } as const;
    }

    if (report.status !== "absent") {
      return { at: "ended", report } as const;
    }

    if (report.boot !== op.boot) {
      return { at: "lost", why: "its host restarted" } as const;
    }

    if (cut) {
      return {
        at: "lost",
        why: "a later request cut it short before its host had it",
      } as const;
    }

    const built = yield* step;

    return yield* hosts
      .call(op.host, (api) =>
        api.runOperation({
          id: op.id,
          boot: op.boot,
          scope: { resource: op.resource, name: op.name },
          sequence: op.sequence,
          step: built,
        })
      )
      .pipe(
        Effect.map((sent): Polled => ({ at: "running", report: sent })),
        Effect.catchTag("Conflict", ({ message }) =>
          Effect.as(
            Effect.logWarning(`host ${op.host} refused ${op.id}: ${message}`),
            { at: "lost", why: `its host refused it: ${message}` } as const
          )
        )
      );
  }).pipe(
    Effect.catchTag("Unsendable", ({ why }) =>
      Effect.succeed<Polled>({
        at: "lost",
        why: `its host never had it, and it can't be sent: ${why}`,
      })
    ),
    Effect.catchTag(["Invalid", "Unanswered", "Incompatible", "Unsent"], () =>
      Effect.succeed<Polled>({ at: "unreachable" })
    )
  );

export const collect = (hosts: Hosts, op: Operation): Effect.Effect<void> =>
  Effect.ignore(
    hosts.call(op.host, (api) => api.collectOperation({ id: op.id }))
  );
