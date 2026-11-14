import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import type { MachineState } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { suitePorts } from "@gjermundgaraba/clankerbox-host/testing";
import { Capacity, Internal, Unsizable } from "@gjermundgaraba/clankerbox-sdk";
import type { Machine, Setup } from "@gjermundgaraba/clankerbox-sdk";
import {
  read,
  scratch,
  stat,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { Duration, Effect, Fiber, Option, Result } from "effect";
import { expect } from "vite-plus/test";

import {
  applying,
  at,
  clientOf,
  eventually,
  hostKeySetup,
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

const leftIn = (dir: string) => path.join(dir, "left");

const installsLeaveHooks = (dir: string, then = "") => ({
  script: [
    "#!/bin/sh",
    'mkdir -p "$CLANKERBOX_ROOT/etc/clankerbox"',
    ...["stop", "pause", "delete"].flatMap((hook) => [
      `printf '#!/bin/sh\\necho %s >>"%s"\\n${then}\\n' ${hook} "${leftIn(dir)}" >"$CLANKERBOX_ROOT/etc/clankerbox/${hook}"`,
      `chmod 755 "$CLANKERBOX_ROOT/etc/clankerbox/${hook}"`,
    ]),
  ].join("\n"),
  timeoutSeconds: 30,
});

const hooksRun = (dir: string) =>
  Effect.map(
    Effect.orElseSucceed(read(leftIn(dir)), () => ""),
    (text) => text.split("\n").filter((line) => line !== "")
  );

const portsOfHere = suitePorts.serverMachines;

const sizesOf = (machine: {
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}) => [machine.cpu, machine.ramMib, machine.diskGib];

const idsOf = (listed: readonly Machine[]) => listed.map(({ id }) => id);

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

const turned = (
  fake: Effect.Success<ReturnType<typeof served>>["fake"],
  name: string,
  state: MachineState
) => {
  const held = fake.machines.get(name);

  if (held !== undefined) {
    held.state = state;
  }
};

const unready = (
  fake: Effect.Success<ReturnType<typeof served>>["fake"],
  name: string
) => {
  turned(fake, name, "unknown");
};

const countsRuns = (dir: string) => ({
  script: `#!/bin/sh\necho ran >>"${path.join(dir, "setup-runs")}"\n`,
  timeoutSeconds: 30,
});

const runs = (dir: string) =>
  Effect.map(
    read(path.join(dir, "setup-runs")),
    (text) => text.trim().split("\n").length
  );

const built = (options?: Parameters<typeof served>[0]) =>
  Effect.gen(function* () {
    const plane = yield* served(options);

    yield* plane.client.buildTemplate({
      template: "web",
      ...request("unused", { cpu: 2, ramMib: 2048, diskGib: 20 }),
      setup: countsRuns(plane.dir),
    });
    plane.fake.calls.length = 0;

    return plane;
  });

const fromWeb = { template: "web" } as const;

const servedWithBuildOf = (
  setup: Setup,
  options?: Parameters<typeof served>[0]
) =>
  Effect.gen(function* () {
    const plane = yield* served(options);

    yield* plane.client.buildTemplate({
      template: "web",
      ...request("unused"),
      setup,
    });
    yield* eventually(plane.store.machines, (rows) =>
      rows.every(({ ephemeral }) => !ephemeral)
    );
    plane.fake.calls.length = 0;
    plane.fake.observed.length = 0;

    return plane;
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a create from a template's build runs no setup, then preparation, and answers once the machine runs as asked",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* servedWithBuildOf(installsStart);

        const made = yield* client.create("dev", fromWeb);

        const root = fake.root("dev") ?? "";

        expect(made).toMatchObject({
          id: "dev",
          runtime: "smolvm",
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
        expect(yield* read(path.join(root, "starts"))).toBe("start\nstart\n");
        expect(fake.calls).toStrictEqual([
          "admit dev",
          "restore dev",
          "exec dev",
          "exec dev",
          "exec dev",
        ]);
      })
  );

  for (const as of ["smolvm", "tart"] as const) {
    it.effect(
      `a ${as} machine runs its guest's hook before each stop, pause and delete, and a template's builder runs none`,
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;

          const { client } = yield* servedWithBuildOf(installsLeaveHooks(dir), {
            hosts: [{ id: as, as }],
          });

          const afterBuild = yield* hooksRun(dir);

          yield* client.create("dev", fromWeb);
          yield* client.stopMachine({ id: "dev" });
          yield* client.startMachine({ id: "dev" });
          yield* client.pauseMachine({ id: "dev" });
          yield* client.startMachine({ id: "dev" });
          yield* client.deleteMachine({ id: "dev" });

          expect(afterBuild).toStrictEqual([]);
          expect(yield* hooksRun(dir)).toStrictEqual([
            "stop",
            "pause",
            "delete",
          ]);
        })
    );
  }

  it.effect(
    "a guest's hook is cut short at the control plane's hookTimeout, and its stop goes on",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        const { client, fake } = yield* servedWithBuildOf(
          installsLeaveHooks(dir, "exec sleep 60"),
          { hookTimeoutSeconds: 1 }
        );

        yield* client.create("dev", fromWeb);

        const stopped = yield* client.stopMachine({ id: "dev" });

        expect(stopped).toMatchObject({ state: "stopped", phase: "settled" });
        expect(fake.machines.get("dev")?.state).toBe("stopped");
        expect(yield* hooksRun(dir)).toStrictEqual(["stop"]);
      })
  );

  it.effect(
    "the undo of a copy whose make fails before it takes its identity runs no hook, as its guest is still its source",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        const { client, fake, row } = yield* servedWithBuildOf(
          installsLeaveHooks(dir)
        );

        fake.failNext("exec", new Internal({ message: "agent gone" }));
        yield* Effect.flip(client.create("dev", fromWeb));
        yield* eventually(row("dev"), ({ state }) => state === "undone");

        expect(fake.calls.slice(-2)).toStrictEqual(["exec dev", "delete dev"]);
        expect(yield* hooksRun(dir)).toStrictEqual([]);
      })
  );

  it.effect(
    "the undo of a copy whose start hook fails after it takes its identity runs the guest's delete hook",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const startFails = path.join(dir, "start-fails");
        const hooks = installsLeaveHooks(dir);

        const { client, fake, row } = yield* servedWithBuildOf({
          ...hooks,
          script: [
            hooks.script,
            `printf '#!/bin/sh\\ntest ! -e "%s"\\n' "${startFails}" >"$CLANKERBOX_ROOT/etc/clankerbox/start"`,
            'chmod 755 "$CLANKERBOX_ROOT/etc/clankerbox/start"',
          ].join("\n"),
        });

        yield* write(startFails, "");
        yield* Effect.flip(client.create("dev", fromWeb));
        yield* eventually(row("dev"), ({ state }) => state === "undone");

        expect(fake.calls.slice(-2)).toStrictEqual(["exec dev", "delete dev"]);
        expect(yield* hooksRun(dir)).toStrictEqual(["delete"]);
      })
  );

  it.effect("a mac host's machine is mac", () =>
    Effect.gen(function* () {
      const { client } = yield* served({
        hosts: [{ id: "tart", as: "tart" }],
      });

      const made = yield* client.create("dev", request("dev"));

      expect(made).toMatchObject({ id: "dev", runtime: "tart" });
    })
  );

  it.effect(
    "a start of a machine that already runs prepares it again, admitting nothing",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* servedWithBuildOf(installsStart);

        yield* client.create("dev", fromWeb);
        fake.calls.length = 0;

        const started = yield* client.startMachine({ id: "dev" });

        expect(at(started)).toStrictEqual(["running", "running", "settled"]);
        expect(fake.calls).toStrictEqual(["start dev", "exec dev", "exec dev"]);
        expect(yield* read(path.join(fake.root("dev") ?? "", "starts"))).toBe(
          "start\nstart\nstart\n"
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
          "exec dev",
          "stop dev",
          "admit dev",
          "start dev",
          "exec dev",
          "exec dev",
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
      const listed = yield* client.listMachines();

      expect(got.state).toBe("missing");
      expect(listed.map(({ id, state }) => [id, state])).toStrictEqual([
        ["dev", "missing"],
      ]);
    })
  );

  it.effect(
    "a held read answers at the write that rests the machine, and at its bound when none does",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake } = yield* served();

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });

        const starting = fake.holdNext("start");

        yield* asking.startMachine({ id: "dev" });
        yield* starting.entered;

        const readsBefore = fake.observed.length;

        const [bounded, unrested] = yield* Effect.timed(
          client.getMachine({ id: "dev", holdSeconds: 1 })
        );

        const hostReads = fake.observed.length - readsBefore;

        const resting = yield* Effect.forkChild(
          Effect.timed(client.getMachine({ id: "dev", holdSeconds: 5 }))
        );

        yield* pause;
        yield* starting.release;

        const [woken, rested] = yield* Fiber.join(resting);

        expect([unrested.phase, hostReads]).toStrictEqual(["starting", 1]);
        expect(Duration.toMillis(bounded)).toBeGreaterThanOrEqual(1000);
        expect(at(rested)).toStrictEqual(["running", "running", "settled"]);
        expect(Duration.toMillis(woken)).toBeLessThan(4000);
      })
  );

  it.effect(
    "held reads of one row each answer at the write that rests it, or at their own bound",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake } = yield* served();
        const making = fake.holdNext("create");

        yield* asking.create("dev", request("dev"));
        yield* making.entered;

        const holding = (holdSeconds: number) =>
          Effect.forkChild(
            Effect.timed(client.getMachine({ id: "dev", holdSeconds }))
          );

        const short = yield* holding(1);
        const long = yield* Effect.all([holding(5), holding(5), holding(5)]);
        const [bounded, unrested] = yield* Fiber.join(short);

        yield* making.release;

        const answered = yield* Effect.forEach(long, Fiber.join);
        const waits = answered.map(([waited]) => Duration.toMillis(waited));

        expect(unrested.phase).toBe("creating");
        expect(Duration.toMillis(bounded)).toBeGreaterThanOrEqual(1000);
        expect(answered.map(([, machine]) => at(machine))).toStrictEqual([
          ["running", "running", "settled"],
          ["running", "running", "settled"],
          ["running", "running", "settled"],
        ]);
        expect(Math.max(...waits)).toBeLessThan(4000);
      })
  );

  it.effect("a list reads a host's machines in one read", () =>
    Effect.gen(function* () {
      const { client, fake } = yield* served();

      yield* client.create("a", request("a"));
      yield* client.create("b", request("b"));
      fake.observed.length = 0;

      const listed = yield* client.listMachines();

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

        const listed = yield* client.listMachines();

        expect(listed.map(({ id, state }) => [id, state])).toStrictEqual([
          ["a", "unknown"],
          ["b", "unknown"],
        ]);
        expect((yield* machine("b")).state).toBe("running");
      })
  );

  it.effect(
    "a stop sent while the runtime can't read the machine waits, sending nothing, and the first recheck that reads it stops it",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served({
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));
        unready(fake, "dev");
        fake.calls.length = 0;

        const stop = yield* Effect.forkChild(client.stopMachine({ id: "dev" }));

        const unread = yield* eventually(
          machine("dev"),
          ({ phase, desired }) => phase === "waiting" && desired === "stopped"
        );

        yield* Effect.sleep(Duration.millis(300));

        const whileUnread = [...fake.calls];

        turned(fake, "dev", "running");

        const stopped = yield* Fiber.join(stop);

        expect(at(unread)).toStrictEqual(["unknown", "stopped", "waiting"]);
        expect(whileUnread).toStrictEqual([]);
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
        expect(fake.calls).toStrictEqual(["exec dev", "stop dev"]);
      })
  );

  it.effect(
    "a create whose machine can't be read after its make reads waiting, and the recheck that reads it settles it",
    () =>
      Effect.gen(function* () {
        const { asking, fake, machine, rests } = yield* servedWithBuildOf(
          installsStart,
          { recheck: Duration.millis(200) }
        );

        const keys = fake.holdNext("exec");

        yield* asking.create("dev", fromWeb);
        yield* keys.entered;
        unready(fake, "dev");
        yield* keys.release;

        yield* eventually(
          machine("dev"),
          ({ phase, state }) => phase === "waiting" && state === "unknown"
        );
        yield* Effect.sleep(Duration.millis(300));

        const unread = yield* machine("dev");

        turned(fake, "dev", "running");

        const settled = yield* rests("dev");

        expect(at(unread)).toStrictEqual(["unknown", "running", "waiting"]);
        expect(at(settled)).toStrictEqual(["running", "running", "settled"]);
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

        const listed = yield* client.listMachines();

        expect(listed.map(({ id, state }) => [id, state])).toStrictEqual([
          ["a", "unknown"],
          ["b", "running"],
        ]);
      })
  );

  it.effect(
    "a machine shows an SSH login, as the runtime's user at its row's endpoint, only while it has a host key on record and runs",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, row } =
          yield* servedWithBuildOf(installsStart);

        const plain = yield* client.create("plain", request("plain"));
        const made = yield* client.create("dev", fromWeb);
        const stopped = yield* client.stopMachine({ id: "dev" });

        fake.machines.clear();

        const missing = yield* machine("dev");
        const { endpoint } = yield* row("dev");

        expect(endpoint?.host).toBe("127.0.0.1");
        expect(made.ssh).toStrictEqual({ user: "admin", ...endpoint });
        expect(made.hostKey).toBeDefined();
        expect(
          [plain, stopped, missing].map(({ state, ssh }) => [state, ssh])
        ).toStrictEqual([
          ["running", undefined],
          ["stopped", undefined],
          ["missing", undefined],
        ]);
        expect(plain.hostKey).toBeUndefined();
        expect((yield* row("plain")).endpoint?.host).toBe("127.0.0.1");
      })
  );

  it.effect(
    "a machine whose host can't be read shows its SSH login while it rests asked to run, and none once asked to stop or lost",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* servedWithBuildOf(installsStart);

        yield* client.create("gone", fromWeb);
        yield* client.stopMachine({ id: "gone" });
        fake.machines.clear();
        yield* Effect.flip(client.startMachine({ id: "gone" }));

        const made = yield* client.create("dev", fromWeb);
        yield* client.create("idle", fromWeb);
        yield* client.stopMachine({ id: "idle" });
        fake.failNextObserve(new Internal({ message: "host frozen" }));

        const listed = yield* client.listMachines();

        expect(
          listed.map(({ id, state, phase, ssh }) => [id, state, phase, ssh])
        ).toStrictEqual([
          ["gone", "unknown", "waiting", undefined],
          ["dev", "unknown", "waiting", made.ssh],
          ["idle", "unknown", "waiting", undefined],
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
          hosts: [{ id: "tart", as: "tart" }],
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
        expect(fake.calls).toStrictEqual(["admit dev"]);
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
        expect(
          (yield* client.listMachines()).map(({ id }) => id)
        ).toStrictEqual(["source", "dev"]);
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
          scope: { resource: "machine", name: "dev" },
          sequence: 4,
          step: {
            _tag: "remove",
            machine: { name: "dev", instance: "old" },
            keep: [],
          },
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

  it.effect(
    "a delete that lands during a step that fails answers deleted, as the failure isn't the delete's",
    () =>
      Effect.gen(function* () {
        const { asking, client, fake, row } = yield* served();

        yield* client.create("dev", request("dev"));

        fake.failNext(
          "resize",
          new Internal({ message: "the disk didn't grow" })
        );

        const { entered, release } = fake.holdNext("sizes");

        yield* asking.resizeMachine({ id: "dev", diskGib: 20 });
        yield* entered;

        const deleting = yield* Effect.forkChild(
          client.deleteMachine({ id: "dev" })
        );

        yield* eventually(
          row("dev"),
          ({ state }) => state === "deleting.draining"
        );
        yield* release;

        expect(yield* Fiber.join(deleting)).toBe("deleted");
        expect(fake.machines.has("dev")).toBe(false);
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
          "machine dev is missing from the smolvm runtime; delete it",
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
        expect(fake.calls).toStrictEqual([
          "start dev",
          "exec dev",
          "exec dev",
          "exec dev",
          "stop dev",
        ]);
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
      expect(fake.calls).toStrictEqual([
        "exec dev",
        "stop dev",
        "start dev",
        "exec dev",
        "exec dev",
      ]);
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
      expect(fake.calls).toStrictEqual([
        "exec dev",
        "pause dev",
        "start dev",
        "exec dev",
        "exec dev",
      ]);
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
          "exec dev",
          "pause dev",
          "admit dev",
          "start dev",
          "exec dev",
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
            ["exec dev", "stop dev"],
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
        expect(yield* pins).toStrictEqual(["fake 0"]);
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

  it.effect(
    "exec runs a command in the machine through its host, as the user named, with its env and stdin",
    () =>
      Effect.gen(function* () {
        const { client } = yield* served();

        yield* client.create("dev", request("dev"));

        const executed = yield* client.execMachine({
          id: "dev",
          argv: [
            "/bin/sh",
            "-c",
            'printf "%s %s %s" "$CLANKERBOX_USER" "$TOKEN" "$(cat)"',
          ],
          user: "user",
          env: { TOKEN: "t-1" },
          stdin: "secret",
        });

        expect(executed).toStrictEqual({
          exitCode: 0,
          output: "user t-1 secret",
          truncated: false,
        });
      })
  );

  it.effect(
    "exec waits for a step in flight on the machine, and answers for the state it leaves",
    () =>
      Effect.gen(function* () {
        const { client, asking, fake } = yield* served();

        yield* client.create("dev", request("dev"));

        const { entered, release } = fake.holdNext("stop");

        yield* asking.stopMachine({ id: "dev" });
        yield* entered;

        const executing = yield* Effect.forkChild(
          Effect.flip(client.execMachine({ id: "dev", argv: ["true"] }))
        );

        yield* pause;

        const early = executing.pollUnsafe();

        yield* release;

        const error = yield* Fiber.join(executing);

        expect(early).toBeUndefined();
        expect(error).toMatchObject({
          _tag: "WrongState",
          machine: "dev",
          state: "stopped",
        });
        expect(fake.calls.at(-1)).toBe("stop dev");
      })
  );

  it.effect(
    "exec in a machine being made is NotMade at once, and in none NotFound",
    () =>
      Effect.gen(function* () {
        const { client, asking, fake } = yield* served();
        const { entered, release } = fake.holdNext("create");

        yield* asking.create("dev", request("dev"));
        yield* entered;

        const making = yield* Effect.flip(
          client.execMachine({ id: "dev", argv: ["true"] })
        );

        const none = yield* Effect.flip(
          client.execMachine({ id: "other", argv: ["true"] })
        );

        const calls = [...fake.calls];

        yield* release;

        expect(making._tag).toBe("NotMade");
        expect(none._tag).toBe("NotFound");
        expect(calls).toStrictEqual(["admit dev", "create dev"]);
      })
  );

  it.effect(
    "labels go on a machine at its make, show on it, and pick it out of a list",
    () =>
      Effect.gen(function* () {
        const { client } = yield* served();
        const labels = { app: "web", env: "ci" };

        const made = yield* client.create("dev", request("dev"), { labels });

        yield* client.create("plain", request("plain"));

        const copy = yield* client.forkMachine({
          machine: "dev",
          name: "copy",
          labels: { app: "copy" },
        });

        expect(made.labels).toStrictEqual(labels);
        expect(copy.labels).toStrictEqual({ app: "copy" });
        expect(yield* client.getMachine({ id: "plain" })).not.toHaveProperty(
          "labels"
        );
        expect(
          idsOf(yield* client.listMachines({ labels: { app: "web" } }))
        ).toStrictEqual(["dev"]);
        expect(
          idsOf(
            yield* client.listMachines({ labels: { env: "ci", app: "web" } })
          )
        ).toStrictEqual(["dev"]);
        expect(
          idsOf(yield* client.listMachines({ labels: { app: "none" } }))
        ).toStrictEqual([]);
        expect(idsOf(yield* client.listMachines())).toStrictEqual([
          "dev",
          "plain",
          "copy",
        ]);
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
        expect(fake.calls).toStrictEqual(["admit dev", "create dev"]);
        expect([fake.machines.size, yield* rows]).toStrictEqual([0, []]);
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
        expect(fake.calls.slice(-3)).toStrictEqual([
          "start dev",
          "exec dev",
          "stop dev",
        ]);
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
        expect(fake.calls).toStrictEqual(["exec dev", "delete dev"]);
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
    "the server's authorized keys go to a clone's login user, beside the keys its build left there",
    () =>
      Effect.gen(function* () {
        const keys = path.join("home", "admin", ".ssh", "authorized_keys");

        const { client, fake } = yield* servedWithBuildOf({
          script: [
            installsStart.script,
            hostKeySetup,
            'mkdir -p "$CLANKERBOX_ROOT/home/admin/.ssh"',
            `printf "${theirs}" >"$CLANKERBOX_ROOT/${keys}"`,
          ].join("\n"),
        });

        yield* client.buildTemplate({
          template: "fresh",
          ...request("unused"),
          setup: { script: `#!/bin/sh\n${hostKeySetup}` },
        });
        yield* client.create("dev", fromWeb);
        yield* client.create("fresh", { template: "fresh" });

        const fresh = path.join(fake.root("fresh") ?? "", keys);

        expect(yield* read(path.join(fake.root("dev") ?? "", keys))).toBe(
          `${theirs}\n${operatorKey}\n`
        );
        expect(fake.calls.filter((call) => call === "exec dev")).toHaveLength(
          3
        );
        expect(yield* read(fresh)).toBe(`\n${operatorKey}\n`);
        expect((yield* stat(fresh)).mode & 0o777).toBe(0o600);
      })
  );

  it.effect(
    "a request sent while a failed create is undone is NotFound, and leaves the create its failure",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();
        const undoing = fake.holdNext("delete");

        fake.failNext("create", new Internal({ message: "krun EINVAL" }));

        const creating = yield* Effect.forkChild(
          Effect.flip(client.create("dev", request("dev")))
        );

        yield* undoing.entered;

        const refused = yield* Effect.flip(client.stopMachine({ id: "dev" }));

        yield* undoing.release;

        expect(refused._tag).toBe("NotFound");
        expect((yield* Fiber.join(creating))._tag).toBe("Internal");
        expect(refusal(yield* machine("dev"))).toStrictEqual([
          "failed",
          "Internal",
        ]);
      })
  );

  it.effect(
    "a fork of a machine whose make still runs is NotMade, and a stop waits for the make, then stops it",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine, row } = yield* served();
        const { release, entered } = fake.holdNext("create");

        const creating = yield* Effect.forkChild(
          Effect.flip(client.create("dev", request("dev")))
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

  it.effect("a create, fork or restore that succeeds makes its machine", () =>
    Effect.gen(function* () {
      const { client, rows } = yield* served();

      yield* client.create("dev", request("dev"));
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
        expect(fake.calls).toStrictEqual(["start dev", "exec dev", "exec dev"]);
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
        (calls) => calls.length >= 8
      );

      expect(fake.calls.toSorted()).toStrictEqual([
        "admit dev",
        "admit other",
        "exec dev",
        "exec dev",
        "exec other",
        "exec other",
        "start dev",
        "start other",
      ]);
    })
  );

  it.effect(
    "a machine its runtime stopped unasked is started again, where machines stop on their own",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served({
          hosts: [{ id: "fixed", as: "fixed" }],
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));

        fake.calls.length = 0;
        yield* fake.faults.drift(fake.machines.get("dev")?.instance ?? "");

        const back = yield* eventually(
          machine("dev"),
          ({ state, phase }) =>
            fake.calls.includes("start dev") &&
            state === "running" &&
            phase === "settled"
        );

        expect(at(back)).toStrictEqual(["running", "running", "settled"]);
        expect(
          fake.calls.filter((call) => call.startsWith("start"))
        ).toStrictEqual(["start dev"]);
      })
  );

  it.effect("a fork and a restore are sized by their host's traits", () =>
    Effect.gen(function* () {
      const { client, store } = yield* served({
        hosts: [{ id: "fixed", as: "fixed" }],
      });

      const odd = { cpu: 3, ramMib: 6144, diskGib: 40 };
      yield* client.create("dev", request("dev"));
      yield* client.stopMachine({ id: "dev" });
      yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

      const refused = [
        yield* Effect.flip(
          client.forkMachine({ machine: "dev", name: "fork", ...odd })
        ),
        yield* Effect.flip(
          client.restoreMachine({ checkpoint: "snap", name: "copy", ...odd })
        ),
      ];

      expect(refused.map(({ _tag }) => _tag)).toStrictEqual([
        "Unsizable",
        "Unsizable",
      ]);
      expect((yield* store.machines).map(({ name }) => name)).toStrictEqual([
        "dev",
      ]);
    })
  );

  it.effect(
    "sizes outside a host's size classes are refused for a resize, a fork and a restore before any runtime call",
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* served({
          hosts: [{ id: "fixed", as: "fixed" }],
        });

        const odd = { cpu: 3, ramMib: 6144, diskGib: 40 };

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        fake.calls.length = 0;

        const refused = [
          yield* Effect.flip(client.resizeMachine({ id: "dev", ...odd })),
          yield* Effect.flip(
            client.forkMachine({ machine: "dev", name: "fork", ...odd })
          ),
          yield* Effect.flip(
            client.restoreMachine({ checkpoint: "snap", name: "copy", ...odd })
          ),
        ];

        const resized = yield* client.resizeMachine({
          id: "dev",
          cpu: 2,
          ramMib: 4096,
          diskGib: 20,
        });

        expect(refused.map(({ _tag }) => _tag)).toStrictEqual([
          "Unsizable",
          "Unsizable",
          "Unsizable",
        ]);
        expect(refused[0]?.message).toContain("only its size classes");
        expect([resized.cpu, resized.ramMib, resized.diskGib]).toStrictEqual([
          2, 4096, 20,
        ]);
        expect(
          fake.calls.filter((call) => /^(?:fork|restore|resize) /u.test(call))
        ).toStrictEqual(["resize dev"]);
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
          { host: "smolvm", resource: "cpu", used: 0 },
          { host: "smolvm", resource: "ramMib", limit: 4096, used: 0 },
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
    "a stop on a host that is down is saved, and its wait reads on until the host is back and the machine stops",
    () =>
      Effect.gen(function* () {
        const { client, fake, host, machine } = yield* served({
          recheck: Duration.millis(200),
        });

        yield* client.create("dev", request("dev"));
        yield* host.dispose;

        const stop = yield* Effect.forkChild(client.stopMachine({ id: "dev" }));

        const waiting = yield* eventually(
          machine("dev"),
          ({ desired }) => desired === "stopped"
        );

        yield* restartedHost(host);

        const stopped = yield* Fiber.join(stop);

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
        const listed = yield* client.listMachines();

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
          { host: "smolvm", resource: "cpu", used: 1 },
          { host: "smolvm", resource: "ramMib", limit: 4096, used: 1024 },
        ]);
        expect(booting.usage).toStrictEqual([
          { host: "smolvm", resource: "cpu", used: 2 },
          { host: "smolvm", resource: "ramMib", limit: 4096, used: 3072 },
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
        unreported: [
          {
            host: "smolvm",
            state: "unreachable",
            problem: "tart list exited 1",
          },
        ],
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
            ?.machines.map(({ machine, _tag }) => [
              machine.name,
              _tag === "booting",
            ])
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

        const { client, row } = yield* served({
          runtime: { ports: portsOfHere },
        });

        yield* Effect.forEach(
          ["a", "b", "c"],
          (name) => client.create(name, request(name)),
          { concurrency: "unbounded" }
        );

        const rows = yield* Effect.forEach(["a", "b", "c"], row);

        const taken = rows
          .map(({ endpoint }) => endpoint?.port ?? 0)
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
          activation?.machines.map(({ machine, _tag }) => [
            machine.name,
            machine.ramMib,
            _tag === "booting",
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
    "sizes a host's runtime can't give reach the client, and the row, of a resize and of a copy",
    () =>
      Effect.gen(function* () {
        const { client, fake, machine } = yield* served();

        yield* client.create("dev", request("dev"));

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

        expect(
          [resized, forked].map(({ _tag, message }) => [_tag, message])
        ).toStrictEqual([
          ["Unsizable", refused.message],
          ["Unsizable", refused.message],
        ]);
        expect(sizesOf(yield* machine("dev"))).toStrictEqual([1, 1024, 10]);
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
        fake.resizedTo("dev", { cpu: 1, ramMib: 2048, diskGib: 10 });

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
      turned(fake, "dev", "running");

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
          hosts: [{ id: "tart", as: "tart" }],
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
            "machine copy's host copies a machine only at its source's sizes or larger, so its vCPUs and RAM only grow from the source's 2 vCPUs and 1G",
          ],
          [
            "Unsizable",
            "machine copy's host copies a machine only at its source's sizes or larger, so its vCPUs and RAM only grow from the source's 2 vCPUs and 1G",
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
    "a fork or capture of a running machine on a host that copies only a stopped one is WrongState before a row is written, and so is one of a stopped machine where a copy takes a running one",
    () =>
      Effect.gen(function* () {
        const mac = yield* served({ hosts: [{ id: "tart", as: "tart" }] });
        const linux = yield* served();

        yield* mac.client.create("dev", request("dev"));
        yield* linux.client.create("dev", request("dev"));
        yield* linux.client.stopMachine({ id: "dev" });
        mac.fake.calls.length = 0;
        linux.fake.calls.length = 0;

        const refused = [
          yield* Effect.flip(
            mac.client.forkMachine({ machine: "dev", name: "copy" })
          ),
          yield* Effect.flip(
            mac.client.captureCheckpoint({ machine: "dev", name: "snap" })
          ),
          yield* Effect.flip(
            linux.client.forkMachine({ machine: "dev", name: "copy" })
          ),
          yield* Effect.flip(
            linux.client.captureCheckpoint({ machine: "dev", name: "snap" })
          ),
        ];

        expect(
          refused.map((error) => [
            error._tag,
            error.message,
            "made" in error ? error.made : undefined,
          ])
        ).toStrictEqual([
          [
            "WrongState",
            "machine dev is running, and its host copies a machine only stopped: stop it, then fork it",
            undefined,
          ],
          [
            "WrongState",
            "machine dev is running, and its host copies a machine only stopped: stop it, then capture it",
            undefined,
          ],
          [
            "WrongState",
            "machine dev is stopped, and its host copies a machine only running: start it, then fork it",
            undefined,
          ],
          [
            "WrongState",
            "machine dev is stopped, and its host copies a machine only running: start it, then capture it",
            undefined,
          ],
        ]);
        expect(
          [yield* mac.rows, yield* linux.rows].map((rows) =>
            rows.map(({ name }) => name)
          )
        ).toStrictEqual([["dev"], ["dev"]]);
        expect([
          (yield* mac.store.checkpoints).length,
          (yield* linux.store.checkpoints).length,
        ]).toStrictEqual([0, 0]);
        expect(
          [...mac.fake.calls, ...linux.fake.calls].filter(
            (call) => call.startsWith("fork") || call.startsWith("capture")
          )
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "a fork of a machine still moving toward the state its host copies is recorded, though its host reads it in the other, and copies it once it gets there",
    () =>
      Effect.gen(function* () {
        const mac = yield* served({ hosts: [{ id: "tart", as: "tart" }] });

        yield* mac.client.create("dev", request("dev"));

        const stopping = mac.fake.holdNext("stop");

        yield* mac.asking.stopMachine({ id: "dev" });
        yield* stopping.entered;

        const fork = yield* Effect.forkChild(
          mac.client.forkMachine({ machine: "dev", name: "copy" })
        );

        yield* eventually(mac.store.findMachine("copy"), Option.isSome);
        yield* stopping.release;

        expect((yield* Fiber.join(fork)).id).toBe("copy");
        expect(mac.fake.calls).toContain("fork copy");
      })
  );

  it.effect(
    "a fork of a machine whose host can't be read is Unavailable and records nothing, and a capture of it is recorded for its host to decide",
    () =>
      Effect.gen(function* () {
        const plane = yield* served();

        yield* plane.client.create("dev", request("dev"));
        yield* plane.host.dispose;

        const refused = yield* Effect.flip(
          plane.client.forkMachine({ machine: "dev", name: "copy" })
        );

        const capturing = yield* plane.asking.captureCheckpoint({
          machine: "dev",
          name: "snap",
        });

        expect(refused).toMatchObject({
          _tag: "Unavailable",
          readOnly: true,
          action: "forkMachine",
        });
        expect(refused).not.toHaveProperty("made");
        expect((yield* plane.rows).map(({ name }) => name)).toStrictEqual([
          "dev",
        ]);
        expect(capturing).toMatchObject({ id: "snap", phase: "capturing" });
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

        yield* eventually(Effect.option(machine("copy")), Option.isSome);
        yield* release;

        const refused = yield* Fiber.join(fork);

        expect([refused._tag, refused.message]).toStrictEqual([
          "Unsizable",
          "machine copy's host copies a machine only at its source's sizes or larger, so its vCPUs and RAM only grow from the source's 1 vCPU and 2G",
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
          hosts: [{ id: "tart", as: "tart" }],
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
        hosts: [{ id: "tart", as: "tart" }],
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

  it.effect("a create from a template never sends a setup", () =>
    Effect.gen(function* () {
      const { client, dir, fake, row } = yield* built();

      const made = yield* client.create("box", { template: "web" });
      const { source } = yield* row("box");

      expect(made).toMatchObject({
        template: "web@1",
        base: "ubuntu",
        phase: "settled",
        state: "running",
      });
      expect(sizesOf(made)).toStrictEqual([2, 2048, 20]);
      expect(source.kind).toBe("checkpoint");
      expect(fake.calls).toContain("restore box");
      expect(fake.calls).not.toContain("create box");
      expect(yield* runs(dir)).toBe(1);
    })
  );

  it.effect("a copy whose preparation fails is undone", () =>
    Effect.gen(function* () {
      const { client, fake, row } = yield* built();

      fake.failNext("exec", new Internal({ message: "sshd didn't start" }));

      const error = yield* Effect.flip(
        client.create("box", { template: "web" })
      );

      const undone = yield* row("box");

      expect([error._tag, error.message]).toStrictEqual([
        "Internal",
        "sshd didn't start",
      ]);
      expect([undone.state, undone.error?.message]).toStrictEqual([
        "undone",
        "sshd didn't start",
      ]);
      expect(fake.calls.filter((call) => call.endsWith(" box"))).toStrictEqual([
        "admit box",
        "restore box",
        "exec box",
        "exec box",
        "exec box",
        "delete box",
      ]);
      expect(fake.machines.has("box")).toBe(false);
    })
  );

  it.effect("a pinned build is cloned", () =>
    Effect.gen(function* () {
      const { client, dir, row, store } = yield* built();

      yield* client.buildTemplate({
        template: "web",
        ...request("unused", { cpu: 2, ramMib: 2048, diskGib: 20 }),
        setup: countsRuns(dir),
      });

      const pinned = yield* client.create("old", { template: "web@1" });
      const current = yield* client.create("new", { template: "web" });

      const copyOf = (build: string) =>
        Effect.map(
          store.checkpoints,
          (rows) => rows.find((each) => each.build === build)?.name
        );

      expect([pinned.template, current.template]).toStrictEqual([
        "web@1",
        "web@2",
      ]);
      expect((yield* row("old")).source).toStrictEqual({
        kind: "checkpoint",
        name: yield* copyOf("web@1"),
      });
      expect((yield* row("new")).source).toStrictEqual({
        kind: "checkpoint",
        name: yield* copyOf("web@2"),
      });
    })
  );

  it.effect("a template with no ready build fails NotBuilt", () =>
    Effect.gen(function* () {
      const { client, rows } = yield* built();

      yield* Effect.flip(
        client.buildTemplate({
          template: "broken",
          ...request("unused"),
          setup: exits3,
        })
      );

      const [unknown, failed, unkept] = yield* Effect.all([
        Effect.flip(client.create("a", { template: "nope" })),
        Effect.flip(client.create("b", { template: "broken" })),
        Effect.flip(client.create("c", { template: "web@9" })),
      ]);

      expect(unknown).toMatchObject({ _tag: "NotBuilt", template: "nope" });
      expect(unknown.message).toContain(
        "template nope has no ready build: run clankerbox template build on nope's template file to make one"
      );
      expect(failed).toMatchObject({ _tag: "NotBuilt", template: "broken" });
      expect(unkept.message).toBe(
        "template web has no ready build web@9: its ready builds are web@1"
      );
      expect(yield* rows).toStrictEqual([]);
    })
  );

  it.effect(
    "a create from a template takes the build's sizes or larger ones, on linux and mac, and refuses smaller ones Unsizable",
    () =>
      Effect.gen(function* () {
        for (const as of ["smolvm", "tart"] as const) {
          const { client } = yield* built({ hosts: [{ id: as, as }] });

          const larger = yield* client.create("larger", {
            template: "web",
            cpu: 4,
            ramMib: 4096,
            diskGib: 40,
          });

          const smaller = yield* Effect.forEach(
            [{ cpu: 1 }, { ramMib: 1024 }, { diskGib: 10 }],
            (sizing) =>
              Effect.flip(
                client.create("smaller", { template: "web", ...sizing })
              )
          );

          expect(sizesOf(larger)).toStrictEqual([4, 4096, 40]);
          expect(smaller.map(({ _tag }) => _tag)).toStrictEqual([
            "Unsizable",
            "Unsizable",
            "Unsizable",
          ]);
          expect(smaller[0]?.message).toContain(
            "takes at least build web@1's 2 vCPUs"
          );
        }
      })
  );

  it.effect(
    "a build holds the server's keys, and a create cloned from it holds each once",
    () =>
      Effect.gen(function* () {
        const { client, fake, host, store } = yield* built();
        const [copy] = yield* store.checkpoints;

        yield* client.create("box", { template: "web" });

        expect(
          yield* read(
            path.join(
              host.dir,
              "checkpoints",
              copy?.instance ?? "",
              "home/admin/.ssh/authorized_keys"
            )
          )
        ).toBe(`\n${operatorKey}\n`);
        expect(
          yield* read(
            path.join(fake.root("box") ?? "", "home/admin/.ssh/authorized_keys")
          )
        ).toBe(`\n${operatorKey}\n`);
      })
  );
});
