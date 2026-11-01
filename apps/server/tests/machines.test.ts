import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Capacity, Internal, Unsizable } from "@gjermundgaraba/clankerbox-sdk";
import type { Machine } from "@gjermundgaraba/clankerbox-sdk";
import {
  exists,
  read,
  remove,
  stat,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { Duration, Effect, Fiber, Option, Result } from "effect";
import { expect } from "vite-plus/test";

import {
  applying,
  at,
  clientOf,
  eventually,
  loginSetup,
  patched,
  pause,
  request,
  restartedHost,
  running,
  stageOf,
} from "./support.ts";

const theirs =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITheirKeyForTests clankerbox-theirs";

const installsStart = {
  script: [
    "#!/bin/sh",
    'mkdir -p "$CLANKERBOX_ROOT/etc/clankerbox" "$CLANKERBOX_ROOT/etc/ssh"',
    'printf "#!/bin/sh\\necho start >>\\"\\$CLANKERBOX_ROOT/starts\\"\\n" >"$CLANKERBOX_ROOT/etc/clankerbox/start"',
    'chmod 755 "$CLANKERBOX_ROOT/etc/clankerbox/start"',
    ': >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key"',
    'echo "ssh-ed25519 AAAAimage root@image" >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key.pub"',
    "echo set up",
  ].join("\n"),
  timeoutSeconds: 30,
};

const exits3 = { script: "#!/bin/sh\nexit 3\n", timeoutSeconds: 30 };

const quickSetup = { script: "#!/bin/sh\n", timeoutSeconds: 30 };

const portsOfHere = { first: 21_900, last: 21_909 };

const sizesOf = (machine: {
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}) => [machine.cpu, machine.ramMib, machine.diskGib];

const refusal = (machine: Pick<Machine, "phase" | "error">) => [
  machine.phase,
  machine.error?._tag,
];

const served = (options?: Parameters<typeof running>[0]) =>
  Effect.gen(function* () {
    const plane = yield* running(options);
    const client = yield* clientOf(plane.url);
    const asking = yield* clientOf(plane.url, { noWait: true });
    const [host] = plane.hosts;

    if (host === undefined) {
      return yield* Effect.die("a plane with no host");
    }

    host.fake.calls.length = 0;
    host.fake.observed.length = 0;

    const machine = (id: string) => client.getMachine({ id });

    const row = (name: string) =>
      Effect.map(plane.store.findMachine(name), Option.getOrThrow);

    return {
      ...plane,
      client,
      asking,
      host,
      fake: host.fake,
      machine,
      row,
      rows: plane.store.machines,
      bootedUnder: (name: string, pin: string | undefined) =>
        patched(plane.store, name, { pin }),
      beforeNextAsk: (name: string) =>
        patched(plane.store, name, { prepared: true }),
      afterNextAsk: (name: string) =>
        eventually(row(name), ({ prepared }) => !prepared),
      pins: Effect.map(plane.store.machines, (all) =>
        all.map(({ pin }) => pin)
      ),
      rests: (id: string) =>
        eventually(machine(id), ({ phase }) => phase === "settled"),
    };
  });

const unready = (
  fake: Effect.Success<ReturnType<typeof served>>["fake"],
  name: string
) => {
  fake.machines.set(name, { state: "unknown", root: fake.root(name) ?? "" });
};

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "create runs setup once, then preparation, and answers once the machine runs as asked",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        const made = yield* client.create(
          "dev",
          request("dev", { setup: installsStart })
        );

        const root = fake.root("dev") ?? "";

        expect(made).toMatchObject({
          id: "dev",
          kind: "linux",
          base: "ubuntu",
          state: "running",
          desired: "running",
          phase: "settled",
          ssh: { host: "127.0.0.1" },
        });
        expect(made.error).toBeUndefined();
        expect(made.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(
          yield* read(path.join(root, "var/lib/clankerbox/machine-id"))
        ).toBe("dev\n");
        expect(yield* read(path.join(root, "starts"))).toBe("start\n");
        expect(fake.calls).toStrictEqual([
          "admit dev",
          "create dev",
          "exec dev",
          "start dev",
          "exec dev",
        ]);
      })
  );

  it.effect("a mac host's machine is mac", () =>
    Effect.gen(function* () {
      const { client } = yield* served({
        hosts: [{ id: "mac", kind: "mac" }],
      });

      const made = yield* client.create("dev", request("dev"));

      expect(made).toMatchObject({ id: "dev", kind: "mac" });
    })
  );

  it.effect(
    "a start of a machine that already runs prepares it again, admitting nothing",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev", { setup: installsStart }));
        fake.calls.length = 0;

        const started = yield* client.startMachine({ id: "dev" });

        expect(at(started)).toStrictEqual(["running", "running", "settled"]);
        expect(fake.calls).toStrictEqual(["start dev", "exec dev"]);
        expect(yield* read(path.join(fake.root("dev") ?? "", "starts"))).toBe(
          "start\nstart\n"
        );
      })
  );

  it.effect(
    "stop, start and delete run the runtime's calls in turn, start preparing again",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const stopped = yield* client.stopMachine({ id: "dev" });
        const started = yield* client.startMachine({ id: "dev" });

        yield* client.deleteMachine({ id: "dev" });

        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(at(started)).toStrictEqual(["running", "running", "settled"]);
        expect(fake.calls).toStrictEqual([
          "stop dev",
          "admit dev",
          "start dev",
          "exec dev",
          "delete dev",
        ]);
        expect(yield* rows).toStrictEqual([]);
        expect(fake.machines.size).toBe(0);
      })
  );

  it.effect("a stop of a machine that is already stopped calls nothing", () =>
    Effect.gen(function* () {
      const { client, fake } = yield* served();

      yield* client.create("dev", request("dev"));
      yield* client.stopMachine({ id: "dev" });
      fake.calls.length = 0;

      const again = yield* client.stopMachine({ id: "dev" });

      expect(at(again)).toStrictEqual(["stopped", "stopped", "settled"]);
      expect(fake.calls).toStrictEqual([]);
    })
  );

  it.effect("a machine's state is read from the runtime every time", () =>
    Effect.gen(function* () {
      const { client, fake, machine } = yield* served();

      yield* client.create("dev", request("dev"));
      fake.machines.clear();

      const got = yield* machine("dev");
      const listed = yield* client.machines;

      expect(got.state).toBe("missing");
      expect(listed.map(({ id, state }) => [id, state])).toStrictEqual([
        ["dev", "missing"],
      ]);
    })
  );

  it.effect("a list reads a host's machines in one read", () =>
    Effect.gen(function* () {
      const { client, fake } = yield* served();

      yield* client.create("a", request("a"));
      yield* client.create("b", request("b"));
      fake.observed.length = 0;

      const listed = yield* client.machines;

      expect(listed.map(({ id, state }) => [id, state])).toStrictEqual([
        ["a", "running"],
        ["b", "running"],
      ]);
      expect(fake.observed).toStrictEqual([["a", "b"]]);
    })
  );

  it.effect(
    "a read of every machine that fails reads them all unknown, and a list goes on to answer",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("a", request("a"));
        yield* client.create("b", request("b"));
        fake.failNextObserve(new Internal({ message: "tart list exited 1" }));

        const listed = yield* client.machines;

        expect(listed.map(({ id, state }) => [id, state])).toStrictEqual([
          ["a", "unknown"],
          ["b", "unknown"],
        ]);
        expect(listed.map(({ ssh }) => ssh)).toStrictEqual([
          undefined,
          undefined,
        ]);
        expect((yield* machine("b")).state).toBe("running");
      })
  );

  it.effect(
    "a stop sent while the runtime can't read the machine is saved, answers Unavailable, and the next recheck stops it",
    () =>
      Effect.gen(function* () {
        const { client, fake, rests } = yield* served({
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));
        unready(fake, "dev");
        fake.calls.length = 0;

        const unread = yield* Effect.flip(client.stopMachine({ id: "dev" }));
        const whileUnread = [...fake.calls];

        fake.machines.set("dev", {
          state: "running",
          root: fake.root("dev") ?? "",
        });

        const stopped = yield* rests("dev");

        expect(unread).toMatchObject({ _tag: "Unavailable", readOnly: false });
        expect(unread.message).toContain("saved");
        expect(whileUnread).toStrictEqual([]);
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.calls).toStrictEqual(["stop dev"]);
      })
  );

  it.effect(
    "a create whose machine can't be read after its make reads waiting, unprepared, and a recheck prepares it",
    () =>
      Effect.gen(function* () {
        const { asking, fake, machine, rests } = yield* served({
          recheck: Duration.millis(200),
        });

        const setup = fake.holdNext("exec");

        yield* asking.create("dev", request("dev", { setup: installsStart }));
        yield* setup.entered;
        unready(fake, "dev");
        yield* setup.release;

        yield* eventually(
          machine("dev"),
          ({ phase, state }) => phase === "waiting" && state === "unknown"
        );
        yield* Effect.sleep(Duration.millis(300));

        const unread = yield* machine("dev");

        fake.machines.set("dev", {
          state: "running",
          root: fake.root("dev") ?? "",
        });

        const settled = yield* rests("dev");

        expect(at(unread)).toStrictEqual(["unknown", "running", "waiting"]);
        expect(unread.hostKey).toBeUndefined();
        expect([at(settled), settled.hostKey === undefined]).toStrictEqual([
          ["running", "running", "settled"],
          false,
        ]);
      })
  );

  it.effect(
    "a read of runtime state that dies reads unknown, and the machine lives on",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.dieNextObserve();

        const died = yield* machine("dev");
        const stopped = yield* client.stopMachine({ id: "dev" });

        expect([died.state, at(stopped)]).toStrictEqual([
          "unknown",
          ["stopped", "stopped", "settled"],
        ]);
      })
  );

  it.effect(
    "a step that dies fails with Internal, whose message leaves the cause to the host log",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.dieNext("admit", "admit blew up");

        const error = yield* Effect.flip(client.startMachine({ id: "dev" }));
        const got = yield* machine("dev");

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain("the host log has why");
        expect(error.message).not.toContain("admit blew up");
        expect(refusal(got)).toStrictEqual(["failed", "Internal"]);
      })
  );

  it.effect(
    "one machine the runtime can't read is unknown, and the list still reads the rest",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("a", request("a"));
        yield* client.create("b", request("b"));
        unready(fake, "a");

        const listed = yield* client.machines;

        expect(listed.map(({ id, state }) => [id, state])).toStrictEqual([
          ["a", "unknown"],
          ["b", "running"],
        ]);
      })
  );

  it.effect(
    "a machine has an SSH endpoint, as the runtime's user on its port of the publish address, only while it runs",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, row } = yield* served();

        const made = yield* client.create("dev", request("dev"));
        const stopped = yield* client.stopMachine({ id: "dev" });

        fake.machines.clear();

        const missing = yield* machine("dev");
        const { port } = yield* row("dev");

        expect(port).toBeDefined();
        expect(made.ssh).toStrictEqual({
          user: "admin",
          host: "127.0.0.1",
          port,
        });
        expect(made.hostKey).toBeUndefined();
        expect(
          [stopped, missing].map(({ state, ssh }) => [state, ssh])
        ).toStrictEqual([
          ["stopped", undefined],
          ["missing", undefined],
        ]);
      })
  );

  it.effect(
    "a duplicate name is Conflict, and the runtime is never called",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const error = yield* Effect.flip(client.create("dev", request("dev")));

        expect([error._tag, error.message]).toStrictEqual([
          "Conflict",
          "machine dev exists",
        ]);
        expect(fake.calls).toStrictEqual([]);
      })
  );

  it.effect(
    "a base no host offers is NotOffered, before anything is written",
    () =>
      Effect.gen(function* () {
        const { client, rows } = yield* served();

        const error = yield* Effect.flip(
          client.create("dev", request("dev", { base: "fedora" }))
        );

        expect(error._tag).toBe("NotOffered");
        expect(error).toMatchObject({ base: "fedora" });
        expect(error.message).toContain("offers ubuntu");
        expect(yield* rows).toStrictEqual([]);
      })
  );

  it.effect(
    "a linux host creates from an image reference no base names, and records it as the machine's base",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();
        const reference = "registry.example/team/orb:latest";

        const named = yield* client.create("named", request("named"));

        const made = yield* client.create(
          "dev",
          request("dev", { base: reference })
        );

        expect(named.base).toBe("ubuntu");
        expect(fake.images.get("named")).not.toBe("ubuntu");
        expect(made.base).toBe(reference);
        expect(fake.images.get("dev")).toBe(reference);
      })
  );

  it.effect(
    "a mac host's create from an image reference is NotOffered, before anything is written",
    () =>
      Effect.gen(function* () {
        const { client, rows } = yield* served({
          hosts: [{ id: "mac", kind: "mac" }],
        });

        const error = yield* Effect.flip(
          client.create(
            "dev",
            request("dev", { base: "registry.example/team/orb:latest" })
          )
        );

        expect(error._tag).toBe("NotOffered");
        expect(yield* rows).toStrictEqual([]);
      })
  );

  it.effect(
    "a create refused at admission creates nothing, and its row says why",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        fake.failNext("admit", new Capacity({ message: "no room" }));

        const error = yield* Effect.flip(client.create("dev", request("dev")));

        expect([error._tag, error.message]).toStrictEqual([
          "Capacity",
          "no room",
        ]);
        expect(refusal(yield* machine("dev"))).toStrictEqual([
          "failed",
          "Capacity",
        ]);
        expect(fake.machines.size).toBe(0);
        expect(fake.calls).toStrictEqual(["admit dev", "delete dev"]);
      })
  );

  it.effect(
    "a start refused at admission rests failed with the refusal, and the next start tries again",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.failNext("admit", new Capacity({ message: "no room" }));

        const error = yield* Effect.flip(client.startMachine({ id: "dev" }));
        const got = yield* machine("dev");
        const retried = yield* client.startMachine({ id: "dev" });

        expect(error._tag).toBe("Capacity");
        expect([...at(got), got.error?._tag]).toStrictEqual([
          "stopped",
          "running",
          "failed",
          "Capacity",
        ]);
        expect([...at(retried), retried.error]).toStrictEqual([
          "running",
          "running",
          "settled",
          undefined,
        ]);
      })
  );

  it.effect(
    "a create whose native work failed deletes what it left, and its row answers the failure",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        fake.failNext("create", new Internal({ message: "krun EINVAL" }));

        const error = yield* Effect.flip(client.create("dev", request("dev")));
        const got = yield* machine("dev");

        expect([error._tag, error.message]).toStrictEqual([
          "Internal",
          "krun EINVAL",
        ]);
        expect([got.state, got.phase, got.error?.message]).toStrictEqual([
          "missing",
          "failed",
          "krun EINVAL",
        ]);
        expect(fake.calls).toStrictEqual([
          "admit dev",
          "create dev",
          "delete dev",
        ]);
      })
  );

  it.effect(
    "a failed create's row answers NotFound to all but get, delete and create",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("source", request("source"));
        fake.failNext("create", new Internal({ message: "krun EINVAL" }));
        yield* Effect.flip(client.create("dev", request("dev")));

        const refused = yield* Effect.all([
          Effect.flip(client.startMachine({ id: "dev" })),
          Effect.flip(client.stopMachine({ id: "dev" })),
          Effect.flip(client.pauseMachine({ id: "dev" })),
          Effect.flip(client.resizeMachine({ id: "dev", cpu: 2 })),
          Effect.flip(client.forkMachine({ machine: "dev", name: "copy" })),
        ]);

        expect(refused.map(({ _tag }) => _tag)).toStrictEqual(
          Array.from({ length: 5 }, () => "NotFound")
        );
        expect((yield* client.machines).map(({ id }) => id)).toStrictEqual([
          "source",
          "dev",
        ]);
      })
  );

  it.effect(
    "a delete removes a failed create's row at once, calling nothing",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served();

        fake.failNext("create", new Internal({ message: "krun EINVAL" }));
        yield* Effect.flip(client.create("dev", request("dev")));
        fake.calls.length = 0;

        yield* client.deleteMachine({ id: "dev" });

        expect(yield* rows).toStrictEqual([]);
        expect(fake.calls).toStrictEqual([]);
      })
  );

  it.effect(
    "a step its host refuses, having seen a later one on the machine, is given up and decided afresh, not retried as unreachable",
    () =>
      Effect.gen(function* () {
        const { client, host, machine } = yield* served();

        yield* host.operations.run({
          id: "from-another-store",
          boot: host.operations.boot,
          scope: "machine dev",
          sequence: 4,
          step: { _tag: "remove", machine: { name: "dev", instance: "old" } },
        });

        const answer = yield* Effect.timeoutOption(
          Effect.flip(client.create("dev", request("dev"))),
          Duration.seconds(4)
        );

        expect(Option.map(answer, ({ _tag }) => _tag)).toStrictEqual(
          Option.some("Internal")
        );
        expect(at(yield* machine("dev"))).toStrictEqual([
          "missing",
          "running",
          "failed",
        ]);
      })
  );

  it.effect("a create of a failed create's name replaces its row", () =>
    Effect.gen(function* () {
      const { client, fake } = yield* served();

      fake.failNext("create", new Internal({ message: "krun EINVAL" }));
      yield* Effect.flip(client.create("dev", request("dev")));

      const again = yield* client.create("dev", request("dev", { cpu: 2 }));

      expect([...at(again), again.cpu, again.error]).toStrictEqual([
        "running",
        "running",
        "settled",
        2,
        undefined,
      ]);
    })
  );

  it.effect(
    "a create of a failed create's name answers Conflict while its VM's delete fails, and replaces the row once the VM is gone",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served({
          recheck: Duration.millis(200),
        });

        fake.failNext("create", new Internal({ message: "krun EINVAL" }));
        fake.failNext("delete", new Internal({ message: "EBUSY" }));
        yield* Effect.flip(client.create("dev", request("dev")));

        const held = yield* Effect.flip(client.create("dev", request("dev")));

        yield* eventually(rows, ([found]) => found?.state === "undone");

        const again = yield* client.create("dev", request("dev", { cpu: 2 }));

        expect(held._tag).toBe("Conflict");
        expect([...at(again), again.cpu]).toStrictEqual([
          "running",
          "running",
          "settled",
          2,
        ]);
      })
  );

  it.effect("a failed create's row expires", () =>
    Effect.gen(function* () {
      const { client, fake, rows } = yield* served({
        recheck: Duration.millis(100),
        failedRowsLast: Duration.millis(50),
      });

      fake.failNext("create", new Internal({ message: "krun EINVAL" }));
      yield* Effect.flip(client.create("dev", request("dev")));

      expect(yield* eventually(rows, (all) => all.length === 0)).toStrictEqual(
        []
      );
    })
  );

  it.effect(
    "only a failed create's row expires: a failed step keeps its machine",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served({
          recheck: Duration.millis(50),
          failedRowsLast: Duration.millis(1),
        });

        yield* client.create("dev", request("dev"));
        fake.failNext("stop", new Internal({ message: "guest didn't flush" }));
        yield* Effect.flip(client.stopMachine({ id: "dev" }));
        yield* Effect.sleep(Duration.millis(200));

        expect(yield* rows).toHaveLength(1);
      })
  );

  it.effect(
    "a create a caller left before it failed is deleted all the same",
    () =>
      Effect.gen(function* () {
        const { asking, fake, row } = yield* served();
        const { release, entered } = fake.holdNext("admit");

        fake.failNext("create", new Internal({ message: "krun EINVAL" }));
        yield* asking.create("dev", request("dev"));
        yield* entered;
        yield* release;

        yield* eventually(row("dev"), ({ state }) => state === "undone");

        expect(fake.calls).toContain("delete dev");
      })
  );

  it.effect(
    "a restore holds its checkpoint against a delete until it has copied",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        const { release, entered } = fake.holdNext("admit");

        yield* asking.restoreMachine({ checkpoint: "snap", name: "copy" });
        yield* entered;
        yield* asking.deleteCheckpoint({ id: "snap" });
        yield* pause;

        const whileRestoring = [...fake.calls];

        yield* release;

        const copy = yield* eventually(machine("copy"), ({ phase }) =>
          ["settled", "failed"].includes(phase)
        );

        expect(whileRestoring).not.toContain("deleteCheckpoint snap");
        expect(at(copy)).toStrictEqual(["running", "running", "settled"]);
        yield* eventually(
          Effect.sync(() => [...fake.calls]),
          (calls) => calls.includes("deleteCheckpoint snap")
        );
      })
  );

  it.effect(
    "a stop a capture's lease holds back reads its host once, and runs once the capture ends",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, rests } = yield* served();

        yield* client.create("dev", request("dev"));

        const { release, entered } = fake.holdNext("capture");

        yield* asking.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* entered;
        fake.observed.length = 0;
        yield* asking.stopMachine({ id: "dev" });
        yield* Effect.sleep(Duration.millis(500));

        const whileCapturing = [...fake.observed];

        yield* release;

        const stopped = yield* rests("dev");

        expect(whileCapturing).toStrictEqual([["dev"]]);
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
      })
  );

  it.effect(
    "a stop and a delete of a made machine are never refused for an earlier failure",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.failNext("start", new Internal({ message: "crun create failed" }));
        yield* Effect.flip(client.startMachine({ id: "dev" }));

        const stopped = yield* client.stopMachine({ id: "dev" });

        fake.failNext("stop", new Internal({ message: "guest didn't flush" }));

        for (const held of fake.machines.values()) {
          held.state = "running";
        }

        const stopFailed = yield* Effect.flip(
          client.stopMachine({ id: "dev" })
        );

        yield* client.deleteMachine({ id: "dev" });

        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(stopFailed.message).toBe("guest didn't flush");
        expect(yield* rows).toStrictEqual([]);
      })
  );

  it.effect(
    "a delete of a machine that doesn't exist answers it was absent",
    () =>
      Effect.gen(function* () {
        const { client } = yield* served();

        expect(yield* client.deleteMachine({ id: "gone" })).toBe("absent");
        expect(
          (yield* Effect.flip(client.getMachine({ id: "gone" })))._tag
        ).toBe("NotFound");
      })
  );

  it.effect(
    "a made machine the runtime no longer has is lost: a start is Missing and stays lost, and a delete removes it",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.machines.clear();
        fake.calls.length = 0;

        const error = yield* Effect.flip(client.startMachine({ id: "dev" }));
        const got = yield* machine("dev");

        yield* client.deleteMachine({ id: "dev" });

        expect([error._tag, error.message]).toStrictEqual([
          "Missing",
          "machine dev is missing from the linux runtime; delete it",
        ]);
        expect(at(got)).toStrictEqual(["missing", "running", "lost"]);
        expect(fake.calls).toStrictEqual(["delete dev"]);
      })
  );

  it.effect(
    "a stop sent while a start boots cuts the start short: the start is Superseded",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });

        const { entered, release } = fake.holdNext("start");

        const starting = yield* Effect.forkChild(
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        yield* entered;

        const stopped = yield* client.stopMachine({ id: "dev" });
        const start = yield* Fiber.join(starting);

        yield* release;

        expect(start).toMatchObject({ _tag: "Superseded", by: "stopped" });
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
      })
  );

  it.effect(
    "a stop sent while a running machine is prepared cuts its start short",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const preparing = fake.holdNext("exec");

        const starting = yield* Effect.forkChild(
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        yield* preparing.entered;

        const stopped = yield* client.stopMachine({ id: "dev" });

        expect((yield* Fiber.join(starting))._tag).toBe("Superseded");
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.calls).toStrictEqual(["start dev", "exec dev", "stop dev"]);
      })
  );

  it.effect("a start sent while a machine stops cuts the stop short", () =>
    Effect.gen(function* () {
      const { asking, client, fake } = yield* served();

      yield* client.create("dev", request("dev"));
      fake.calls.length = 0;

      const stopping = fake.holdNext("stop");

      yield* asking.stopMachine({ id: "dev" });
      yield* stopping.entered;

      const started = yield* client.startMachine({ id: "dev" });

      expect(at(started)).toStrictEqual(["running", "running", "settled"]);
      expect(fake.calls).toStrictEqual(["stop dev", "start dev", "exec dev"]);
    })
  );

  it.effect("a start sent while a machine pauses cuts the pause short", () =>
    Effect.gen(function* () {
      const { asking, client, fake } = yield* served();

      yield* client.create("dev", request("dev"));
      fake.calls.length = 0;

      const pausing = fake.holdNext("pause");

      yield* asking.pauseMachine({ id: "dev" });
      yield* pausing.entered;

      const started = yield* client.startMachine({ id: "dev" });

      expect(at(started)).toStrictEqual(["running", "running", "settled"]);
      expect(fake.calls).toStrictEqual(["pause dev", "start dev", "exec dev"]);
    })
  );

  it.effect(
    "a machine keeps the pin it booted under through a pause and its resume",
    () =>
      Effect.gen(function* () {
        const { client, fake, pins } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const booted = yield* pins;
        const paused = yield* client.pauseMachine({ id: "dev" });
        const started = yield* client.startMachine({ id: "dev" });

        expect(booted).toStrictEqual(["fake 1"]);
        expect(at(paused)).toStrictEqual(["paused", "paused", "settled"]);
        expect(at(started)).toStrictEqual(["running", "running", "settled"]);
        expect(yield* pins).toStrictEqual(["fake 1"]);
        expect(fake.calls).toStrictEqual([
          "pause dev",
          "admit dev",
          "start dev",
          "exec dev",
        ]);
      })
  );

  it.effect(
    "a pause stops a machine booted under another pin, or none, and the next boot records the host's",
    () =>
      Effect.gen(function* () {
        const { bootedUnder, client, fake, pins } = yield* served();

        yield* client.create("dev", request("dev"));

        const answers: unknown[] = [];

        for (const pin of ["fake 0", undefined]) {
          yield* bootedUnder("dev", pin);
          fake.calls.length = 0;

          const paused = yield* client.pauseMachine({ id: "dev" });

          answers.push([at(paused), [...fake.calls]]);
          yield* client.startMachine({ id: "dev" });
        }

        expect(answers).toStrictEqual(
          Array.from({ length: 2 }, () => [
            ["stopped", "paused", "settled"],
            ["stop dev"],
          ])
        );
        expect(yield* pins).toStrictEqual(["fake 1"]);
      })
  );

  it.effect(
    "a start of a machine that runs prepares it again, keeping the pin it booted under",
    () =>
      Effect.gen(function* () {
        const { bootedUnder, client, pins } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* bootedUnder("dev", "fake 0");

        const started = yield* client.startMachine({ id: "dev" });

        expect(at(started)).toStrictEqual(["running", "running", "settled"]);
        expect(yield* pins).toStrictEqual(["fake 0"]);
      })
  );

  it.effect(
    "a pause of a stopped machine leaves it stopped, and calls no runtime",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.calls.length = 0;

        const paused = yield* client.pauseMachine({ id: "dev" });

        expect(at(paused)).toStrictEqual(["stopped", "paused", "settled"]);
        expect(fake.calls).toStrictEqual([]);
      })
  );

  it.effect(
    "a machine paused under another runtime build is PinMismatch to a start or a stop, and never resumed",
    () =>
      Effect.gen(function* () {
        const { bootedUnder, client, fake, pins } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.pauseMachine({ id: "dev" });
        yield* bootedUnder("dev", "fake 0");
        fake.calls.length = 0;

        const errors = [
          yield* Effect.flip(client.startMachine({ id: "dev" })),
          yield* Effect.flip(client.stopMachine({ id: "dev" })),
        ];

        expect(errors.map(({ _tag }) => _tag)).toStrictEqual([
          "PinMismatch",
          "PinMismatch",
        ]);
        expect(fake.calls).toStrictEqual([]);
        expect(yield* pins).toStrictEqual(["fake 0"]);
      })
  );

  it.effect(
    "a stop of a paused machine boots it through admission, as a stop",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.pauseMachine({ id: "dev" });
        fake.calls.length = 0;

        const stopped = yield* client.stopMachine({ id: "dev" });

        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.activations.at(-1)?.action).toBe("stopMachine");
        expect(fake.calls).toStrictEqual(["admit dev", "stop dev"]);
      })
  );

  it.effect(
    "on a runtime whose stop discards a pause, a stop of a paused machine admits nothing",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          hosts: [{ id: "mac", kind: "mac" }],
        });

        yield* client.create("dev", request("dev"));
        yield* client.pauseMachine({ id: "dev" });
        fake.calls.length = 0;

        const stopped = yield* client.stopMachine({ id: "dev" });

        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.calls).toStrictEqual(["stop dev"]);
      })
  );

  it.effect(
    "a second request for what a step already works toward lets the step finish, and both answer",
    () =>
      Effect.gen(function* () {
        const { afterNextAsk, beforeNextAsk, client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.calls.length = 0;

        const booting = fake.holdNext("admit");

        const first = yield* Effect.forkChild(
          client.startMachine({ id: "dev" })
        );

        yield* booting.entered;
        yield* beforeNextAsk("dev");

        const second = yield* Effect.forkChild(
          client.startMachine({ id: "dev" })
        );

        yield* afterNextAsk("dev");
        yield* booting.release;

        const answers = [yield* Fiber.join(first), yield* Fiber.join(second)];

        expect(answers.map(at)).toStrictEqual([
          ["running", "running", "settled"],
          ["running", "running", "settled"],
        ]);
        expect(fake.calls).toStrictEqual([
          "admit dev",
          "start dev",
          "exec dev",
        ]);
      })
  );

  it.effect(
    "a request repeated while a step runs that then fails answers the failure, with no more tries",
    () =>
      Effect.gen(function* () {
        const { afterNextAsk, beforeNextAsk, client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.calls.length = 0;

        const booting = fake.holdNext("admit");

        fake.failNext("start", new Internal({ message: "crun create failed" }));

        const first = yield* Effect.forkChild(
          Effect.result(client.startMachine({ id: "dev" }))
        );

        yield* booting.entered;
        yield* beforeNextAsk("dev");

        const second = yield* Effect.forkChild(
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        yield* afterNextAsk("dev");
        yield* booting.release;

        const failure = yield* Fiber.join(second);

        yield* Fiber.await(first);

        expect(failure.message).toBe("crun create failed");
        expect(fake.calls).toStrictEqual(["admit dev", "start dev"]);
      })
  );

  it.effect(
    "a wish that goes stopped, running, stopped during a stop that fails reads as asked, and answers the failure",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, machines, store } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.pauseMachine({ id: "dev" });
        fake.calls.length = 0;

        const resuming = fake.holdNext("admit");

        fake.failNext("stop", new Internal({ message: "guest didn't flush" }));

        const stop = yield* Effect.forkChild(
          Effect.flip(client.stopMachine({ id: "dev" }))
        );

        yield* resuming.entered;
        yield* applying(store, "dev", { type: "ask", desired: "running" });
        yield* machines.stop("dev");
        yield* pause;
        yield* resuming.release;

        const failure = yield* Fiber.join(stop);
        const rest = yield* machine("dev");

        expect(failure.message).toBe("guest didn't flush");
        expect(at(rest)).toStrictEqual(["paused", "stopped", "failed"]);
        expect(rest.error?.message).toBe("guest didn't flush");
        expect(fake.calls.filter((call) => call === "stop dev")).toHaveLength(
          1
        );
      })
  );

  it.effect(
    "a client that goes stopped, running, stopped during a stop is told the truth at each end",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));

        const stopping = fake.holdNext("stop", { runsOn: true });

        const stop = yield* Effect.forkChild(client.stopMachine({ id: "dev" }));

        yield* stopping.entered;

        const start = yield* Effect.forkChild(
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        yield* eventually(
          machine("dev"),
          ({ desired }) => desired === "running"
        );
        yield* asking.stopMachine({ id: "dev" });
        yield* stopping.release;

        const rest = yield* Fiber.join(stop);

        expect((yield* Fiber.join(start))._tag).toBe("Superseded");
        expect(at(rest)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.machines.get("dev")?.state).toBe("stopped");
      })
  );

  it.effect(
    "a step that fails on a made machine rests failed until a request tries again",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served({
          recheck: Duration.millis(50),
        });

        yield* client.create("dev", request("dev"));
        fake.failNext("stop", new Internal({ message: "stop refused" }));
        yield* Effect.flip(client.stopMachine({ id: "dev" }));
        fake.calls.length = 0;
        yield* Effect.sleep(Duration.millis(200));

        const rested = yield* machine("dev");
        const whileRested = [...fake.calls];
        const retried = yield* client.stopMachine({ id: "dev" });

        expect(refusal(rested)).toStrictEqual(["failed", "Internal"]);
        expect(whileRested).toStrictEqual([]);
        expect(refusal(retried)).toStrictEqual(["settled", undefined]);
      })
  );

  it.effect("a settled machine runs nothing by itself between rechecks", () =>
    Effect.gen(function* () {
      const { client, fake, machine } = yield* served();

      yield* client.create("dev", request("dev"));
      fake.calls.length = 0;
      fake.observed.length = 0;

      for (const held of fake.machines.values()) {
        held.state = "stopped";
      }

      yield* Effect.sleep(Duration.millis(200));

      expect(fake.observed).toStrictEqual([]);
      expect(fake.calls).toStrictEqual([]);
      expect(at(yield* machine("dev"))).toStrictEqual([
        "stopped",
        "running",
        "settled",
      ]);
    })
  );

  it.effect(
    "a delete sent while a create runs cuts it short, and the create is Superseded",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, rows } = yield* served();
        const { entered } = fake.holdNext("create");

        const creating = yield* Effect.forkChild(
          Effect.flip(client.create("dev", request("dev")))
        );

        yield* entered;

        const held = yield* machine("dev");

        yield* client.deleteMachine({ id: "dev" });

        expect([held.desired, held.phase]).toStrictEqual([
          "running",
          "creating",
        ]);
        expect(yield* Fiber.join(creating)).toMatchObject({
          _tag: "Superseded",
          by: "deleted",
        });
        expect(fake.calls).toStrictEqual([
          "admit dev",
          "create dev",
          "delete dev",
        ]);
        expect(yield* rows).toStrictEqual([]);
      })
  );

  it.effect(
    "a delete sent while a create's setup runs cuts the setup short and deletes it",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served();
        const { entered } = fake.holdNext("exec");

        const creating = yield* Effect.forkChild(
          Effect.flip(
            client.create("dev", request("dev", { setup: installsStart }))
          )
        );

        yield* entered;
        yield* client.deleteMachine({ id: "dev" });

        expect((yield* Fiber.join(creating))._tag).toBe("Superseded");
        expect(fake.calls.slice(-2)).toStrictEqual(["exec dev", "delete dev"]);
        expect(yield* rows).toStrictEqual([]);
      })
  );

  it.effect(
    "a stop sent while a start boots reads the machine only once the start's native work ends",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });

        const { entered, release } = fake.holdNext("start", { runsOn: true });

        const starting = yield* Effect.forkChild(
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        yield* entered;

        const stopping = yield* Effect.forkChild(
          client.stopMachine({ id: "dev" })
        );

        yield* eventually(
          machine("dev"),
          ({ desired }) => desired === "stopped"
        );
        yield* release;

        const stopped = yield* Fiber.join(stopping);

        expect((yield* Fiber.join(starting))._tag).toBe("Superseded");
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.machines.get("dev")?.state).toBe("stopped");
        expect(fake.calls.slice(-2)).toStrictEqual(["start dev", "stop dev"]);
      })
  );

  it.effect(
    "a start sent to a machine being deleted is Superseded at once, booting nothing",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const { entered, release } = fake.holdNext("delete");

        yield* asking.deleteMachine({ id: "dev" });
        yield* entered;

        const refused = yield* Effect.flip(client.startMachine({ id: "dev" }));
        const still = yield* machine("dev");

        yield* release;
        yield* client.deleteMachine({ id: "dev" });

        expect(refused).toMatchObject({ _tag: "Superseded", by: "deleted" });
        expect(still.desired).toBe("deleted");
        expect(fake.calls).toStrictEqual(["delete dev"]);
      })
  );

  it.effect(
    "a delete sent again after one failed shows no error while it retries",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, machine, rows } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.failNext("delete", new Internal({ message: "EBUSY" }));

        const failed = yield* Effect.flip(client.deleteMachine({ id: "dev" }));
        const retrying = fake.holdNext("delete");

        yield* asking.deleteMachine({ id: "dev" });
        yield* retrying.entered;

        const during = yield* machine("dev");

        yield* retrying.release;
        yield* eventually(rows, (left) => left.length === 0);

        expect(failed.message).toBe("EBUSY");
        expect([during.phase, during.error]).toStrictEqual([
          "deleting",
          undefined,
        ]);
        expect(fake.machines.size).toBe(0);
      })
  );

  it.effect(
    "a client that stops waiting doesn't stop the work, which carries on to rest",
    () =>
      Effect.gen(function* () {
        const { client, fake, rests } = yield* served();
        const { release, entered } = fake.holdNext("create");

        const caller = yield* Effect.forkChild(
          client.create("dev", request("dev"))
        );

        yield* entered;
        yield* Fiber.interrupt(caller);
        yield* release;

        const settled = yield* rests("dev");

        expect(at(settled)).toStrictEqual(["running", "running", "settled"]);
        expect(fake.calls).toContain("exec dev");
      })
  );

  it.effect(
    "a setup's authorized keys go to the login user once it exits 0, in the same exec, beside the keys already there",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();
        const keys = path.join("home", "admin", ".ssh", "authorized_keys");

        yield* client.create(
          "dev",
          request("dev", {
            setup: {
              script: [
                installsStart.script,
                loginSetup,
                'mkdir -p "$CLANKERBOX_ROOT/home/admin/.ssh"',
                `printf "${theirs}" >"$CLANKERBOX_ROOT/${keys}"`,
              ].join("\n"),
              authorizedKeys: `${operatorKey}\n`,
            },
          })
        );
        yield* client.create(
          "fresh",
          request("fresh", {
            setup: {
              script: `#!/bin/sh\n${loginSetup}`,
              authorizedKeys: operatorKey,
            },
          })
        );

        const fresh = path.join(fake.root("fresh") ?? "", keys);

        expect(yield* read(path.join(fake.root("dev") ?? "", keys))).toBe(
          `${theirs}\n${operatorKey}\n\n`
        );
        expect(fake.calls.filter((call) => call === "exec dev")).toHaveLength(
          2
        );
        expect(yield* read(fresh)).toBe(`\n${operatorKey}\n`);
        expect((yield* stat(fresh)).mode & 0o777).toBe(0o600);
      })
  );

  it.effect(
    "a setup with authorized keys that leaves no login user fails, and deletes the machine",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        const error = yield* Effect.flip(
          client.create(
            "dev",
            request("dev", {
              setup: {
                script: "#!/bin/sh\ntrue\n",
                authorizedKeys: operatorKey,
              },
            })
          )
        );

        expect(error._tag).toBe("ScriptFailed");
        expect(error).toMatchObject({ script: "setup" });
        expect(error.message).toContain("sudo: unknown user admin");
        expect(error.message).toContain(
          "couldn't install the authorized keys for admin: setup must leave that user, and sudo"
        );
        expect(fake.machines.size).toBe(0);
      })
  );

  it.effect(
    "a setup with no authorized keys installs none, so it needs no login user",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev", { setup: installsStart }));

        expect(yield* exists(path.join(fake.root("dev") ?? "", "home"))).toBe(
          false
        );
      })
  );

  it.effect("a setup that fails deletes the machine, VM and all", () =>
    Effect.gen(function* () {
      const { client, fake, machine, row } = yield* served();

      const error = yield* Effect.flip(
        client.create("dev", request("dev", { setup: exits3 }))
      );

      const got = yield* machine("dev");

      expect([error._tag, got.error?._tag]).toStrictEqual([
        "ScriptFailed",
        "ScriptFailed",
      ]);
      expect([got.state, got.phase]).toStrictEqual(["missing", "failed"]);
      expect(stageOf(yield* row("dev"))).toBe("undone");
      expect(fake.calls.slice(-2)).toStrictEqual(["exec dev", "delete dev"]);
      expect(fake.machines.size).toBe(0);
    })
  );

  it.effect(
    "a setup that fails answers its failure though the delete after it fails, and the next recheck deletes the machine",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, row } = yield* served({
          recheck: Duration.millis(200),
        });

        fake.failNext("delete", new Internal({ message: "krun busy" }));

        const error = yield* Effect.flip(
          client.create("dev", request("dev", { setup: exits3 }))
        );

        const left = yield* machine("dev");

        expect(error._tag).toBe("ScriptFailed");
        expect(refusal(left)).toStrictEqual(["failed", "ScriptFailed"]);
        expect(fake.machines.size).toBe(1);

        yield* eventually(row("dev"), ({ state }) => state === "undone");

        expect(fake.machines.size).toBe(0);
        expect(refusal(yield* machine("dev"))).toStrictEqual([
          "failed",
          "ScriptFailed",
        ]);
      })
  );

  it.effect(
    "a request sent while a failed create is undone is NotFound, and leaves the create its failure",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();
        const undoing = fake.holdNext("delete");

        const creating = yield* Effect.forkChild(
          Effect.flip(client.create("dev", request("dev", { setup: exits3 })))
        );

        yield* undoing.entered;

        const refused = yield* Effect.flip(client.stopMachine({ id: "dev" }));

        yield* undoing.release;

        expect(refused._tag).toBe("NotFound");
        expect((yield* Fiber.join(creating))._tag).toBe("ScriptFailed");
        expect(refusal(yield* machine("dev"))).toStrictEqual([
          "failed",
          "ScriptFailed",
        ]);
      })
  );

  it.effect(
    "a setup that fails deletes the machine though a stop was asked meanwhile, and the stop answers the failure",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();
        const setup = fake.holdNext("exec");

        const creating = yield* Effect.forkChild(
          Effect.flip(client.create("dev", request("dev", { setup: exits3 })))
        );

        yield* setup.entered;

        const stopping = yield* Effect.forkChild(
          Effect.flip(client.stopMachine({ id: "dev" }))
        );

        yield* eventually(
          machine("dev"),
          ({ desired }) => desired === "stopped"
        );
        yield* setup.release;

        expect((yield* Fiber.join(creating))._tag).toBe("Superseded");
        expect((yield* Fiber.join(stopping))._tag).toBe("ScriptFailed");
        expect(fake.machines.size).toBe(0);
      })
  );

  it.effect(
    "a fork of a machine whose setup still runs is NotMade, and a stop waits for the setup, then stops it",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, row } = yield* served();
        const { release, entered } = fake.holdNext("exec");

        const creating = yield* Effect.forkChild(
          Effect.flip(
            client.create("dev", request("dev", { setup: quickSetup }))
          )
        );

        yield* entered;

        const refused = yield* Effect.flip(
          client.forkMachine({ machine: "dev", name: "copy" })
        );

        const stopping = yield* Effect.forkChild(
          client.stopMachine({ id: "dev" })
        );

        const taken = yield* eventually(
          machine("dev"),
          ({ desired, phase }) => desired === "stopped" && phase === "creating"
        );

        yield* release;

        const [superseded, stopped] = yield* Effect.all([
          Fiber.join(creating),
          Fiber.join(stopping),
        ]);

        expect([refused._tag, refused.message]).toStrictEqual([
          "NotMade",
          "machine dev isn't made yet: its create or setup still runs",
        ]);
        expect(taken.phase).toBe("creating");
        expect(superseded).toMatchObject({ _tag: "Superseded", by: "stopped" });
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(stageOf(yield* row("dev"))).toBe("made");
      })
  );

  it.effect(
    "a create, fork or restore that succeeds makes its machine, setup and all",
    () =>
      Effect.gen(function* () {
        const { client, rows } = yield* served();

        yield* client.create("dev", request("dev", { setup: installsStart }));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* client.forkMachine({ machine: "dev", name: "forked" });
        yield* client.restoreMachine({ checkpoint: "snap", name: "restored" });

        expect(
          (yield* rows).map((found) => [found.name, stageOf(found)])
        ).toStrictEqual([
          ["dev", "made"],
          ["forked", "made"],
          ["restored", "made"],
        ]);
      })
  );

  it.effect(
    "a create that fails only in preparation leaves its machine made, and a start prepares it again",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, row } = yield* served();

        fake.failNext("exec", new Internal({ message: "sshd didn't start" }));

        const error = yield* Effect.flip(client.create("dev", request("dev")));
        const failed = yield* machine("dev");
        const stage = stageOf(yield* row("dev"));

        fake.calls.length = 0;

        const started = yield* client.startMachine({ id: "dev" });

        expect([error._tag, error.message]).toStrictEqual([
          "Internal",
          "sshd didn't start",
        ]);
        expect(stage).toBe("made");
        expect(refusal(failed)).toStrictEqual(["failed", "Internal"]);
        expect(at(started)).toStrictEqual(["running", "running", "settled"]);
        expect(fake.calls).toStrictEqual(["start dev", "exec dev"]);
      })
  );

  const marker = "setup-text-marker";

  it.effect(
    "a failing setup fails the create with its last lines of output, never its text",
    () =>
      Effect.gen(function* () {
        const { client, machine } = yield* served();

        const script = [
          "#!/bin/sh",
          `# ${marker}`,
          "i=0",
          "while [ $i -lt 30 ]; do echo line $i; i=$((i+1)); done",
          "echo broke >&2",
          "exit 3",
        ].join("\n");

        const error = yield* Effect.flip(
          client.create(
            "dev",
            request("dev", { setup: { script, timeoutSeconds: 30 } })
          )
        );

        const got = yield* machine("dev");

        expect(error._tag).toBe("ScriptFailed");
        expect(error).toMatchObject({ script: "setup" });
        expect(error.message).toContain("setup exited 3");
        expect(error.message).toContain("line 29\nbroke");
        expect(error.message).not.toContain("line 10\n");
        expect(error.message).not.toContain(marker);
        expect(got.error?.message).toBe(error.message);
      })
  );

  it.effect("a setup that exits removes its file", () =>
    Effect.gen(function* () {
      const { client } = yield* served();
      const script = `#!/bin/sh\necho "running as $0"\nexit 3\n`;

      const error = yield* Effect.flip(
        client.create(
          "dev",
          request("dev", { setup: { script, timeoutSeconds: 30 } })
        )
      );

      const file =
        /running as (?<file>\S+)/u.exec(error.message)?.groups?.["file"] ?? "";

      expect(file).toMatch(/^\/var\/tmp\/clankerbox-setup\./u);
      expect(yield* exists(file)).toBe(false);
    })
  );

  it.effect("create accepts a setup that names no timeout", () =>
    Effect.gen(function* () {
      const { client } = yield* served();

      const made = yield* client.create(
        "dev",
        request("dev", { setup: { script: installsStart.script } })
      );

      expect(made.phase).toBe("settled");
    })
  );

  it.effect(
    "a setup that runs past its timeout fails the create with the output so far",
    () =>
      Effect.gen(function* () {
        const { client } = yield* served();
        const script = `#!/bin/sh\n# ${marker}\necho "running as $0"\nsleep 30\n`;

        const error = yield* Effect.flip(
          client.create(
            "dev",
            request("dev", { setup: { script, timeoutSeconds: 1 } })
          )
        );

        const file =
          /running as (?<file>\S+)/u.exec(error.message)?.groups?.["file"] ??
          "";

        expect(file).toMatch(/^\/var\/tmp\/clankerbox-setup\./u);

        yield* remove(file);

        expect(error._tag).toBe("ScriptFailed");
        expect(error).toMatchObject({ script: "setup" });
        expect(error.message).toContain("setup ran past its 1s timeout");
        expect(error.message).not.toContain(marker);
      })
  );

  it.effect("the next recheck starts machines that stopped under them", () =>
    Effect.gen(function* () {
      const { client, fake } = yield* served({
        recheck: Duration.millis(200),
      });

      yield* client.create("dev", request("dev"));
      yield* client.create("other", request("other"));
      fake.calls.length = 0;

      for (const held of fake.machines.values()) {
        held.state = "stopped";
      }

      yield* eventually(
        Effect.sync(() => [...fake.calls]),
        (calls) => calls.length >= 6
      );

      expect(fake.calls.toSorted()).toStrictEqual([
        "admit dev",
        "admit other",
        "exec dev",
        "exec other",
        "start dev",
        "start other",
      ]);
    })
  );

  it.effect(
    "a reading of a machine that a request changed while it read is dropped, not acted on",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, rests } = yield* served({
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));

        for (const held of fake.machines.values()) {
          held.state = "stopped";
        }

        const { entered, release } = fake.holdNextObserve();

        yield* entered;
        yield* asking.stopMachine({ id: "dev" });
        fake.calls.length = 0;
        yield* release;

        const stopped = yield* rests("dev");

        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.calls).toStrictEqual([]);
      })
  );

  it.effect(
    "the RAM budget counts running machines and refuses with Capacity, a create leaving no VM behind",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 2048 } },
        });

        yield* client.create("a", request("a"));
        yield* client.create("b", request("b"));

        const full = yield* Effect.flip(client.create("c", request("c")));
        const before = [...fake.machines.keys()];

        yield* client.stopMachine({ id: "a" });
        yield* client.create("c", request("c"));

        const restart = yield* Effect.flip(client.startMachine({ id: "a" }));

        expect(full._tag).toBe("Capacity");
        expect(full.message).toContain(
          "needs 1G of RAM, and none of the host's 2G budget is free"
        );
        expect(before).toStrictEqual(["a", "b"]);
        expect(restart._tag).toBe("Capacity");
        expect([...fake.machines.keys()].toSorted()).toStrictEqual([
          "a",
          "b",
          "c",
        ]);
      })
  );

  it.effect(
    "a create a delete cuts short after admission is no longer counted as booting",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 4096 } },
        });

        const { entered } = fake.holdNext("create");

        const creating = yield* Effect.forkChild(
          Effect.flip(client.create("c", request("c", { ramMib: 2048 })))
        );

        yield* entered;
        yield* client.deleteMachine({ id: "c" });
        yield* Fiber.join(creating);

        expect((yield* client.capacity).usage).toStrictEqual([
          { host: "linux", resource: "cpu", used: 0 },
          { host: "linux", resource: "ramMib", limit: 4096, used: 0 },
        ]);
      })
  );

  it.effect(
    "a delete that fails answers the failure, and runs once more at each recheck, not before, until it succeeds",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served({
          recheck: Duration.millis(400),
        });

        const deletes = () =>
          fake.calls.filter((call) => call.startsWith("delete"));

        yield* client.create("dev", request("dev"));
        fake.failNext("delete", new Internal({ message: "EBUSY" }));
        fake.failNext("delete", new Internal({ message: "EBUSY" }));
        fake.calls.length = 0;

        const refused = yield* Effect.flip(client.deleteMachine({ id: "dev" }));

        yield* Effect.sleep(Duration.millis(200));

        const beforeRecheck = deletes();

        yield* eventually(rows, (left) => left.length === 0);

        expect([refused._tag, refused.message]).toStrictEqual([
          "Internal",
          "EBUSY",
        ]);
        expect(beforeRecheck).toStrictEqual(["delete dev"]);
        expect(deletes()).toStrictEqual([
          "delete dev",
          "delete dev",
          "delete dev",
        ]);
      })
  );

  it.effect(
    "a delete on a host that stays down asks it once a recheck, and acts once it answers",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, host, rows } = yield* served({
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));
        yield* host.dispose;

        const asked = { count: 0 };

        const standIn = yield* Effect.acquireRelease(
          Effect.callback<ReturnType<typeof createHttpServer>>((resume) => {
            const server = createHttpServer((_request, response) => {
              asked.count += 1;
              response.writeHead(503).end();
            });

            server.listen(Number(new URL(host.url).port), "127.0.0.1", () => {
              resume(Effect.succeed(server));
            });
          }),
          (server) =>
            Effect.callback<undefined>((resume) => {
              server.closeAllConnections();
              server.close(() => {
                resume(Effect.undefined);
              });
            })
        );

        yield* asking.deleteMachine({ id: "dev" });
        yield* Effect.sleep(Duration.millis(500));

        const answered = asked.count;

        yield* Effect.callback<undefined>((resume) => {
          standIn.closeAllConnections();
          standIn.close(() => {
            resume(Effect.undefined);
          });
        });

        yield* restartedHost(host);
        yield* eventually(rows, (left) => left.length === 0);

        expect(answered).toBeGreaterThan(0);
        expect(answered).toBeLessThan(20);
        expect(fake.machines.size).toBe(0);
      })
  );

  it.effect(
    "a stop on a host that is down is saved, answers Unavailable at once, and acts when the host is back",
    () =>
      Effect.gen(function* () {
        const { client, fake, host, machine, rests } = yield* served({
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));
        yield* host.dispose;

        const saved = yield* Effect.flip(client.stopMachine({ id: "dev" }));
        const waiting = yield* machine("dev");

        yield* restartedHost(host);

        const stopped = yield* rests("dev");

        expect(saved).toMatchObject({ _tag: "Unavailable", readOnly: false });
        expect([waiting.state, waiting.phase]).toStrictEqual([
          "unknown",
          "waiting",
        ]);
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.calls).toContain("stop dev");
      })
  );

  it.effect(
    "a settled machine reads waiting as soon as its host is down, and settled once it is back, with no recheck between",
    () =>
      Effect.gen(function* () {
        const { client, host, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* host.dispose;

        const down = yield* machine("dev");
        const listed = yield* client.machines;

        yield* restartedHost(host);

        const back = yield* machine("dev");

        expect(at(down)).toStrictEqual(["unknown", "running", "waiting"]);
        expect(listed.map(at)).toStrictEqual([
          ["unknown", "running", "waiting"],
        ]);
        expect(at(back)).toStrictEqual(["running", "running", "settled"]);
      })
  );

  it.effect(
    "a request on a host that is down answers what it recorded, and a read shows waiting",
    () =>
      Effect.gen(function* () {
        const { asking, client, host, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* host.dispose;

        const recorded = yield* asking.stopMachine({ id: "dev" });
        const shown = yield* machine("dev");

        expect(at(recorded)).toStrictEqual(["unknown", "stopped", "observing"]);
        expect(at(shown)).toStrictEqual(["unknown", "stopped", "waiting"]);
      })
  );

  it.effect(
    "a step whose host goes down reads waiting, and is decided afresh when the host is back",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, host, machine, rests } = yield* served({
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));

        const stop = fake.holdNext("stop");

        yield* asking.stopMachine({ id: "dev" });
        yield* stop.entered;
        yield* host.dispose;

        const down = yield* machine("dev");

        yield* restartedHost(host);

        expect(at(down)).toStrictEqual(["unknown", "stopped", "waiting"]);
        expect(at(yield* rests("dev"))).toStrictEqual([
          "stopped",
          "stopped",
          "settled",
        ]);
      })
  );

  it.effect("a failed machine reads failed on a host that is down", () =>
    Effect.gen(function* () {
      const { client, fake, host, machine } = yield* served();

      yield* client.create("dev", request("dev"));
      fake.failNext("stop", new Internal({ message: "no stop" }));

      const refused = yield* Effect.flip(client.stopMachine({ id: "dev" }));

      yield* host.dispose;

      const down = yield* machine("dev");

      expect(refused._tag).toBe("Internal");
      expect(at(down)).toStrictEqual(["unknown", "stopped", "failed"]);
      expect(down.error?._tag).toBe("Internal");
    })
  );

  it.effect(
    "a failed create reads missing and failed on a host that is down",
    () =>
      Effect.gen(function* () {
        const { client, fake, host, machine } = yield* served();

        fake.failNext("create", new Internal({ message: "no disk" }));

        yield* Effect.flip(client.create("dev", request("dev")));
        yield* host.dispose;

        const down = yield* machine("dev");

        expect(at(down)).toStrictEqual(["missing", "running", "failed"]);
        expect(down.error?._tag).toBe("Internal");
      })
  );

  it.effect(
    "the host's capacity counts running machines and one a step is booting, for cpu too",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 4096 } },
        });

        yield* client.create("a", request("a"));
        yield* client.create("b", request("b"));
        yield* client.stopMachine({ id: "a" });

        const idle = yield* client.capacity;
        const { entered, release } = fake.holdNext("create");

        yield* asking.create("c", request("c", { ramMib: 2048 }));
        yield* entered;

        const booting = yield* client.capacity;

        const full = yield* Effect.flip(
          client.create("d", request("d", { ramMib: 2048 }))
        );

        yield* release;

        expect(idle.usage).toStrictEqual([
          { host: "linux", resource: "cpu", used: 1 },
          { host: "linux", resource: "ramMib", limit: 4096, used: 1024 },
        ]);
        expect(booting.usage).toStrictEqual([
          { host: "linux", resource: "cpu", used: 2 },
          { host: "linux", resource: "ramMib", limit: 4096, used: 3072 },
        ]);
        expect(full._tag).toBe("Capacity");
        expect(full.message).toContain(
          "needs 2G of RAM, and 1G of the host's 4G budget is free"
        );
      })
  );

  it.effect("a capacity read that fails names the host unreachable", () =>
    Effect.gen(function* () {
      const { client, fake } = yield* served({
        runtime: { runtime: { ramBudgetMib: 4096 } },
      });

      fake.failNext(
        "capacity",
        new Internal({ message: "tart list exited 1" })
      );

      expect(yield* client.capacity).toStrictEqual({
        usage: [],
        unreachable: ["linux"],
      });
    })
  );

  it.effect(
    "the RAM budget counts a machine the runtime can't read as running",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 2048 } },
        });

        yield* client.create("a", request("a"));
        unready(fake, "a");

        const full = yield* Effect.flip(
          client.create("c", request("c", { ramMib: 2048 }))
        );

        expect(full._tag).toBe("Capacity");
        expect(full.message).toContain(
          "needs 2G of RAM, and 1G of the host's 2G budget is free"
        );
      })
  );

  it.effect(
    "admission counts the machine it boots, beside those the row knows",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 4096 } },
        });

        yield* client.create("a", request("a"));
        yield* client.create("b", request("b"));
        yield* client.stopMachine({ id: "b" });
        yield* client.startMachine({ id: "b" });

        expect(
          fake.activations
            .at(-1)
            ?.machines.map(({ machine, booting }) => [machine.name, booting])
        ).toStrictEqual([
          ["a", false],
          ["b", true],
        ]);
      })
  );

  it.effect(
    "of two concurrent creates that each fit only alone, exactly one passes",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 1536 } },
        });

        const { release, entered } = fake.holdNext("admit");

        const creates = yield* Effect.forEach(["x", "y"], (name) =>
          Effect.forkChild(Effect.result(client.create(name, request(name))))
        );

        yield* entered;
        yield* pause;

        const admitsWhileHeld = fake.calls.filter((call) =>
          call.startsWith("admit")
        ).length;

        yield* release;

        const ended = yield* Effect.forEach(creates, Fiber.join);

        const refused = ended
          .filter(Result.isFailure)
          .map(({ failure }) => failure._tag);

        expect(admitsWhileHeld).toBe(1);
        expect(ended.filter(Result.isSuccess)).toHaveLength(1);
        expect(refused).toStrictEqual(["Capacity"]);
        expect(fake.machines.size).toBe(1);
      })
  );

  it.effect(
    "of two concurrent starts that each fit only alone, exactly one passes",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 1536 } },
        });

        yield* client.create("x", request("x"));
        yield* client.stopMachine({ id: "x" });
        yield* client.create("y", request("y"));
        yield* client.stopMachine({ id: "y" });

        const { release, entered } = fake.holdNext("admit");

        fake.calls.length = 0;

        const starts = yield* Effect.forEach(["x", "y"], (id) =>
          Effect.forkChild(Effect.result(client.startMachine({ id })))
        );

        yield* entered;
        yield* pause;

        const admitsWhileHeld = fake.calls.filter((call) =>
          call.startsWith("admit")
        ).length;

        yield* release;

        const ended = yield* Effect.forEach(starts, Fiber.join);

        const refused = ended
          .filter(Result.isFailure)
          .map(({ failure }) => failure._tag);

        expect(admitsWhileHeld).toBe(1);
        expect(ended.filter(Result.isSuccess)).toHaveLength(1);
        expect(refused).toStrictEqual(["Capacity"]);
      })
  );

  it.effect(
    "ports skip one that something else listens on, and concurrent creates get distinct ones",
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const server = createServer();

            server.listen(
              { host: "127.0.0.1", port: portsOfHere.first, exclusive: true },
              () => {
                resume(Effect.succeed(server));
              }
            );
          }),
          (server) =>
            Effect.callback<undefined>((resume) => {
              server.close(() => {
                resume(Effect.undefined);
              });
            })
        );

        const { client } = yield* served({
          runtime: { ports: portsOfHere },
        });

        const made = yield* Effect.forEach(
          ["a", "b", "c"],
          (name) => client.create(name, request(name)),
          { concurrency: "unbounded" }
        );

        const taken = made
          .map(({ ssh }) => ssh?.port ?? 0)
          .toSorted((a, b) => a - b);

        expect(taken).toStrictEqual([
          portsOfHere.first + 1,
          portsOfHere.first + 2,
          portsOfHere.first + 3,
        ]);
      })
  );

  it.effect(
    "a host whose ports are all taken refuses a create with Capacity, and its row says why",
    () =>
      Effect.gen(function* () {
        const { client, machine } = yield* served({
          runtime: {
            ports: { first: portsOfHere.first, last: portsOfHere.first + 1 },
          },
        });

        yield* client.create("a", request("a"));
        yield* client.create("b", request("b"));

        const full = yield* Effect.flip(client.create("c", request("c")));

        expect(full._tag).toBe("Capacity");
        expect(full.message).toBe(
          `no free port in ${portsOfHere.first}-${portsOfHere.first + 1} on 127.0.0.1`
        );
        expect(refusal(yield* machine("c"))).toStrictEqual([
          "failed",
          "Capacity",
        ]);
      })
  );

  it.effect(
    "a resize gives a stopped machine any vCPUs and RAM and a larger disk, admitting nothing, and records them",
    () =>
      Effect.gen(function* () {
        const { client, fake, row } = yield* served();

        yield* client.create("dev", request("dev", { cpu: 2 }));
        yield* client.stopMachine({ id: "dev" });
        fake.calls.length = 0;

        const resized = yield* client.resizeMachine({
          id: "dev",
          cpu: 1,
          ramMib: 512,
          diskGib: 20,
        });

        expect(sizesOf(resized)).toStrictEqual([1, 512, 20]);
        expect(at(resized)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(sizesOf(yield* row("dev"))).toStrictEqual([1, 512, 20]);
        expect(fake.calls).toStrictEqual(["resize dev", "sizes dev"]);
      })
  );

  it.effect("a size left out of a resize stays as it is", () =>
    Effect.gen(function* () {
      const { client } = yield* served();

      yield* client.create("dev", request("dev", { cpu: 2 }));
      yield* client.stopMachine({ id: "dev" });

      const resized = yield* client.resizeMachine({ id: "dev", diskGib: 30 });

      expect(sizesOf(resized)).toStrictEqual([2, 1024, 30]);
    })
  );

  it.effect(
    "a running linux machine grows live, admitted with its new RAM counted in place of its old",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 3072 } },
        });

        yield* client.create("a", request("a"));
        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const resized = yield* client.resizeMachine({
          id: "dev",
          cpu: 2,
          ramMib: 2048,
        });

        const activation = fake.activations.at(-1);

        expect(sizesOf(resized)).toStrictEqual([2, 2048, 10]);
        expect(at(resized)).toStrictEqual(["running", "running", "settled"]);
        expect(fake.calls).toStrictEqual([
          "admit dev",
          "resize dev",
          "sizes dev",
        ]);
        expect([activation?.action, activation?.machine.ramMib]).toStrictEqual([
          "resizeMachine",
          2048,
        ]);
        expect(
          activation?.machines.map(({ machine, booting }) => [
            machine.name,
            machine.ramMib,
            booting,
          ])
        ).toStrictEqual([
          ["a", 1024, false],
          ["dev", 2048, true],
        ]);
      })
  );

  it.effect(
    "a machine growing live counts at its new RAM for the host's other admissions",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake } = yield* served({
          runtime: { runtime: { ramBudgetMib: 3584 } },
        });

        yield* client.create("dev", request("dev"));
        yield* client.create("other", request("other"));
        yield* client.stopMachine({ id: "other" });

        const { release, entered } = fake.holdNext("resize");

        yield* asking.resizeMachine({ id: "dev", ramMib: 3072 });
        yield* entered;

        const during = yield* client.capacity;
        const full = yield* Effect.flip(client.startMachine({ id: "other" }));

        yield* release;

        expect(
          during.usage.find(({ resource }) => resource === "ramMib")
        ).toMatchObject({ used: 3072 });
        expect(full._tag).toBe("Capacity");
      })
  );

  it.effect(
    "a live grow past the RAM budget is Capacity, and nothing is resized",
    () =>
      Effect.gen(function* () {
        const { client, fake, rows } = yield* served({
          runtime: { runtime: { ramBudgetMib: 2048 } },
        });

        yield* client.create("a", request("a"));
        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;

        const full = yield* Effect.flip(
          client.resizeMachine({ id: "dev", ramMib: 2048 })
        );

        expect(full._tag).toBe("Capacity");
        expect(full.message).toContain("resizeMachine dev needs 2G of RAM");
        expect(fake.calls).toStrictEqual(["admit dev"]);
        expect((yield* rows).map(sizesOf)).toStrictEqual([
          [1, 1024, 10],
          [1, 1024, 10],
        ]);
      })
  );

  it.effect(
    "a smaller disk is Unsizable, rests failed, and leaves the runtime untouched",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.calls.length = 0;

        const smaller = yield* Effect.flip(
          client.resizeMachine({ id: "dev", diskGib: 5 })
        );

        expect([smaller._tag, smaller.message]).toStrictEqual([
          "Unsizable",
          "machine dev's disk is 10G, and a disk only grows",
        ]);
        expect(fake.calls).toStrictEqual([]);
        expect(refusal(yield* machine("dev"))).toStrictEqual([
          "failed",
          "Unsizable",
        ]);
        expect(sizesOf(yield* machine("dev"))).toStrictEqual([1, 1024, 10]);
      })
  );

  it.effect(
    "a paused machine, a running mac machine and a live shrink, which smolvm makes only on x86_64, are refused before admission and the runtime",
    () =>
      Effect.gen(function* () {
        const linux = yield* served();

        const mac = yield* served({
          hosts: [{ id: "mac", kind: "mac" }],
        });

        yield* linux.client.create("dev", request("dev"));
        yield* linux.client.create("paused", request("paused"));
        yield* linux.client.pauseMachine({ id: "paused" });
        yield* mac.client.create("dev", request("dev"));
        linux.fake.calls.length = 0;
        mac.fake.calls.length = 0;

        const refused = [
          yield* Effect.flip(
            linux.client.resizeMachine({ id: "paused", cpu: 2 })
          ),
          yield* Effect.flip(
            mac.client.resizeMachine({ id: "dev", ramMib: 2048 })
          ),
          yield* Effect.flip(
            linux.client.resizeMachine({ id: "dev", cpu: 2, ramMib: 512 })
          ),
        ];

        expect(
          refused.map(({ _tag, message }) => [_tag, message])
        ).toStrictEqual([
          [
            "WrongState",
            "machine paused is paused, and the linux runtime resizes a stopped or running machine: stop it first",
          ],
          [
            "WrongState",
            "machine dev is running, and the mac runtime resizes only a stopped machine: stop it first",
          ],
          [
            "Unsizable",
            "a running machine's vCPUs and RAM only grow, and dev has 1 vCPUs and 1G: stop it to shrink them",
          ],
        ]);
        expect([...linux.fake.calls, ...mac.fake.calls]).toStrictEqual([]);
      })
  );

  it.effect(
    "a live resize that fails part way keeps the sizes the runtime gave",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.giveOnlyRamThenFailNextResize(
          new Internal({ message: "smolvm resize: no CPUs" })
        );

        const failed = yield* Effect.flip(
          client.resizeMachine({ id: "dev", cpu: 2, ramMib: 2048 })
        );

        const shown = yield* machine("dev");

        expect([failed._tag, failed.message]).toStrictEqual([
          "Internal",
          "smolvm resize: no CPUs",
        ]);
        expect(sizesOf(shown)).toStrictEqual([1, 2048, 10]);
        expect(refusal(shown)).toStrictEqual(["failed", "Internal"]);
      })
  );

  it.effect(
    "a resize to the sizes its row holds still reaches the runtime, so a live grow cut short can finish",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.giveOnlyRamThenFailNextResize(
          new Internal({
            message: "RAM registered; guest onlining incomplete",
          })
        );
        yield* Effect.flip(client.resizeMachine({ id: "dev", ramMib: 2048 }));
        fake.calls.length = 0;

        const retried = yield* client.resizeMachine({
          id: "dev",
          ramMib: 2048,
        });

        expect(fake.calls).toStrictEqual(["resize dev", "sizes dev"]);
        expect(sizesOf(retried)).toStrictEqual([1, 2048, 10]);
      })
  );

  it.effect(
    "a resize whose read-back leaves a size out keeps the one it asked",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });

        const reading = fake.holdNext("sizes");

        const resize = yield* Effect.forkChild(
          client.resizeMachine({ id: "dev", cpu: 2, diskGib: 20 })
        );

        yield* reading.entered;
        fake.sizes.set("dev", { cpu: 2, ramMib: 1024 });
        yield* reading.release;

        expect(sizesOf(yield* Fiber.join(resize))).toStrictEqual([2, 1024, 20]);
      })
  );

  it.effect(
    "sizes the runtime can't give are refused before admission and anything native, for a resize and a copy",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        fake.calls.length = 0;
        fake.sized.length = 0;

        const admitted = fake.activations.length;

        const refused = new Unsizable({
          message: "smolvm grows RAM in 128M steps",
        });

        fake.refuseNextSizes(refused);

        const resized = yield* Effect.flip(
          client.resizeMachine({ id: "dev", ramMib: 2100 })
        );

        fake.refuseNextSizes(refused);

        const forked = yield* Effect.flip(
          client.forkMachine({ machine: "dev", name: "copy", ramMib: 2100 })
        );

        const held = { cpu: 1, ramMib: 1024, diskGib: 10 };
        const asked = { ...held, ramMib: 2100 };

        expect([resized.message, forked.message]).toStrictEqual([
          refused.message,
          refused.message,
        ]);
        expect(fake.sized).toStrictEqual([
          ["dev", held, asked, true],
          ["copy", held, asked, true],
        ]);
        expect(fake.calls).toStrictEqual(["delete copy"]);
        expect(fake.activations).toHaveLength(admitted);
        expect(refusal(yield* machine("copy"))).toStrictEqual([
          "failed",
          "Unsizable",
        ]);
      })
  );

  it.effect(
    "a host that restarts during a resize leaves the sizes the runtime gave for the control plane to read",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, host, machine } = yield* served();

        yield* client.create("dev", request("dev"));

        const { entered } = fake.holdNext("resize");

        yield* asking.resizeMachine({ id: "dev", ramMib: 2048 });
        yield* entered;
        fake.sizes.set("dev", { cpu: 1, ramMib: 2048, diskGib: 10 });

        yield* restartedHost(host);

        const shown = yield* eventually(
          machine("dev"),
          ({ phase, ramMib }) => phase === "settled" && ramMib === 2048
        );

        expect(sizesOf(shown)).toStrictEqual([1, 2048, 10]);
      })
  );

  it.effect(
    "a machine whose sizes can't be read after a lost resize keeps those it has",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, host, machine } = yield* served();

        yield* client.create("dev", request("dev"));

        const { entered } = fake.holdNext("resize");

        yield* asking.resizeMachine({ id: "dev", ramMib: 2048 });
        yield* entered;
        fake.failNext("sizes", new Internal({ message: "status failed" }));

        yield* restartedHost(host);

        const shown = yield* eventually(
          machine("dev"),
          ({ phase }) => phase === "settled"
        );

        expect(sizesOf(shown)).toStrictEqual([1, 1024, 10]);
      })
  );

  it.effect(
    "a resize whose sizes can't be read back keeps those it asked when it succeeded, and those it had when it failed",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.failNext("sizes", new Internal({ message: "status failed" }));

        const resized = yield* client.resizeMachine({ id: "dev", cpu: 2 });

        fake.failNext("resize", new Internal({ message: "update failed" }));
        fake.failNext("sizes", new Internal({ message: "status failed" }));

        yield* Effect.flip(client.resizeMachine({ id: "dev", cpu: 3 }));

        const shown = yield* machine("dev");

        expect(sizesOf(resized)).toStrictEqual([2, 1024, 10]);
        expect(sizesOf(shown)).toStrictEqual([2, 1024, 10]);
      })
  );

  it.effect(
    "a resize waits for a step under way, and the next request waits for it",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));

        const stopping = fake.holdNext("stop", { runsOn: true });

        yield* asking.stopMachine({ id: "dev" });
        yield* stopping.entered;
        yield* asking.resizeMachine({ id: "dev", cpu: 2, ramMib: 512 });
        yield* pause;

        const whileStopping = [...fake.calls];
        const resizing = fake.holdNext("resize");

        yield* stopping.release;
        yield* resizing.entered;
        yield* asking.startMachine({ id: "dev" });
        yield* pause;

        const whileResizing = [...fake.calls];

        yield* resizing.release;

        const rest = yield* eventually(
          machine("dev"),
          ({ state, phase }) => state === "running" && phase === "settled"
        );

        expect(whileStopping).not.toContain("resize dev");
        expect(whileResizing.at(-1)).toBe("resize dev");
        expect(sizesOf(rest)).toStrictEqual([2, 512, 10]);
        expect(fake.activations.at(-1)?.machine.ramMib).toBe(512);
      })
  );

  it.effect(
    "a resize sent while another runs follows it, and neither is lost",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        fake.calls.length = 0;

        const { entered, release } = fake.holdNext("resize", { runsOn: true });

        yield* asking.resizeMachine({ id: "dev", cpu: 2 });
        yield* entered;
        yield* asking.resizeMachine({ id: "dev", cpu: 3 });
        yield* pause;
        yield* release;

        const rest = yield* eventually(
          machine("dev"),
          ({ cpu, phase }) => cpu === 3 && phase === "settled"
        );

        expect(sizesOf(rest)).toStrictEqual([3, 1024, 10]);
        expect(fake.calls.filter((call) => call === "resize dev")).toHaveLength(
          2
        );
      })
  );

  it.effect("a resize asked during a failing stop still runs", () =>
    Effect.gen(function* () {
      const { asking, client, fake, machine, row } = yield* served();

      yield* client.create("dev", request("dev"));
      yield* client.pauseMachine({ id: "dev" });

      const resuming = fake.holdNext("admit");

      fake.failNext("stop", new Internal({ message: "guest didn't flush" }));

      yield* asking.stopMachine({ id: "dev" });
      yield* resuming.entered;
      fake.machines.set("dev", {
        state: "running",
        root: fake.root("dev") ?? "",
      });

      const resize = yield* Effect.forkChild(
        client.resizeMachine({ id: "dev", cpu: 2 })
      );

      yield* eventually(row("dev"), ({ resize: owed }) => owed !== undefined);
      yield* pause;
      yield* resuming.release;

      const resized = yield* Fiber.join(resize);
      const rest = yield* machine("dev");

      expect(sizesOf(resized)).toStrictEqual([2, 1024, 10]);
      expect(at(rest)).toStrictEqual(["stopped", "stopped", "settled"]);
      expect(rest.error).toBeUndefined();
    })
  );

  it.effect(
    "a resize whose caller leaves still finishes, and records its sizes",
    () =>
      Effect.gen(function* () {
        const { client, fake, row } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });

        const { release, entered } = fake.holdNext("resize");

        const resize = yield* Effect.forkChild(
          client.resizeMachine({ id: "dev", cpu: 2 })
        );

        yield* entered;
        yield* Fiber.interrupt(resize);
        yield* release;

        const found = yield* eventually(row("dev"), ({ cpu }) => cpu === 2);

        expect(sizesOf(found)).toStrictEqual([2, 1024, 10]);
      })
  );

  it.effect(
    "a linux fork or restore given larger sizes than its source's is admitted at them and has them",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        const forked = yield* client.forkMachine({
          machine: "dev",
          name: "forked",
          cpu: 2,
          ramMib: 2048,
          diskGib: 20,
        });

        const restored = yield* client.restoreMachine({
          checkpoint: "snap",
          name: "restored",
          ramMib: 4096,
        });

        expect(sizesOf(forked)).toStrictEqual([2, 2048, 20]);
        expect(sizesOf(restored)).toStrictEqual([1, 4096, 10]);
        expect(
          fake.activations
            .filter(({ action }) => action !== "startMachine")
            .slice(-2)
            .map(({ action, machine }) => [action, machine.ramMib])
        ).toStrictEqual([
          ["forkMachine", 2048],
          ["restoreMachine", 4096],
        ]);
      })
  );

  it.effect(
    "a linux copy's vCPUs or RAM below its source's, and any copy's smaller disk, are Unsizable before a row is written",
    () =>
      Effect.gen(function* () {
        const linux = yield* served();

        const mac = yield* served({
          hosts: [{ id: "mac", kind: "mac" }],
        });

        yield* linux.client.create("dev", request("dev", { cpu: 2 }));
        yield* linux.client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* mac.client.create("dev", request("dev"));
        yield* mac.client.stopMachine({ id: "dev" });
        linux.fake.calls.length = 0;
        mac.fake.calls.length = 0;

        const refused = [
          yield* Effect.flip(
            linux.client.forkMachine({ machine: "dev", name: "copy", cpu: 1 })
          ),
          yield* Effect.flip(
            linux.client.restoreMachine({
              checkpoint: "snap",
              name: "copy",
              ramMib: 512,
            })
          ),
          yield* Effect.flip(
            mac.client.forkMachine({ machine: "dev", name: "copy", diskGib: 5 })
          ),
        ];

        expect(
          refused.map(({ _tag, message }) => [_tag, message])
        ).toStrictEqual([
          [
            "Unsizable",
            "a linux copy holds its source's RAM, so machine copy's vCPUs and RAM only grow from the source's 2 vCPUs and 1G",
          ],
          [
            "Unsizable",
            "a linux copy holds its source's RAM, so machine copy's vCPUs and RAM only grow from the source's 2 vCPUs and 1G",
          ],
          [
            "Unsizable",
            "machine copy's disk of 5G is below its source's 10G, and a disk only grows",
          ],
        ]);
        expect((yield* linux.rows).map(({ name }) => name)).toStrictEqual([
          "dev",
        ]);
        expect((yield* mac.rows).map(({ name }) => name)).toStrictEqual([
          "dev",
        ]);
        expect([...linux.fake.calls, ...mac.fake.calls]).toStrictEqual([]);
      })
  );

  it.effect(
    "a fork whose source grows past the copy while it waits is refused by the rule its request passed, and its copy is deleted",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));

        const { release, entered } = fake.holdNext("resize");

        yield* asking.resizeMachine({ id: "dev", ramMib: 2048 });
        yield* entered;

        const fork = yield* Effect.forkChild(
          Effect.flip(
            client.forkMachine({ machine: "dev", name: "copy", ramMib: 1536 })
          )
        );

        yield* pause;
        yield* release;

        const refused = yield* Fiber.join(fork);

        expect([refused._tag, refused.message]).toStrictEqual([
          "Unsizable",
          "a linux copy holds its source's RAM, so machine copy's vCPUs and RAM only grow from the source's 1 vCPUs and 2G",
        ]);
        expect(refusal(yield* machine("copy"))).toStrictEqual([
          "failed",
          "Unsizable",
        ]);
        expect(fake.calls).not.toContain("fork copy");
      })
  );

  it.effect(
    "a mac fork whose source shrinks while it waits is made at the sizes it asked",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake } = yield* served({
          hosts: [{ id: "mac", kind: "mac" }],
        });

        yield* client.create("dev", request("dev", { cpu: 4, ramMib: 8192 }));
        yield* client.stopMachine({ id: "dev" });

        const { release, entered } = fake.holdNext("resize");

        yield* asking.resizeMachine({ id: "dev", cpu: 2 });
        yield* entered;

        const fork = yield* Effect.forkChild(
          client.forkMachine({ machine: "dev", name: "copy", cpu: 6 })
        );

        yield* pause;
        yield* release;

        expect(sizesOf(yield* Fiber.join(fork))).toStrictEqual([6, 8192, 10]);
      })
  );

  it.effect("a mac fork takes smaller vCPUs and RAM than its source's", () =>
    Effect.gen(function* () {
      const { client } = yield* served({
        hosts: [{ id: "mac", kind: "mac" }],
      });

      yield* client.create("dev", request("dev", { cpu: 4, ramMib: 8192 }));
      yield* client.stopMachine({ id: "dev" });

      const forked = yield* client.forkMachine({
        machine: "dev",
        name: "copy",
        cpu: 2,
        ramMib: 4096,
      });

      expect(sizesOf(forked)).toStrictEqual([2, 4096, 10]);
    })
  );
});
