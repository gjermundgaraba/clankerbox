import type { Report, Step } from "@clankerbox/host-contract";
import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, Layer } from "effect";

import { Hosts } from "./hosts.ts";
import type { Unreachable } from "./hosts.ts";
import { Store } from "./store.ts";
import type { Finish, Operation } from "./store.ts";

/** Where a step stands, as far as a look at its host can tell. */
export type Polled =
  | { readonly at: "running"; readonly report: Report }
  | { readonly at: "ended"; readonly report: Report }
  | { readonly at: "lost" }
  | { readonly at: "unreachable"; readonly error: Unreachable };

export interface Interface {
  /**
   * One look at an operation: sends it when its host hasn't had it, and asks for `cancel` first
   * when `cut`. `steps` builds the step afresh, or answers undefined when it can't be sent again,
   * as a setup that only a process's memory held. `absent` under another boot means the host
   * restarted and took the step with it.
   */
  readonly poll: (
    op: Operation,
    options: {
      readonly cut: boolean;
      readonly step: Effect.Effect<Step | undefined, Internal>;
    }
  ) => Effect.Effect<Polled, Internal>;
  /** Stores the report, then lets the host forget it. */
  readonly finish: (
    op: Operation,
    finish: Finish
  ) => Effect.Effect<void, Internal>;
}

export class Operations extends Context.Service<Operations, Interface>()(
  "@clankerbox/server/Operations"
) {}

const scopeOf = (op: Operation) => `${op.resource} ${op.name}`;

export const make: Effect.Effect<Interface, never, Store | Hosts> = Effect.gen(
  function* () {
    const store = yield* Store;
    const hosts = yield* Hosts;

    const poll: Interface["poll"] = (op, { cut, step }) =>
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
            scope: scopeOf(op),
            sequence: op.sequence,
            step: built,
          })
        );

        return { at: "running", report: sent } as const;
      }).pipe(
        Effect.catchTag("Unreachable", (error) =>
          Effect.succeed<Polled>({ at: "unreachable", error })
        )
      );

    const finish: Interface["finish"] = (op, finished) =>
      Effect.andThen(
        store.finish(op, finished),
        Effect.ignore(
          hosts.call(op.host, (api) => api.collectOperation({ id: op.id }))
        )
      );

    return { poll, finish } satisfies Interface;
  }
);

export const layer: Layer.Layer<Operations, never, Store | Hosts> =
  Layer.effect(Operations, make);
