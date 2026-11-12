import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, Layer } from "effect";

import { PortProbe } from "./machine-ports.ts";
import type { PortRange } from "./machine-ports.ts";
import { Runtime } from "./runtime.ts";
import type { Dial, MachineRef, Native, Reach } from "./runtime.ts";

export interface RelaysInterface {
  readonly listen: (port: number, dial: Dial) => Effect.Effect<void, Internal>;
  readonly close: (port: number) => Effect.Effect<void>;
}

export class Relays extends Context.Service<Relays, RelaysInterface>()(
  "@clankerbox/host/Relays"
) {}

export interface Interface {
  readonly pick: (
    taken: ReadonlySet<number>
  ) => Effect.Effect<number, Capacity | Internal>;
  readonly open: (machine: MachineRef) => Effect.Effect<void, Internal>;
  readonly close: (machine: Native) => Effect.Effect<void>;
  readonly adopt: (machines: readonly MachineRef[]) => Effect.Effect<void>;
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

    const pick: Interface["pick"] = (taken) =>
      Effect.gen(function* () {
        for (let port = ports.first; port <= ports.last; port += 1) {
          if (!taken.has(port) && (yield* probe.free(reach.address, port))) {
            return port;
          }
        }

        return yield* new Capacity({
          message: `no free port in ${ports.first}-${ports.last} on ${reach.address}`,
        });
      });

    if (reach._tag === "published") {
      return {
        pick,
        open: () => Effect.void,
        close: () => Effect.void,
        adopt: () => Effect.void,
      };
    }

    const relayed = new Map<string, number>();

    const open: Interface["open"] = (machine) =>
      Effect.andThen(
        Effect.sync(() => relayed.set(machine.name, machine.port)),
        relays.listen(machine.port, reach.dial(machine))
      );

    return {
      pick,
      open,
      close: ({ name }) =>
        Effect.suspend(() => {
          const port = relayed.get(name);

          relayed.delete(name);

          return port === undefined ? Effect.void : relays.close(port);
        }),
      adopt: (machines) =>
        Effect.forEach(
          machines,
          (machine) =>
            open(machine).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `adopt: no forwarder for ${machine.name}: ${error.message}`
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
