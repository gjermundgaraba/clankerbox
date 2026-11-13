import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { accepts } from "@gjermundgaraba/clankerbox-host/testing";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Logger, Option, Schedule } from "effect";
import { expect } from "vite-plus/test";

import { applied } from "../src/chart.ts";
import { checkpointChart } from "../src/checkpoint-chart.ts";
import { freshBoot } from "./chart-rows.ts";
import {
  applying,
  at,
  clientOf,
  createWithLogin,
  eventually,
  patched,
  pause,
  phaseOf,
  plane,
  request,
  restartedHost,
  running,
  stageOf,
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
            Option.exists(found, (row) => phaseOf(row) === "settled")
          ),
        gone: (name: string) =>
          eventually(second.store.findMachine(name), Option.isNone),
      };
    });

    return { planned, first, client, asking, fake, restart };
  });

const counted = (calls: readonly string[], call: string) =>
  calls.filter((seen) => seen === call).length;

const heard = (lines: string[]) =>
  Logger.make(({ message }) => {
    lines.push(String(message));
  });

const adoptsOf = (lines: readonly string[], name: string) =>
  lines.filter((line) => line.startsWith(`adopt ${name}: `)).length;

const unsent = (
  store: Started["store"],
  boot: string,
  name: string,
  seen: "running" | "unknown"
) =>
  applying(store, name, {
    type: "read",
    seen,
    boot: freshBoot(boot),
    pin: undefined,
    id: `unsent-${name}`,
    joins: false,
    awaiting: false,
  });

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
        expect(yield* client.listMachines()).toStrictEqual([]);
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
          (found) => Option.exists(found, (rest) => phaseOf(rest) === "settled")
        );

        expect(stageOf(Option.getOrThrow(row))).toBe("made");
      })
  );

  it.effect(
    "a control plane killed after a make's running report holds the make's handle in its row at restart, and finishes on that machine",
    () =>
      Effect.gen(function* () {
        const { client, asking, fake, restart, first } = yield* killedPlane();

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* eventually(
          client.getCheckpoint({ id: "snap" }),
          ({ phase }) => phase === "ready"
        );

        const preparing = fake.holdNext("exec");

        yield* asking.restoreMachine({ checkpoint: "snap", name: "copy" });
        yield* preparing.entered;

        const told = yield* first.store.findMachine("copy").pipe(
          Effect.repeat({
            until: Option.exists(({ handle }) => handle !== undefined),
            schedule: Schedule.spaced(Duration.millis(100)).pipe(
              Schedule.upTo({ duration: Duration.seconds(10) })
            ),
          })
        );

        const second = yield* restart;
        const held = yield* second.store.findMachine("copy");

        yield* preparing.release;

        const rested = yield* second.rests("copy");

        expect(Option.map(held, ({ handle }) => handle)).toStrictEqual(
          Option.some(fake.machines.get("copy")?.handle)
        );
        expect(Option.map(rested, ({ handle }) => handle)).toStrictEqual(
          Option.map(told, ({ handle }) => handle)
        );
        expect(counted(fake.calls, "restore copy")).toBe(1);
      }),
    { timeout: 20_000 }
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

        expect(fake.calls).toStrictEqual(["exec dev", "delete dev"]);
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

        expect([stageOf(found), found.prepared]).toStrictEqual(["made", true]);
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
          (yield* second.client.listMachines()).map(({ id, state }) => [
            id,
            state,
          ])
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

        yield* applying(first.store, "dev", {
          type: "ask",
          desired: "stopped",
        });
        yield* unsent(first.store, host!.operations.boot, "dev", "running");

        const second = yield* restart;

        yield* second.rests("dev");

        expect(fake.calls).toStrictEqual(["exec dev", "stop dev"]);
        expect(fake.machines.get("dev")?.state).toBe("stopped");
      })
  );

  it.effect(
    "a resize recorded but never sent when the control plane died is sent from its operation, and one owed follows",
    () =>
      Effect.gen(function* () {
        const { client, first, fake, planned, restart } = yield* killedPlane();
        const [host] = planned.hosts;

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.calls.length = 0;

        yield* applying(first.store, "dev", {
          type: "resize",
          sizing: { cpu: 2, diskGib: 20 },
        });
        yield* unsent(first.store, host!.operations.boot, "dev", "running");
        yield* applying(first.store, "dev", {
          type: "resize",
          sizing: { cpu: 3 },
        });

        const second = yield* restart;
        const rest = Option.getOrThrow(yield* second.rests("dev"));

        expect([rest.cpu, rest.diskGib, rest.resize]).toStrictEqual([
          3,
          20,
          undefined,
        ]);
        expect(fake.calls.filter((call) => call === "resize dev")).toHaveLength(
          2
        );
      })
  );

  it.effect(
    "a resize its host lost to a restart goes with its operation, and leaves the one owed",
    () =>
      Effect.gen(function* () {
        const served = yield* running();
        const asking = yield* clientOf(served.url, { noWait: true });
        const client = yield* clientOf(served.url);
        const [host] = served.hosts;

        yield* client.create("dev", request("dev"));

        const resizing = host!.fake.holdNext("resize");

        yield* asking.resizeMachine({ id: "dev", ramMib: 2048 });
        yield* resizing.entered;
        yield* asking.resizeMachine({ id: "dev", cpu: 2 });
        yield* restartedHost(host!);

        const rest = yield* eventually(
          client.getMachine({ id: "dev" }),
          ({ cpu, phase }) => cpu === 2 && phase === "settled"
        );

        expect([rest.cpu, rest.ramMib]).toStrictEqual([2, 1024]);
      })
  );

  it.effect(
    "a builder's make never sent is never sent, as its setup left with the process that held it, and its row goes",
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
          name: "building",
          instance: "unsent",
          handle: undefined,
          endpoint: undefined,
          state: "making.due",
          prepared: false,
          ephemeral: true,
        });
        yield* unsent(
          first.store,
          host!.operations.boot,
          "building",
          "unknown"
        );

        const second = yield* restart;

        yield* second.gone("building");

        expect(fake.calls).not.toContain("create building");
      })
  );

  it.effect(
    "a create from a base never sent is made after a restart, as it holds no setup to lose",
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
          handle: undefined,
          endpoint: undefined,
          state: "making.due",
          prepared: false,
        });
        yield* unsent(first.store, host!.operations.boot, "dev", "unknown");

        const second = yield* restart;

        yield* second.rests("dev");

        expect(fake.calls).toContain("create dev");
      })
  );

  it.effect(
    "a restore recorded but never sent copies its checkpoint, though a delete of the checkpoint came between",
    () =>
      Effect.gen(function* () {
        const { client, first, fake, planned, restart } = yield* killedPlane();
        const [host] = planned.hosts;

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        fake.calls.length = 0;

        const template = Option.getOrThrow(
          yield* first.store.findMachine("dev")
        );

        yield* first.store.insertMachine({
          ...template,
          name: "copy",
          instance: "unsent",
          handle: undefined,
          endpoint: undefined,
          state: "making.due",
          prepared: false,
          hostKey: undefined,
          source: { kind: "checkpoint", name: "snap" },
        });
        yield* unsent(first.store, host!.operations.boot, "copy", "unknown");
        yield* first.store.advance("checkpoint", "snap", (row, op) =>
          applied(checkpointChart, row, { type: "delete" }, op)
        );

        const second = yield* restart;

        const copy = yield* eventually(
          second.client.getMachine({ id: "copy" }),
          ({ phase }) => ["settled", "failed"].includes(phase)
        );

        yield* eventually(second.store.findCheckpoint("snap"), Option.isNone);

        expect([...at(copy), copy.error]).toStrictEqual([
          "running",
          "running",
          "settled",
          undefined,
        ]);
        expect(
          fake.calls.filter((call) =>
            ["restore copy", "deleteCheckpoint snap"].includes(call)
          )
        ).toStrictEqual(["restore copy", "deleteCheckpoint snap"]);
      })
  );

  it.effect(
    "a restore whose checkpoint a delete took first fails as NotFound, naming the checkpoint",
    () =>
      Effect.gen(function* () {
        const { client, first, fake, planned, restart } = yield* killedPlane();
        const [host] = planned.hosts;

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        fake.calls.length = 0;

        const template = Option.getOrThrow(
          yield* first.store.findMachine("dev")
        );

        yield* first.store.insertMachine({
          ...template,
          name: "copy",
          instance: "unsent",
          handle: undefined,
          endpoint: undefined,
          state: "making.due",
          prepared: false,
          hostKey: undefined,
          source: { kind: "checkpoint", name: "snap" },
        });

        for (const event of [
          { type: "delete" },
          {
            type: "read",
            boot: freshBoot(host!.operations.boot),
            id: "unsent-snap",
            awaiting: false,
          },
        ] as const) {
          yield* first.store.advance("checkpoint", "snap", (row, op) =>
            applied(checkpointChart, row, event, op)
          );
        }

        const second = yield* restart;

        const copy = yield* eventually(
          second.client.getMachine({ id: "copy" }),
          ({ phase }) => ["settled", "failed"].includes(phase)
        );

        expect([
          copy.phase,
          copy.error?._tag,
          copy.error?.message,
        ]).toStrictEqual(["failed", "NotFound", "no checkpoint snap"]);
        expect(fake.calls).not.toContain("restore copy");
      })
  );

  it.effect(
    "a make its host lost to a restart is undone, its host finding no VM to delete, and its row says why",
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
        expect([
          host!.fake.calls.includes("delete dev"),
          host!.fake.machines.has("dev"),
        ]).toStrictEqual([false, false]);
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

  it.effect(
    "a row an upgrade left with its port and no handle or address is filled from its host's next adopt, and reads the ssh it had",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ recheck: Duration.millis(50) });
        const client = yield* clientOf(served.url);
        const [host] = served.hosts;

        const made = yield* createWithLogin(client, "dev");

        const before = Option.getOrThrow(
          yield* served.store.findMachine("dev")
        );

        yield* patched(served.store, "dev", {
          handle: undefined,
          endpoint: { port: made.ssh?.port ?? 0 },
        });

        const upgraded = yield* client.getMachine({ id: "dev" });

        yield* restartedHost(host!);

        const filled = yield* eventually(
          served.store.findMachine("dev"),
          Option.exists(
            ({ handle, endpoint }) =>
              handle !== undefined && endpoint?.host !== undefined
          )
        );

        expect(upgraded.ssh).toBeUndefined();
        expect(
          Option.map(filled, ({ handle, endpoint }) => ({ handle, endpoint }))
        ).toStrictEqual(
          Option.some({ handle: before.handle, endpoint: before.endpoint })
        );
        expect((yield* client.getMachine({ id: "dev" })).ssh).toStrictEqual(
          made.ssh
        );
      })
  );

  it.effect(
    "a relayed host that restarts is told the machines it holds, once, and reaches each again where its row says",
    () =>
      Effect.gen(function* () {
        const served = yield* running({
          recheck: Duration.millis(50),
          runtime: { runtime: { relayed: true } },
        });

        const client = yield* clientOf(served.url);
        const [host] = served.hosts;

        const made = yield* createWithLogin(client, "dev");

        host!.fake.calls.length = 0;
        yield* restartedHost(host!);
        yield* eventually(
          Effect.sync(() => [...host!.fake.calls]),
          (calls) => calls.includes("relay dev")
        );
        yield* Effect.sleep(Duration.millis(200));

        const read = yield* client.getMachine({ id: "dev" });

        expect(
          host!.fake.calls.filter((call) => call.startsWith("relay"))
        ).toStrictEqual(["relay dev"]);
        expect(read.ssh).toStrictEqual(made.ssh);
        expect(yield* accepts(made.ssh?.port ?? 0)).toBe(true);
      })
  );

  it.effect(
    "a published host that restarts is told the machines it holds once",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ recheck: Duration.millis(50) });
        const client = yield* clientOf(served.url);
        const [host] = served.hosts;
        const lines: string[] = [];

        yield* client.create("dev", request("dev"));
        yield* restartedHost(host!, { logger: heard(lines) });
        yield* eventually(
          Effect.sync(() => adoptsOf(lines, "dev")),
          (adopts) => adopts > 0
        );
        yield* Effect.sleep(Duration.millis(300));

        expect(adoptsOf(lines, "dev")).toBe(1);
      })
  );

  it.effect(
    "a host that restarts while its runtime can't find one machine has every other row filled at once, and is adopted again until it finds that one, then no more",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ recheck: Duration.millis(50) });
        const client = yield* clientOf(served.url);
        const [host] = served.hosts;
        const lines: string[] = [];

        const handleOf = (name: string) =>
          Effect.map(served.store.findMachine(name), (found) =>
            Option.getOrUndefined(Option.map(found, ({ handle }) => handle))
          );

        yield* client.create("ok", request("ok"));
        yield* client.create("broken", request("broken"));

        const before = [yield* handleOf("ok"), yield* handleOf("broken")];

        for (const name of ["ok", "broken"]) {
          yield* patched(served.store, name, { handle: undefined });
        }

        host!.fake.failFind(
          "broken",
          new Internal({ message: "database is locked" })
        );
        yield* restartedHost(host!, { logger: heard(lines) });

        const ok = yield* eventually(
          handleOf("ok"),
          (handle) => handle !== undefined
        );

        yield* eventually(
          Effect.sync(() => adoptsOf(lines, "broken")),
          (adopts) => adopts > 2
        );

        const unfound = yield* handleOf("broken");

        host!.fake.mendFind("broken");

        const broken = yield* eventually(
          handleOf("broken"),
          (handle) => handle !== undefined
        );

        const adopted = adoptsOf(lines, "broken");

        yield* Effect.sleep(Duration.millis(300));

        expect([ok, unfound, broken]).toStrictEqual([
          before[0],
          undefined,
          before[1],
        ]);
        expect(adoptsOf(lines, "broken")).toBe(adopted);
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
});
