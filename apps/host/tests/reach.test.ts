import { once } from "node:events";
import { connect } from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";
import { expect } from "vite-plus/test";

import { PortProbe } from "../src/machine-ports.ts";
import * as Relay from "../src/platform/relay.ts";
import * as Reach from "../src/reach.ts";
import { Handle } from "../src/runtime.ts";
import type { Reach as RuntimeReach } from "../src/runtime.ts";
import { accepts, holding } from "./support.ts";

let nextPort = 21_500;

const machineOn = (name: string): Reach.Reopened => {
  const port = nextPort;

  nextPort += 1;

  return {
    machine: {
      name,
      instance: `${name}-instance`,
      handle: Handle.make(`${name}-handle`),
    },
    port,
  };
};

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
      Reach.make(reach, { first: 21_500, last: 21_599 }).pipe(
        Effect.provideContext(context)
      )
  );

const roundTrip = (port: number, payload: string) =>
  Effect.promise(async () => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];

    await once(socket, "connect");
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    const ended = once(socket, "end");

    socket.end(payload);
    await ended;
    socket.destroy();

    return Buffer.concat(chunks).toString();
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a relayed runtime's port carries bytes to its dial", () =>
    Effect.gen(function* () {
      const reaches = yield* reachesOf(relayed);
      const { machine, port } = machineOn("dev");

      yield* reaches.open(machine, port);

      expect(yield* roundTrip(port, "to the guest and back")).toBe(
        "to the guest and back"
      );
    })
  );

  it.effect("adopt reopens every relay of the machines given", () =>
    Effect.gen(function* () {
      const reaches = yield* reachesOf(relayed);
      const [up, down] = [machineOn("up"), machineOn("down")];

      yield* reaches.adopt([up, down]);

      expect([
        yield* accepts(up.port),
        yield* accepts(down.port),
      ]).toStrictEqual([true, true]);
    })
  );

  it.effect("a port adopt can't listen on is logged and the rest served", () =>
    Effect.gen(function* () {
      const reaches = yield* reachesOf(relayed);
      const [blocked, other] = [machineOn("dev"), machineOn("other")];
      const logged: unknown[] = [];

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holding(blocked.port);

          yield* reaches
            .adopt([blocked, other])
            .pipe(
              Effect.provide(
                Logger.layer([
                  Logger.make(({ message }) => logged.push(message)),
                ])
              )
            );
        })
      );

      expect(logged).toStrictEqual([
        [
          expect.stringMatching(
            new RegExp(
              `^adopt: no relay for dev: the relay couldn't listen on 127\\.0\\.0\\.1:${blocked.port}: `,
              "u"
            )
          ),
        ],
      ]);
      expect(yield* accepts(other.port)).toBe(true);
    })
  );

  it.effect(
    "a close after adopt ends the relay, knowing the machine only by name, and one of a machine it never opened does nothing",
    () =>
      Effect.gen(function* () {
        const reaches = yield* reachesOf(relayed);
        const [machine, never] = [machineOn("dev"), machineOn("never")];

        yield* reaches.adopt([machine]);

        expect(yield* accepts(machine.port)).toBe(true);

        yield* reaches.close(machine.machine.name);
        yield* reaches.close(never.machine.name);

        expect(yield* accepts(machine.port)).toBe(false);
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

        const adopted = machineOn("dev");

        yield* reaches.open(adopted.machine, adopted.port);
        yield* reaches.adopt([adopted]);

        expect(yield* accepts(adopted.port)).toBe(false);
      })
  );

  it.effect(
    "either reach answers a port at its host's address, and only a published one has the runtime bind it",
    () =>
      Effect.gen(function* () {
        const address = "127.0.0.1";

        const [published, relaying] = yield* Effect.all([
          reachesOf({ _tag: "published", address }),
          reachesOf(relayed),
        ]);

        expect(
          [published, relaying].map((reaches) => [
            reaches.endpoint(2222),
            reaches.bind(2222),
          ])
        ).toStrictEqual([
          [
            { host: address, port: 2222 },
            { _tag: "forward", port: 2222 },
          ],
          [{ host: address, port: 2222 }, { _tag: "none" }],
        ]);
      })
  );
});
