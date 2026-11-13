import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import type { Internal, SshEndpoint } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, Layer } from "effect";

import { PortProbe } from "./machine-ports.ts";
import type { PortRange } from "./machine-ports.ts";
import { Runtime } from "./runtime.ts";
import type { Bind, Dial, Reach, Target } from "./runtime.ts";

export interface RelaysInterface {
  readonly listen: (
    address: string,
    port: number,
    dialer: () => Dial
  ) => Effect.Effect<void, Internal>;
  readonly close: (port: number) => Effect.Effect<void>;
}

export class Relays extends Context.Service<Relays, RelaysInterface>()(
  "@clankerbox/host/Relays"
) {}

export interface Reopened {
  readonly machine: Target;
  readonly port: number;
}

export interface Interface {
  readonly pick: (
    taken: ReadonlySet<number>
  ) => Effect.Effect<number, Capacity | Internal>;
  readonly endpoint: (port: number) => SshEndpoint;
  readonly bind: (port: number) => Bind;
  readonly open: (
    machine: Target,
    port: number
  ) => Effect.Effect<void, Internal>;
  readonly close: (name: string) => Effect.Effect<void>;
  readonly adopt: (machines: readonly Reopened[]) => Effect.Effect<void>;
}

export class Reaches extends Context.Service<Reaches, Interface>()(
  "@clankerbox/host/Reaches"
) {}

export const make = (
  reach: Reach,
  ports: PortRange
): Effect.Effect<Interface, never, PortProbe | Relays> =>
  Effect.gen(function* () {
    const probe = yield* PortProbe;
    const relays = yield* Relays;
    const { address } = reach;

    const pick: Interface["pick"] = (taken) =>
      Effect.gen(function* () {
        for (let port = ports.first; port <= ports.last; port += 1) {
          if (!taken.has(port) && (yield* probe.free(address, port))) {
            return port;
          }
        }

        return yield* new Capacity({
          message: `no free port in ${ports.first}-${ports.last} on ${address}`,
        });
      });

    const endpoint = (port: number): SshEndpoint => ({ host: address, port });

    if (reach._tag === "published") {
      return {
        pick,
        endpoint,
        bind: (port) => ({ _tag: "forward", port }),
        open: () => Effect.void,
        close: () => Effect.void,
        adopt: () => Effect.void,
      };
    }

    const relayed = new Map<string, number>();

    const open: Interface["open"] = (machine, port) =>
      Effect.andThen(
        Effect.sync(() => relayed.set(machine.name, port)),
        relays.listen(address, port, () => reach.dial(machine))
      );

    return {
      pick,
      endpoint,
      bind: () => ({ _tag: "none" }),
      open,
      close: (name) =>
        Effect.suspend(() => {
          const port = relayed.get(name);

          relayed.delete(name);

          return port === undefined ? Effect.void : relays.close(port);
        }),
      adopt: (machines) =>
        Effect.forEach(
          machines,
          ({ machine, port }) =>
            open(machine, port).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `adopt: no relay for ${machine.name}: ${error.message}`
                )
              )
            ),
          { discard: true }
        ),
    };
  });

export const layer = (
  ports: PortRange
): Layer.Layer<Reaches, never, Runtime | PortProbe | Relays> =>
  Layer.effect(
    Reaches,
    Effect.flatMap(Runtime, ({ reach }) => make(reach, ports))
  );
