import type { Report, Step } from "@clankerbox/host-contract";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

import type { Interface as Hosts } from "./hosts.ts";
import type { Operation } from "./store.ts";

/** Where a step stands, as far as a look at its host can tell. */
export type Polled =
  | { readonly at: "running"; readonly report: Report }
  | { readonly at: "ended"; readonly report: Report }
  | { readonly at: "lost" }
  | { readonly at: "unreachable" };

const scopeOf = (op: Operation) => `${op.resource} ${op.name}`;

/** What a step cut short says, as its host doesn't. */
export const cutShort = ({ kind, name }: Operation) =>
  new Internal({ message: `the ${kind} of ${name} ended on its host` });

/**
 * One look at an operation: sends it when its host hasn't had it, and asks for `cancel` first when
 * `cut`. `step` builds the step afresh, or answers undefined when it can't be sent again, as a
 * setup that only a process's memory held. `absent` under another boot means the host restarted
 * and took the step with it.
 */
export const poll = (
  hosts: Hosts,
  op: Operation,
  {
    cut,
    step,
  }: {
    readonly cut: boolean;
    readonly step: Effect.Effect<Step | undefined, Internal>;
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
      return { at: "lost" } as const;
    }

    const built = yield* step;

    if (built === undefined) {
      return { at: "lost" } as const;
    }

    const sent = yield* hosts.call(op.host, (api) =>
      api.runOperation({
        id: op.id,
        boot: op.boot,
        scope: scopeOf(op),
        sequence: op.sequence,
        step: built,
      })
    );

    return { at: "running", report: sent } as const;
  }).pipe(
    Effect.catchTag("Unreachable", () =>
      Effect.succeed<Polled>({ at: "unreachable" })
    )
  );

/** Lets the host forget a report once it is stored. */
export const collect = (hosts: Hosts, op: Operation): Effect.Effect<void> =>
  Effect.ignore(
    hosts.call(op.host, (api) => api.collectOperation({ id: op.id }))
  );
