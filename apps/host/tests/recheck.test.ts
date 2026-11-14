import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Internal, readTimeout } from "@gjermundgaraba/clankerbox-sdk";
import { Deferred, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { Handle } from "../src/runtime.ts";
import {
  relayPorts,
  runner,
  ref,
  checkpoint,
  reached,
  portIn,
  keptByRuntime,
  makes,
  delivery,
  deliver,
  ended,
  finished,
  counted,
  sweepLogged,
  portOf,
  locked,
} from "./operations-kit.ts";
import { accepts, pause } from "./support.ts";

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a sweep answers each retired instance whose delete failed, and nothing once a sweep deletes it",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ as: "fixed" });

        keptByRuntime(host, "dev");

        const retired = { machines: ["dev-instance"] };

        host.fake.failNext("delete", new Internal({ message: "EBUSY" }));

        const failed = yield* host.operations.sweep(retired);
        const then = yield* host.operations.sweep(retired);

        expect(failed).toStrictEqual(retired);
        expect(then).toStrictEqual({ machines: [] });
        expect(host.fake.machines.has("dev")).toBe(false);
      })
  );

  it.effect(
    "a sweep warns once of a retired instance whose delete fails, naming its host, logs each sweep after that leaves it at debug, and the one that deletes it at info",
    () => {
      const lines: Array<readonly [string, string]> = [];

      return Effect.gen(function* () {
        const host = yield* runner({ as: "fixed" });

        keptByRuntime(host, "dev");

        const retired = { machines: ["dev-instance"] };

        const refused = () => {
          host.fake.failNext("delete", new Internal({ message: "EBUSY" }));
        };

        refused();
        yield* host.operations.sweep(retired);
        refused();
        yield* host.operations.sweep(retired);
        yield* host.operations.sweep(retired);

        expect(
          lines.filter(([, line]) => line.startsWith("sweep:"))
        ).toStrictEqual([
          [
            "Info",
            "sweep: deleting machine dev-instance (handle), which the control plane retired",
          ],
          [
            "Warn",
            "sweep: couldn't delete machine dev-instance (handle), which stays at its provider until a sweep deletes it, so each sweep of host fixed tries again: EBUSY",
          ],
          ["Debug", "sweep: deleting machine dev-instance (handle) again"],
          [
            "Debug",
            "sweep: still couldn't delete machine dev-instance (handle) on host fixed: EBUSY",
          ],
          ["Debug", "sweep: deleting machine dev-instance (handle) again"],
          [
            "Info",
            "sweep: deleted machine dev-instance (handle), which an earlier sweep couldn't",
          ],
        ]);
      }).pipe(sweepLogged(lines));
    }
  );

  it.effect(
    "a sweep forgets the failed delete of an instance no longer retired, so it warns again once that instance is retired again",
    () => {
      const lines: Array<readonly [string, string]> = [];

      return Effect.gen(function* () {
        const host = yield* runner({ as: "fixed" });

        keptByRuntime(host, "dev");

        const retired = { machines: ["dev-instance"] };

        host.fake.failNext("delete", new Internal({ message: "EBUSY" }));
        yield* host.operations.sweep(retired);
        yield* host.operations.sweep({ machines: ["other-instance"] });
        host.fake.failNext("delete", new Internal({ message: "EBUSY" }));
        yield* host.operations.sweep(retired);

        expect(lines.filter(([level]) => level === "Warn")).toStrictEqual(
          Array.from({ length: 2 }, () => [
            "Warn",
            "sweep: couldn't delete machine dev-instance (handle), which stays at its provider until a sweep deletes it, so each sweep of host fixed tries again: EBUSY",
          ])
        );
      }).pipe(sweepLogged(lines));
    }
  );

  it.effect(
    "a sweep deletes a retired machine with every checkpoint it holds kept",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ as: "fixed" });

        const made = yield* finished(host, makes("dev"));

        const stopped = yield* finished(
          host,
          { _tag: "stop", machine: ref("dev"), machines: [] },
          2
        );

        const captured = yield* finished(host, {
          _tag: "capture",
          machine: ref("dev"),
          checkpoint: checkpoint("snap"),
        });

        yield* Effect.forEach([made, stopped, captured], ({ id }) =>
          host.operations.collect(id)
        );

        const left = yield* host.operations.sweep({
          machines: ["dev-instance"],
        });

        expect(
          host.fake.removals.map(([name, keep]) => [name, [...keep]])
        ).toStrictEqual([["dev-instance", [captured.outcome.handle]]]);
        expect(left).toStrictEqual({ machines: [] });
      })
  );

  it.effect(
    "a sweep spares a retired machine a step the host holds names, and deletes it once that step is collected",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ as: "fixed" });

        keptByRuntime(host, "dev");

        const held = host.fake.holdNext("stop");

        const stop = delivery(
          { _tag: "stop", machine: ref("dev"), machines: [] },
          1
        );

        yield* deliver(host, stop);
        yield* held.entered;
        yield* Effect.sleep(Duration.millis(5));

        const retired = { machines: ["dev-instance"] };

        const named = yield* host.operations.sweep(retired);

        const whileHeld = counted(host.fake.calls, "delete dev-instance");

        yield* held.release;
        yield* ended(host, stop.id);
        yield* host.operations.collect(stop.id);

        const collected = yield* host.operations.sweep(retired);

        expect([
          whileHeld,
          counted(host.fake.calls, "delete dev-instance"),
        ]).toStrictEqual([0, 1]);
        expect([named, collected]).toStrictEqual([retired, { machines: [] }]);
      })
  );

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

layer(NodeServices.layer)((it) => {
  it.effect(
    "a sweep waits out a delete its runtime masks, so a sweep while it runs starts no second delete of the instance",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ as: "fixed" });

        keptByRuntime(host, "dev");

        const { entered, release } = host.fake.holdNext("delete", {
          runsOn: true,
        });

        const retired = { machines: ["dev-instance"] };
        const first = yield* Effect.forkChild(host.operations.sweep(retired));

        yield* entered;
        yield* TestClock.adjust(readTimeout);

        const second = yield* Effect.forkChild(host.operations.sweep(retired));

        yield* TestClock.adjust(readTimeout);

        const whileHeld = [
          counted(host.fake.calls, "delete dev-instance"),
          first.pollUnsafe() === undefined,
          second.pollUnsafe() === undefined,
        ];

        yield* release;

        const none = { machines: [] };

        expect([
          whileHeld,
          yield* Fiber.join(first),
          yield* Fiber.join(second),
          counted(host.fake.calls, "delete dev-instance"),
        ]).toStrictEqual([[1, true, true], none, none, 1]);
      })
  );
});
