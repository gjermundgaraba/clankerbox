import { cpSync, rmSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import type { BuildRequest } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Duration, Effect, Fiber } from "effect";
import { expect } from "vite-plus/test";

import {
  callsTo,
  clientOf,
  eventually,
  firstHost,
  plane,
  request,
  restartedHost,
  running,
} from "./support.ts";
import type { Started } from "./support.ts";

type Checkpoints = "held" | "marked";

const fixed = (checkpoints: Checkpoints) => ({
  id: "fixed",
  as: "fixed" as const,
  options: { runtime: { owned: { checkpoints } } },
});

const onFixed = (
  options: { recheck?: Duration.Duration; checkpoints?: Checkpoints } = {}
) =>
  Effect.gen(function* () {
    const served = yield* running({
      hosts: [fixed(options.checkpoints ?? "held")],
      ...(options.recheck === undefined ? {} : { recheck: options.recheck }),
    });

    return {
      ...served,
      client: yield* clientOf(served.url),
      host: firstHost(served),
    };
  });

const onPlane = (checkpoints: Checkpoints = "held") =>
  Effect.gen(function* () {
    const planned = yield* plane({
      hosts: [fixed(checkpoints)],
      recheck: Duration.millis(100),
    });

    return { ...planned, host: firstHost(planned) };
  });

const handleOf = (served: Pick<Started, "store">, name: string) =>
  Effect.map(
    served.store.checkpoints,
    (rows) => rows.find((row) => row.name === name)?.handle
  );

