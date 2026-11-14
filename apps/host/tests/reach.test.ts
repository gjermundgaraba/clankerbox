import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Layer, Logger, Option } from "effect";
import { expect } from "vite-plus/test";

import { PortProbe } from "../src/machine-ports.ts";
import * as Relay from "../src/platform/relay.ts";
import * as Reach from "../src/reach.ts";
import { Handle } from "../src/runtime.ts";
import type { Reach as RuntimeReach } from "../src/runtime.ts";
import {
  accepts,
  freePort,
  holding,
  roundTrip,
  suitePorts,
} from "./support.ts";

const at = (name: string, port: number): Reach.Reopened => ({
  machine: {
    name,
    instance: `${name}-instance`,
    handle: Handle.make(`${name}-handle`),
  },
  port,
});

const machineOn = (name: string): Effect.Effect<Reach.Reopened> =>
  Effect.map(freePort, (port) => at(name, port));

const relayed: RuntimeReach = {
  _tag: "relayed",
  address: "127.0.0.1",
  dial: () => (input) => input,
};

const reachesOf = (reach: RuntimeReach) =>
  Effect.flatMap(
    Layer.build(
      Layer.merge(
        Layer.succeed(PortProbe, { free: () => Effect.succeed(true) }),
        Relay.layer
      )
    ),
    (context) =>
      Reach.make(reach, suitePorts.reach).pipe(Effect.provideContext(context))
  );

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a relayed runtime's port carries bytes to its dial", () =>
    Effect.gen(function* () {
      const reaches = yield* reachesOf(relayed);
      const { machine, port } = yield* machineOn("dev");

      yield* reaches.open(machine, port, new Set());

      expect(yield* roundTrip(port, "to the guest and back")).toBe(
        "to the guest and back"
      );
    })
  );

  it.effect(
    "adopt reopens every relay of the machines given, and answers each one's port",
    () =>
      Effect.gen(function* () {
        const reaches = yield* reachesOf(relayed);
        const [up, down] = [yield* machineOn("up"), yield* machineOn("down")];

        const reached = yield* reaches.adopt([up, down]);

        expect([
          yield* accepts(up.port),
          yield* accepts(down.port),
          [...reached],
        ]).toStrictEqual([
          true,
          true,
          [
            ["up", up.port],
            ["down", down.port],
          ],
        ]);
      })
  );

  it.effect(
    "a port another program took while the host was down moves its machine to a free one, which adopt answers and relays",
    () =>
      Effect.gen(function* () {
        const reaches = yield* reachesOf(relayed);

        const [taken, other] = [
          yield* machineOn("dev"),
          yield* machineOn("other"),
        ];

        const logged: unknown[] = [];

        const reached = yield* Effect.scoped(
          Effect.andThen(
            holding(taken.port),
            reaches
              .adopt([taken, other])
              .pipe(
                Effect.provide(
                  Logger.layer([
                    Logger.make(({ message }) => logged.push(message)),
                  ])
                )
              )
          )
        );

        const moved = suitePorts.reach.first;

        expect([...reached]).toStrictEqual([
          ["dev", moved],
          ["other", other.port],
        ]);
        expect(logged).toStrictEqual([
          [
            `dev: another program holds port ${taken.port}, so it is reached at ${moved}`,
          ],
        ]);
        expect(yield* roundTrip(moved, "moved")).toBe("moved");
        expect(yield* accepts(other.port)).toBe(true);
      })
  );

  it.effect(
    "a machine adopt moves takes no port another machine it adopts holds, and each machine whose own port is free keeps it",
    () =>
      Effect.gen(function* () {
        const reaches = yield* reachesOf(relayed);
        const { first } = suitePorts.reach;

        const [taken, next] = [at("dev", first), at("next", first + 1)];

        const reached = yield* Effect.scoped(
          Effect.andThen(holding(taken.port), reaches.adopt([taken, next]))
        );

        expect([...reached]).toStrictEqual([
          ["dev", first + 2],
          ["next", first + 1],
        ]);
      })
  );

  it.effect(
    "an open moves a machine whose port another program holds to the first free port none of the given ones is, and answers where it relays it",
    () =>
      Effect.gen(function* () {
        const reaches = yield* reachesOf(relayed);
        const { first } = suitePorts.reach;
        const { machine } = yield* machineOn("dev");

        const opened = yield* Effect.scoped(
          Effect.andThen(
            holding(first + 3),
            reaches.open(machine, first + 3, new Set([first, first + 1]))
          )
        );

        expect(opened).toStrictEqual(Option.some(first + 2));
        expect(yield* roundTrip(first + 2, "moved")).toBe("moved");
      })
  );

  it.effect(
    "a close after adopt ends the relay, and one of a machine it never opened, or of another instance of its name, does nothing",
    () =>
      Effect.gen(function* () {
        const reaches = yield* reachesOf(relayed);

        const [machine, never] = [
          yield* machineOn("dev"),
          yield* machineOn("never"),
        ];

        yield* reaches.adopt([machine]);

        expect(yield* accepts(machine.port)).toBe(true);

        yield* reaches.close({ ...machine.machine, instance: "earlier" });

        const kept = yield* accepts(machine.port);

        yield* reaches.close(machine.machine);
        yield* reaches.close(never.machine);

        expect([kept, yield* accepts(machine.port)]).toStrictEqual([
          true,
          false,
        ]);
      })
  );

  it.effect(
    "a published runtime binds its own port, so its reach opens nothing",
    () =>
      Effect.gen(function* () {
        const reaches = yield* reachesOf({
          _tag: "published",
          address: "127.0.0.1",
        });

        const adopted = yield* machineOn("dev");

        yield* reaches.open(adopted.machine, adopted.port, new Set());
        yield* reaches.adopt([adopted]);

        expect(yield* accepts(adopted.port)).toBe(false);
      })
  );

  it.effect("either reach answers a port at its host's address", () =>
    Effect.gen(function* () {
      const address = "127.0.0.1";

      const [published, relaying] = yield* Effect.all([
        reachesOf({ _tag: "published", address }),
        reachesOf(relayed),
      ]);

      expect(
        [published, relaying].map((reaches) => reaches.endpoint(2222))
      ).toStrictEqual([
        { host: address, port: 2222 },
        { host: address, port: 2222 },
      ]);
    })
  );
});
