import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import type { SshEndpoint, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, Layer, Option, Semaphore } from "effect";

import { PortProbe } from "./machine-ports.ts";
import { Runtime } from "./runtime.ts";
import type { Dial, Identity, Reach, Target } from "./runtime.ts";
import type { PortRange } from "./settings.ts";

export interface Listener {
  readonly relay: (dial: Dial) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface RelaysInterface {
  readonly bind: (
    address: string,
    port: number
  ) => Effect.Effect<Option.Option<Listener>, Internal>;
}

export class Relays extends Context.Service<Relays, RelaysInterface>()(
  "@clankerbox/host/Relays"
) {}

export interface Reopened {
  readonly machine: Target;
  readonly port: number;
}

export interface Claim {
  readonly port: number;
  readonly release: Effect.Effect<void>;
}

export interface Interface {
  readonly claim: (
    machine: Identity,
    taken: ReadonlySet<number>
  ) => Effect.Effect<Claim, Capacity | Internal>;
  readonly endpoint: (port: number) => SshEndpoint;
  readonly open: (
    machine: Target,
    port: number,
    taken: ReadonlySet<number>
  ) => Effect.Effect<Option.Option<number>, Capacity | Internal>;
  readonly close: (machine: Identity) => Effect.Effect<void>;
  readonly adopt: (
    machines: readonly Reopened[]
  ) => Effect.Effect<ReadonlyMap<string, number>>;
}

export class Reaches extends Context.Service<Reaches, Interface>()(
  "@clankerbox/host/Reaches"
) {}

interface Hold {
  readonly instance: string;
  readonly port: number;
  readonly listener: Listener;
  relaying: boolean;
}

export const make = (
  reach: Reach,
  ports: PortRange
): Effect.Effect<Interface, never, PortProbe | Relays> =>
  Effect.gen(function* () {
    const probe = yield* PortProbe;
    const relays = yield* Relays;
    const { address } = reach;

    const noneFree = new Capacity({
      message: `no free port in ${ports.first}-${ports.last} on ${address}`,
    });

    const endpoint = (port: number): SshEndpoint => ({ host: address, port });

    if (reach._tag === "published") {
      return {
        claim: (_machine, taken) =>
          Effect.gen(function* () {
            for (let port = ports.first; port <= ports.last; port += 1) {
              if (!taken.has(port) && (yield* probe.free(address, port))) {
                return { port, release: Effect.void };
              }
            }

            return yield* noneFree;
          }),
        endpoint,
        open: (_machine, port) => Effect.succeedSome(port),
        close: () => Effect.void,
        adopt: (machines) =>
          Effect.succeed(
            new Map(machines.map(({ machine, port }) => [machine.name, port]))
          ),
      };
    }

    const holds = new Map<string, Hold>();
    const holding = yield* Semaphore.make(1);

    const held = (machine: Identity, hold: Hold) =>
      Effect.andThen(
        Effect.suspend(
          () => holds.get(machine.name)?.listener.close ?? Effect.void
        ),
        Effect.sync(() => {
          holds.set(machine.name, hold);
        })
      );

    const released = (machine: Identity, hold: Hold) =>
      Effect.andThen(
        Effect.sync(() => {
          if (holds.get(machine.name) === hold) {
            holds.delete(machine.name);
          }
        }),
        hold.listener.close
      );

    const firstFree = (taken: ReadonlySet<number>) =>
      Effect.gen(function* () {
        for (let port = ports.first; port <= ports.last; port += 1) {
          if (!taken.has(port)) {
            const bound = yield* relays.bind(address, port);

            if (Option.isSome(bound)) {
              return { port, listener: bound.value };
            }
          }
        }

        return yield* noneFree;
      });

    const relayed = (machine: Target, hold: Hold) =>
      hold.relaying
        ? Effect.void
        : Effect.andThen(
            hold.listener.relay(reach.dial(machine)),
            Effect.sync(() => {
              hold.relaying = true;
            })
          );

    const taking = (machine: Target, port: number, listener: Listener) =>
      Effect.gen(function* () {
        const hold: Hold = {
          instance: machine.instance,
          port,
          listener,
          relaying: false,
        };

        yield* held(machine, hold);
        yield* relayed(machine, hold);

        return port;
      });

    const open: Interface["open"] = (machine, port, taken) =>
      Effect.gen(function* () {
        const hold = holds.get(machine.name);

        if (hold !== undefined) {
          if (hold.instance !== machine.instance) {
            return Option.none<number>();
          }

          yield* relayed(machine, hold);

          return Option.some(hold.port);
        }

        const bound = yield* relays.bind(address, port);

        if (Option.isSome(bound)) {
          return Option.some(yield* taking(machine, port, bound.value));
        }

        const free = yield* firstFree(taken);
        const moved = yield* taking(machine, free.port, free.listener);

        yield* Effect.logInfo(
          `${machine.name}: another program holds port ${port}, so it is reached at ${moved}`
        );

        return Option.some(moved);
      }).pipe(holding.withPermits(1));

    return {
      claim: (machine, taken) =>
        holding.withPermits(1)(
          Effect.gen(function* () {
            const { port, listener } = yield* firstFree(taken);

            const hold: Hold = {
              instance: machine.instance,
              port,
              listener,
              relaying: false,
            };

            yield* held(machine, hold);

            return {
              port,
              release: holding.withPermits(1)(released(machine, hold)),
            };
          })
        ),
      endpoint,
      open,
      close: (machine) =>
        holding.withPermits(1)(
          Effect.suspend(() => {
            const hold = holds.get(machine.name);

            return hold === undefined || hold.instance !== machine.instance
              ? Effect.void
              : released(machine, hold);
          })
        ),
      adopt: (machines) => {
        const given = new Set(machines.map(({ port }) => port));

        return Effect.map(
          Effect.forEach(machines, ({ machine, port }) =>
            open(machine, port, given).pipe(
              Effect.map((at) =>
                Option.match(at, {
                  onNone: () => [],
                  onSome: (reached) => [[machine.name, reached] as const],
                })
              ),
              Effect.catch((error) =>
                Effect.as(
                  Effect.logWarning(
                    `adopt: no relay for ${machine.name}: ${error.message}`
                  ),
                  []
                )
              )
            )
          ),
          (reached) => new Map(reached.flat())
        );
      },
    };
  });

export const layer = (
  ports: PortRange
): Layer.Layer<Reaches, never, Runtime | PortProbe | Relays> =>
  Layer.effect(
    Reaches,
    Effect.flatMap(Runtime, ({ reach }) => make(reach, ports))
  );