const web: BuildRequest = {
  template: "web",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  setup: { script: "#!/bin/sh\n", timeoutSeconds: 30 },
};

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a remove carries every checkpoint handle of its host", () =>
    Effect.gen(function* () {
      const served = yield* onFixed();

      for (const name of ["one", "two"]) {
        yield* served.client.create(name, request(name));
        yield* served.client.stopMachine({ id: name });
        yield* served.client.captureCheckpoint({
          machine: name,
          name: `${name}-snap`,
        });
      }

      const handles = [
        yield* handleOf(served, "one-snap"),
        yield* handleOf(served, "two-snap"),
      ];

      yield* served.client.deleteMachine({ id: "one" });

      const restored = yield* served.client.restoreMachine({
        checkpoint: "one-snap",
        name: "copy",
      });

      expect(
        served.host.fake.removals.map(([name, keep]) => [name, new Set(keep)])
      ).toStrictEqual([["one", new Set(handles)]]);
      expect(restored.phase).toBe("settled");
    })
  );

  it.effect("a start carries every checkpoint handle of its host", () =>
    Effect.gen(function* () {
      const served = yield* onFixed();

      for (const name of ["one", "two"]) {
        yield* served.client.create(name, request(name));
        yield* served.client.stopMachine({ id: name });
        yield* served.client.captureCheckpoint({
          machine: name,
          name: `${name}-snap`,
        });
      }

      const handles = [
        yield* handleOf(served, "one-snap"),
        yield* handleOf(served, "two-snap"),
      ];

      yield* served.client.startMachine({ id: "one" });

      const [name, keep] = served.host.fake.starts.at(-1) ?? [];

      expect([name, new Set(keep)]).toStrictEqual(["one", new Set(handles)]);
    })
  );

  it.effect(
    "a row with no handle of a checkpoint its host holds through its machine is asked about once, and keeps none",
    () =>
      Effect.gen(function* () {
        const served = yield* onFixed({ recheck: Duration.millis(50) });

        yield* served.client.create("dev", request("dev"));
        yield* served.client.stopMachine({ id: "dev" });
        yield* served.client.captureCheckpoint({
          machine: "dev",
          name: "snap",
        });
        yield* served.store.advance("checkpoint", "snap", (row) => ({
          next: { ...row, handle: undefined },
          finish: false,
        }));

        served.host.fake.searches.length = 0;

        yield* eventually(
          Effect.sync(() => [...served.host.fake.searches]),
          (searches) => searches.includes("checkpoint snap")
        );
        yield* Effect.sleep(Duration.millis(300));

        expect(
          served.host.fake.searches.filter(
            (search) => search === "checkpoint snap"
          )
        ).toStrictEqual(["checkpoint snap"]);
        expect(yield* handleOf(served, "snap")).toBeUndefined();
      })
  );

  it.effect("a build's copy outlives the delete of its builder", () =>
    Effect.gen(function* () {
      const served = yield* onFixed();
      const built = yield* served.client.buildTemplate(web);

      const builder = yield* eventually(
        Effect.sync(() => served.host.fake.removals.map(([name]) => name)),
        (removed) => removed.length > 0
      );

      const created = yield* served.client.create("dev", { template: "web" });

      expect(built.phase).toBe("ready");
      expect(builder).toHaveLength(1);
      expect(created.phase).toBe("settled");
    })
  );

  it.effect(
    "a make that lands after its row rested undone is swept, and the machine that replaced the row is kept",
    () =>
      Effect.gen(function* () {
        const served = yield* onFixed({ recheck: Duration.millis(20) });

        yield* served.host.fake.faults.landLate("400 millis");

        const failed = yield* Effect.exit(
          served.client.create("dev", request("dev"))
        );

        const [undone] = yield* served.store.machines;
        const replaced = yield* served.client.create("dev", request("dev"));

        yield* eventually(
          Effect.sync(() => callsTo(served.host, "delete")),
          (deletes) => deletes.includes(`delete ${undone?.instance}`)
        );

        expect(failed._tag).toBe("Failure");
        expect(replaced.phase).toBe("settled");
        expect(
          [...served.host.fake.machines.values()].map(
            ({ instance }) => instance
          )
        ).toStrictEqual([(yield* served.store.machines)[0]?.instance]);
      })
  );

  it.effect(
    "a sweep of what was retired before a create keeps the machine it makes, whatever the clocks say",
    () =>
      Effect.gen(function* () {
        const served = yield* onFixed();

        yield* served.client.create("old", request("old"));
        yield* served.client.deleteMachine({ id: "old" });

        const retired = yield* served.store.retired("fixed");
        const created = yield* served.client.create("dev", request("dev"));

        yield* served.host.operations.sweep(retired);

        expect(retired.machines).toHaveLength(1);
        expect(created.phase).toBe("settled");
        expect(callsTo(served.host, "delete")).toStrictEqual(["delete old"]);
        expect(served.host.fake.machines.has("dev")).toBe(true);
      })
  );

  for (const checkpoints of ["held", "marked"] as const) {
    it.effect(
      `a sweep of what was retired before a capture keeps the ${checkpoints} checkpoint it makes`,
      () =>
        Effect.gen(function* () {
          const served = yield* onFixed({ checkpoints });

          yield* served.client.create("old", request("old"));
          yield* served.client.deleteMachine({ id: "old" });
          yield* served.client.create("dev", request("dev"));
          yield* served.client.stopMachine({ id: "dev" });

          const retired = yield* served.store.retired("fixed");

          yield* served.client.captureCheckpoint({
            machine: "dev",
            name: "snap",
          });
          yield* Effect.sleep(Duration.millis(200));
          yield* served.host.operations.sweep(retired);

          const restored = yield* served.client.restoreMachine({
            checkpoint: "snap",
            name: "copy",
          });

          expect(retired.machines).toHaveLength(1);
          expect(callsTo(served.host, "deleteCheckpoint")).toStrictEqual([]);
          expect(callsTo(served.host, "delete")).toStrictEqual(["delete old"]);
          expect(served.host.fake.machines.has("dev")).toBe(true);
          expect(restored.phase).toBe("settled");
        })
    );
  }

  it.effect(
    "the recheck's sweeps keep a machine a row wants beside one the store retired",
    () =>
      Effect.gen(function* () {
        const served = yield* onFixed({ recheck: Duration.millis(100) });
        const created = yield* served.client.create("dev", request("dev"));

        yield* served.client.create("old", request("old"));
        yield* served.client.deleteMachine({ id: "old" });
        yield* Effect.sleep(Duration.seconds(1));

        expect((yield* served.store.retired("fixed")).machines).toHaveLength(1);
        expect(created.phase).toBe("settled");
        expect(callsTo(served.host, "delete")).toStrictEqual(["delete old"]);
        expect(served.host.fake.machines.has("dev")).toBe(true);
      })
  );

  it.effect(
    "a retired instance outlives any time its host doesn't answer, and its day runs from the first sweep that reached the host",
    () =>
      Effect.gen(function* () {
        const served = yield* onFixed({ recheck: Duration.millis(100) });
        const longAfter = DateTime.makeUnsafe("2100-01-01T00:00:00Z");

        yield* served.client.create("old", request("old"));
        yield* served.host.dispose;
        yield* served.store.advance("machine", "old", () => ({
          next: "removed",
          finish: false,
        }));
        yield* Effect.sleep(Duration.seconds(1));
        yield* served.store.forgetRetired(longAfter);

        const whileDown = yield* served.store.retired("fixed");
        const back = yield* restartedHost(served.host);

        yield* Effect.addFinalizer(() => back.dispose);

        const once = yield* eventually(
          Effect.andThen(
            served.store.forgetRetired(longAfter),
            served.store.retired("fixed")
          ),
          ({ machines }) => machines.length === 0
        );

        expect(whileDown.machines).toHaveLength(1);
        expect(once.machines).toStrictEqual([]);
        expect(back.fake.calls).toContain("marked machines");
      })
  );

  it.effect(
    "a remove asked during a capture runs once the capture's handle is stored, and keeps it",
    () =>
      Effect.gen(function* () {
        const served = yield* onFixed();

        yield* served.client.create("dev", request("dev"));
        yield* served.client.stopMachine({ id: "dev" });

        const held = served.host.fake.holdNext("capture");

        const capture = yield* Effect.forkChild(
          served.client.captureCheckpoint({ machine: "dev", name: "snap" })
        );

        yield* held.entered;

        const removal = yield* Effect.forkChild(
          Effect.exit(served.client.deleteMachine({ id: "dev" }))
        );

        yield* Effect.sleep(Duration.millis(500));

        const whileHeld = served.host.fake.removals.length;

        yield* held.release;
        yield* Fiber.join(capture);
        yield* Fiber.join(removal);

        if (served.host.fake.removals.length === 0) {
          yield* served.client.deleteMachine({ id: "dev" });
        }

        const snap = yield* handleOf(served, "snap");

        const restored = yield* served.client.restoreMachine({
          checkpoint: "snap",
          name: "copy",
        });

        expect(whileHeld).toBe(0);
        expect(
          served.host.fake.removals.map(([name, keep]) => [name, [...keep]])
        ).toStrictEqual([["dev", [snap]]]);
        expect(restored.phase).toBe("settled");
      })
  );

  it.effect(
    "a control plane over a wiped store sweeps only what it retired, and nothing of the first store's",
    () =>
      Effect.gen(function* () {
        const planned = yield* onPlane("marked");
        const first = yield* planned.start();
        const client = yield* clientOf(first.url);

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* first.crash;

        rmSync(planned.stateDir, { recursive: true, force: true });

        const second = yield* planned.start();
        const other = yield* clientOf(second.url);

        yield* Effect.addFinalizer(() => second.crash);
        yield* other.create("its-own", request("its-own"));
        yield* other.deleteMachine({ id: "its-own" });
        yield* Effect.sleep(Duration.seconds(1));

        expect((yield* second.store.retired("fixed")).machines).toHaveLength(1);
        expect(callsTo(planned.host, "deleteCheckpoint")).toStrictEqual([]);
        expect(callsTo(planned.host, "delete")).toStrictEqual([
          "delete its-own",
        ]);
        expect(planned.host.fake.machines.has("dev")).toBe(true);
      })
  );

  it.effect(
    "a second control plane over the same host deletes nothing of the first one's",
    () =>
      Effect.gen(function* () {
        const planned = yield* onPlane();
        const aside = `${planned.dir}/first-store`;
        const first = yield* planned.start();

        yield* (yield* clientOf(first.url)).create("dev", request("dev"));
        yield* first.crash;

        cpSync(planned.stateDir, aside, { recursive: true });
        rmSync(planned.stateDir, { recursive: true, force: true });

        const other = yield* planned.start();
        const otherClient = yield* clientOf(other.url);

        yield* otherClient.create("its-own", request("its-own"));
        yield* otherClient.deleteMachine({ id: "its-own" });
        yield* Effect.sleep(Duration.seconds(1));
        yield* other.crash;

        rmSync(planned.stateDir, { recursive: true, force: true });
        cpSync(aside, planned.stateDir, { recursive: true });

        const back = yield* planned.start();

        yield* Effect.addFinalizer(() => back.crash);
        yield* Effect.sleep(Duration.seconds(1));

        const [row] = yield* back.store.machines;

        expect(row?.name).toBe("dev");
        expect(callsTo(planned.host, "delete")).toStrictEqual([
          "delete its-own",
        ]);
        expect(planned.host.fake.machines.has("dev")).toBe(true);
      })
  );

  it.effect(
    "a control plane restored from a backup sweeps only what it retired, and no machine made after the backup",
    () =>
      Effect.gen(function* () {
        const planned = yield* onPlane();
        const backup = `${planned.dir}/backup`;
        const first = yield* planned.start();

        yield* (yield* clientOf(first.url)).create("old", request("old"));
        yield* first.crash;

        cpSync(planned.stateDir, backup, { recursive: true });

        const second = yield* planned.start();

        yield* (yield* clientOf(second.url)).create("new", request("new"));
        yield* second.crash;

        rmSync(planned.stateDir, { recursive: true, force: true });
        cpSync(backup, planned.stateDir, { recursive: true });

        const restored = yield* planned.start();
        const client = yield* clientOf(restored.url);

        yield* Effect.addFinalizer(() => restored.crash);
        yield* client.create("gone", request("gone"));
        yield* client.deleteMachine({ id: "gone" });
        yield* Effect.sleep(Duration.seconds(1));

        expect(callsTo(planned.host, "delete")).toStrictEqual(["delete gone"]);
        expect([...planned.host.fake.machines.keys()].toSorted()).toStrictEqual(
          ["new", "old"]
        );
      })
  );
});
