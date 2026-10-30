import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";
import { expect } from "vite-plus/test";

import {
  at,
  clientOf,
  eventually,
  pause,
  plane,
  request,
  restartedHost,
  running,
} from "./support.ts";
import type { Started } from "./support.ts";

const killedPlane = (options?: Parameters<typeof plane>[0]) =>
  Effect.gen(function* () {
    const planned = yield* plane(options);
    const first = yield* planned.start();
    const client = yield* clientOf(first.url);
    const asking = yield* clientOf(first.url, { noWait: true });
    const { fake } = planned.hosts[0]!;

    const restart = Effect.gen(function* () {
      yield* first.crash;

      const second = yield* planned.start();

      yield* Effect.addFinalizer(() => second.crash);

      return {
        ...second,
        client: yield* clientOf(second.url),
        rests: (name: string) =>
          eventually(second.store.findMachine(name), (found) =>
            Option.exists(found, ({ phase }) => phase === "settled")
          ),
        gone: (name: string) =>
          eventually(second.store.findMachine(name), Option.isNone),
      };
    });

    return { planned, first, client, asking, fake, restart };
  });

const unsent = (
  store: Started["store"],
  host: string,
  boot: string,
  name: string,
  kind: "make" | "stop",
  generation: number
) =>
  store.begin(
    {
      id: `unsent-${name}`,
      kind,
      resource: "machine",
      name,
      host,
      boot,
      generation,
      seen: kind === "stop" ? "running" : "unknown",
      leases: [{ resource: "machine", name, mode: "own" }],
    },
    kind === "stop" ? "stopping" : "creating",
    {}
  );

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a create runs to a running machine, and a delete takes it away",
    () =>
      Effect.gen(function* () {
        const served = yield* running();
        const client = yield* clientOf(served.url);

        const machine = yield* client.create("dev", request("dev"));

        expect(at(machine)).toStrictEqual(["running", "running", "settled"]);
        expect(machine.id).toBe("dev");

        expect(yield* client.stopMachine({ id: "dev" })).toMatchObject({
          state: "stopped",
        });

        expect(yield* client.deleteMachine({ id: "dev" })).toBe("deleted");
        expect(yield* client.machines).toStrictEqual([]);
      })
  );

  it.effect(
    "a control plane killed mid-create finishes the create when it comes back",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const [host] = planned.hosts;
        const copying = host!.fake.holdNext("create");
        const first = yield* planned.start();
        const client = yield* clientOf(first.url, { noWait: true });

        yield* client.create("dev", request("dev"));
        yield* copying.entered;
        yield* first.crash;
        yield* copying.release;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        const row = yield* eventually(
          second.store.findMachine("dev"),
          (found) => Option.exists(found, ({ phase }) => phase === "settled")
        );

        expect(Option.getOrThrow(row).stage).toBe("made");
      })
  );

  it.effect(
    "a control plane killed mid-delete finishes it, deleting once",
    () =>
      Effect.gen(function* () {
        const { client, asking, fake, restart } = yield* killedPlane();

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const deleting = fake.holdNext("delete");

        yield* asking.deleteMachine({ id: "dev" });
        yield* deleting.entered;

        const second = yield* restart;

        yield* deleting.release;
        yield* second.gone("dev");

        expect(fake.calls).toStrictEqual(["delete dev"]);
        expect(fake.machines.size).toBe(0);
      })
  );

  it.effect("a control plane killed mid-start finishes the start", () =>
    Effect.gen(function* () {
      const { client, asking, fake, restart } = yield* killedPlane();

      yield* client.create("dev", request("dev"));
      yield* client.stopMachine({ id: "dev" });

      const booting = fake.holdNext("admit");

      yield* asking.startMachine({ id: "dev" });
      yield* booting.entered;

      const second = yield* restart;

      yield* booting.release;
      yield* second.rests("dev");

      expect(at(yield* second.client.getMachine({ id: "dev" }))).toStrictEqual([
        "running",
        "running",
        "settled",
      ]);
    })
  );

  it.effect(
    "a control plane killed mid-preparation finishes it, and the machine is made",
    () =>
      Effect.gen(function* () {
        const { asking, fake, restart } = yield* killedPlane();
        const preparing = fake.holdNext("exec");

        yield* asking.create("dev", request("dev"));
        yield* preparing.entered;

        const second = yield* restart;

        yield* preparing.release;

        const found = Option.getOrThrow(yield* second.rests("dev"));

        expect([found.stage, found.prepared]).toStrictEqual(["made", true]);
      })
  );

  it.effect(
    "a control plane killed mid-setup finds the host still running it, and it runs once",
    () =>
      Effect.gen(function* () {
        const { asking, fake, restart } = yield* killedPlane();
        const setup = fake.holdNext("exec");

        yield* asking.create(
          "dev",
          request("dev", {
            setup: { script: "#!/bin/sh\necho set up\n", timeoutSeconds: 30 },
          })
        );
        yield* setup.entered;

        const second = yield* restart;

        yield* setup.release;
        yield* second.rests("dev");

        expect(fake.calls.filter((call) => call === "create dev")).toHaveLength(
          1
        );
      })
  );

  it.effect(
    "a control plane that restarts leaves its running machines alone",
    () =>
      Effect.gen(function* () {
        const { client, fake, restart } = yield* killedPlane();

        yield* client.create("dev", request("dev"));
        yield* client.create("other", request("other"));
        yield* client.stopMachine({ id: "other" });
        fake.calls.length = 0;

        const second = yield* restart;

        yield* second.rests("dev");
        yield* second.rests("other");
        yield* pause;

        expect(fake.calls).toStrictEqual([]);
        expect(
          (yield* second.client.machines).map(({ id, state }) => [id, state])
        ).toStrictEqual([
          ["dev", "running"],
          ["other", "stopped"],
        ]);
      })
  );

  it.effect(
    "a step recorded but never sent when the control plane died is sent by the next",
    () =>
      Effect.gen(function* () {
        const { client, first, fake, planned, restart } = yield* killedPlane();
        const [host] = planned.hosts;

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const asked = Option.getOrThrow(
          yield* first.store.desire("dev", "stopped")
        );

        yield* unsent(
          first.store,
          host!.id,
          host!.operations.boot,
          "dev",
          "stop",
          asked.generation
        );

        const second = yield* restart;

        yield* second.rests("dev");

        expect(fake.calls).toStrictEqual(["stop dev"]);
        expect(fake.machines.get("dev")?.state).toBe("stopped");
      })
  );

  it.effect(
    "a scripted make never sent is undone, as its setup left with the process that held it",
    () =>
      Effect.gen(function* () {
        const { client, first, fake, planned, restart } = yield* killedPlane();
        const [host] = planned.hosts;

        yield* client.create("template", request("template"));
        fake.calls.length = 0;

        const template = Option.getOrThrow(
          yield* first.store.findMachine("template")
        );

        yield* first.store.insertMachine({
          ...template,
          name: "dev",
          instance: "unsent",
          port: undefined,
          stage: "making",
          phase: "creating",
          prepared: false,
          scripted: true,
        });
        yield* unsent(
          first.store,
          host!.id,
          host!.operations.boot,
          "dev",
          "make",
          template.generation
        );

        const second = yield* restart;

        const failed = yield* eventually(
          second.client.getMachine({ id: "dev" }),
          ({ phase }) => phase === "failed"
        );

        expect([failed.state, failed.error?._tag]).toStrictEqual([
          "missing",
          "Internal",
        ]);
        expect(fake.calls).toStrictEqual(["delete dev"]);
      })
  );

  it.effect(
    "a machine whose make is unscripted is made though it was never sent",
    () =>
      Effect.gen(function* () {
        const { client, first, fake, planned, restart } = yield* killedPlane();
        const [host] = planned.hosts;

        yield* client.create("template", request("template"));
        fake.calls.length = 0;

        const template = Option.getOrThrow(
          yield* first.store.findMachine("template")
        );

        yield* first.store.insertMachine({
          ...template,
          name: "dev",
          instance: "unsent",
          port: undefined,
          stage: "making",
          phase: "creating",
          prepared: false,
        });
        yield* unsent(
          first.store,
          host!.id,
          host!.operations.boot,
          "dev",
          "make",
          template.generation
        );

        const second = yield* restart;

        yield* second.rests("dev");

        expect(fake.calls).toContain("create dev");
      })
  );

  it.effect(
    "a make its host lost to a restart is undone, and its row says why",
    () =>
      Effect.gen(function* () {
        const served = yield* running();
        const asking = yield* clientOf(served.url, { noWait: true });
        const client = yield* clientOf(served.url);
        const [host] = served.hosts;
        const creating = host!.fake.holdNext("create");

        yield* asking.create("dev", request("dev"));
        yield* creating.entered;
        yield* restartedHost(host!);

        const failed = yield* eventually(
          client.getMachine({ id: "dev" }),
          ({ phase }) => phase === "failed"
        );

        expect([failed.state, failed.error?._tag]).toStrictEqual([
          "missing",
          "Internal",
        ]);
        expect(host!.fake.calls.at(-1)).toBe("delete dev");
      })
  );

  it.effect("a stop its host lost to a restart runs again", () =>
    Effect.gen(function* () {
      const served = yield* running({ recheck: Duration.millis(100) });
      const asking = yield* clientOf(served.url, { noWait: true });
      const client = yield* clientOf(served.url);
      const [host] = served.hosts;

      yield* client.create("dev", request("dev"));

      const stopping = host!.fake.holdNext("stop");

      yield* asking.stopMachine({ id: "dev" });
      yield* stopping.entered;
      yield* restartedHost(host!);

      const stopped = yield* eventually(
        client.getMachine({ id: "dev" }),
        ({ state, phase }) => state === "stopped" && phase === "settled"
      );

      expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
      expect(
        host!.fake.calls.filter((call) => call === "stop dev")
      ).toHaveLength(2);
    })
  );

  it.effect("a host that restarts is told the machines it holds, once", () =>
    Effect.gen(function* () {
      const served = yield* running({ recheck: Duration.millis(50) });
      const client = yield* clientOf(served.url);
      const [host] = served.hosts;

      yield* client.create("dev", request("dev"));
      host!.fake.calls.length = 0;
      yield* restartedHost(host!);
      yield* eventually(
        Effect.sync(() => [...host!.fake.calls]),
        (calls) => calls.includes("adopt dev")
      );
      yield* Effect.sleep(Duration.millis(200));

      expect(
        host!.fake.calls.filter((call) => call.startsWith("adopt"))
      ).toStrictEqual(["adopt dev"]);
    })
  );

  it.effect(
    "a control plane that starts while a host is down comes up, and its machines wait for it",
    () =>
      Effect.gen(function* () {
        const { client, planned, restart } = yield* killedPlane({
          recheck: Duration.millis(100),
        });

        const [host] = planned.hosts;

        yield* client.create("dev", request("dev"));
        yield* host!.dispose;

        const second = yield* restart;

        const waiting = yield* eventually(
          second.client.getMachine({ id: "dev" }),
          ({ phase }) => phase === "waiting"
        );

        yield* restartedHost(host!);

        const back = yield* eventually(
          second.client.getMachine({ id: "dev" }),
          ({ phase, state }) => phase === "settled" && state === "running"
        );

        expect(waiting.state).toBe("unknown");
        expect(at(back)).toStrictEqual(["running", "running", "settled"]);
      })
  );

  it.effect(
    "a prebuild's builder left by a killed control plane is deleted",
    () =>
      Effect.gen(function* () {
        const { asking, fake, restart } = yield* killedPlane();
        const setup = fake.holdNext("exec");

        yield* asking.prebuild({
          ...request("unused"),
          setup: { script: "#!/bin/sh\n", timeoutSeconds: 30 },
        });
        yield* setup.entered;

        const second = yield* restart;

        yield* eventually(second.store.machines, (rows) => rows.length === 0);

        expect(fake.machines.size).toBe(0);
      })
  );
});
