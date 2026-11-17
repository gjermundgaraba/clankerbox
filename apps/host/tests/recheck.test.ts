import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vite-plus/test";

import { Handle } from "../src/runtime.ts";
import {
  relayPorts,
  runner,
  ref,
  reached,
  portIn,
  keptByRuntime,
  makes,
  finished,
  portOf,
  locked,
} from "./operations-kit.ts";
import { accepts, pause } from "./support.ts";

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "an adopt the control plane sent before a remove that the host has since run and forgotten opens no relay for the deleted machine",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true });
        const made = yield* finished(host, makes("dev"));

        const dev = ref("dev", {
          ...reached(portOf(made) ?? 0),
          ...(made.outcome.handle === undefined
            ? {}
            : { handle: made.outcome.handle }),
        });

        const removed = yield* finished(
          host,
          { _tag: "remove", machine: dev, keep: [] },
          2
        );

        yield* host.operations.collect(made.id);
        yield* host.operations.collect(removed.id);

        const adoption = yield* host.operations.adopt([dev]);

        expect([
          removed.status,
          adoption.adopted.map(({ name }) => name),
          yield* accepts(portIn(dev)),
        ]).toStrictEqual(["done", ["dev"], false]);
      })
  );

  it.effect(
    "an adopt answers the handle and endpoint of each machine it resolved, names the one whose search failed, reopens every relay it can, and resolves that one once its search answers",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true });

        keptByRuntime(host, "ok");
        keptByRuntime(host, "broken");
        host.fake.failFind("broken", locked);

        const ok = ref("ok", { port: relayPorts + 1 });
        const broken = ref("broken", { port: relayPorts + 2 });
        const first = yield* host.operations.adopt([ok, broken]);

        yield* pause;

        const reachedFirst = [
          yield* accepts(relayPorts + 1),
          yield* accepts(relayPorts + 2),
        ];

        host.fake.mendFind("broken");

        const again = yield* host.operations.adopt([
          { ...ok, handle: Handle.make("held-ok") },
          broken,
        ]);

        yield* pause;

        expect(first).toStrictEqual({
          adopted: [
            {
              name: "ok",
              instance: "ok-instance",
              handle: Handle.make("held-ok"),
              endpoint: { host: "127.0.0.1", port: relayPorts + 1 },
            },
          ],
          unresolved: ["broken"],
        });
        expect(reachedFirst).toStrictEqual([true, false]);
        expect(again.unresolved).toStrictEqual([]);
        expect(
          again.adopted.map(({ name, handle }) => [name, handle])
        ).toStrictEqual([
          ["ok", Handle.make("held-ok")],
          ["broken", Handle.make("held-broken")],
        ]);
        expect(yield* accepts(relayPorts + 2)).toBe(true);
        expect(
          host.fake.calls.filter((call) => call.startsWith("relay"))
        ).toStrictEqual(["relay ok", "relay broken"]);
      })
  );

  it.effect(
    "an adopt leaves closed the relay of a machine removed while it searched for another",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<undefined>();

        const host = yield* runner({
          relayed: true,
          runtime: (fake) => ({
            ...fake,
            find: (machine) =>
              machine.name === "slow"
                ? Effect.andThen(Deferred.await(gate), fake.find(machine))
                : fake.find(machine),
          }),
        });

        keptByRuntime(host, "gone");
        keptByRuntime(host, "slow");

        const gone = ref("gone", {
          handle: Handle.make("held-gone"),
          port: relayPorts + 1,
        });

        const slow = ref("slow", { port: relayPorts + 2 });

        yield* host.operations.adopt([gone]);
        yield* pause;

        const openBefore = yield* accepts(relayPorts + 1);

        const again = yield* Effect.forkChild(
          host.operations.adopt([gone, slow])
        );

        yield* pause;

        const removed = yield* finished(
          host,
          { _tag: "remove", machine: gone, keep: [] },
          2
        );

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(again);
        yield* pause;

        expect([openBefore, removed.status]).toStrictEqual([true, "done"]);
        expect(yield* accepts(relayPorts + 1)).toBe(false);
        expect(yield* accepts(relayPorts + 2)).toBe(true);
      })
  );
});
