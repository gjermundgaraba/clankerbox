import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { startHost } from "@gjermundgaraba/clankerbox-host/testing";
import type { TestHost } from "@gjermundgaraba/clankerbox-host/testing";
import {
  Capacity,
  Conflict,
  Internal,
  NotMade,
  PinMismatch,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Client, Kind } from "@gjermundgaraba/clankerbox-sdk";
import { read } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { DateTime, Duration, Effect, Fiber, Option } from "effect";
import { expect } from "vite-plus/test";

import * as Sqlite from "../src/platform/sqlite.ts";
import {
  at,
  clientOf,
  eventually,
  callsTo,
  firstHost,
  machineNames,
  patched,
  pause,
  plane,
  request,
  withClient,
} from "./support.ts";
import type { Plane, Started, running } from "./support.ts";

const keyed = {
  script: [
    "#!/bin/sh",
    'mkdir -p "$CLANKERBOX_ROOT/etc/ssh"',
    ': >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key"',
    'echo "ssh-ed25519 AAAAimage root@image" >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key.pub"',
  ].join("\n"),
  timeoutSeconds: 30,
};

const nearby = Duration.millis(300);

const onKind = (kind: Kind | undefined) => ({
  hosts: [kind === undefined ? { id: "linux" } : { id: kind, kind }],
});

const withSource = (options?: Parameters<typeof running>[0]) =>
  Effect.gen(function* () {
    const served = yield* withClient(options);

    yield* served.client.buildTemplate({
      template: "keyed",
      ...request("unused"),
      setup: keyed,
    });
    yield* served.client.create("dev", { template: "keyed" });
    served.host.fake.calls.length = 0;

    return served;
  });

const captured = (store: Started["store"]) =>
  Effect.map(store.checkpoints, (rows) =>
    rows.filter(({ build }) => build === undefined)
  );

const checkpointIds = (client: Client.Interface) =>
  Effect.map(client.listCheckpoints(), (listed) => listed.map(({ id }) => id));

const machineId = (host: TestHost, name: string) =>
  read(path.join(host.fake.root(name) ?? "", "var/lib/clankerbox/machine-id"));

const rested = (served: Pick<Started, "store">, name: string) =>
  Effect.map(
    eventually(served.store.findCheckpoint(name), (found) =>
      Option.exists(
        found,
        ({ state }) => state === "ready" || state === "failed"
      )
    ),
    Option.getOrThrow
  );

const gone = (served: Pick<Started, "store">, name: string) =>
  eventually(served.store.findCheckpoint(name), Option.isNone);

const restarted = (host: TestHost) =>
  Effect.gen(function* () {
    yield* host.dispose;

    const again = yield* startHost(host.dir, {
      id: host.id,
      fake: host.fake,
      port: Number(new URL(host.url).port),
    });

    yield* Effect.addFinalizer(() => again.dispose);

    return again;
  });

const seeded = <A, E>(
  { stateDir }: Pick<Plane, "stateDir">,
  use: (store: Started["store"]) => Effect.Effect<A, E>
) => Effect.scoped(Effect.flatMap(Sqlite.open({ stateDir }), use));

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a fork copies the running machine to a new one, prepared with its own identity and port",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();
        const source = yield* client.getMachine({ id: "dev" });

        const copy = yield* client.forkMachine({
          machine: "dev",
          name: "copy",
        });

        expect(copy).toMatchObject({
          id: "copy",
          base: "ubuntu",
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
          state: "running",
          desired: "running",
          phase: "settled",
        });
        expect(copy.ssh?.port).not.toBe(source.ssh?.port);
        expect(copy.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(copy.hostKey).not.toBe(source.hostKey);
        expect(yield* machineId(host, "copy")).toBe("copy\n");
        expect(yield* machineId(host, "dev")).toBe("dev\n");
        expect(host.fake.calls).toStrictEqual([
          "admit copy",
          "fork copy",
          "exec copy",
          "exec copy",
        ]);
      })
  );

  it.effect(
    "a fork shares its source: a stop of it waits for the copy, and a second fork copies beside the first",
    () =>
      Effect.gen(function* () {
        const { client, host, machines } = yield* withSource();
        const { release, entered } = host.fake.holdNext("fork");

        const fork = yield* Effect.forkChild(
          client.forkMachine({ machine: "dev", name: "copy" })
        );

        yield* entered;

        const other = yield* client.forkMachine({
          machine: "dev",
          name: "other",
        });

        const stopping = yield* Effect.forkChild(
          client.stopMachine({ id: "dev" })
        );

        yield* eventually(
          machines.get("dev"),
          ({ desired }) => desired === "stopped"
        );
        yield* pause;

        const beforeRelease = [...host.fake.calls];

        yield* release;

        const [copy, stopped] = yield* Effect.all([
          Fiber.join(fork),
          Fiber.join(stopping),
        ]);

        expect(beforeRelease).not.toContain("stop dev");
        expect([copy, other].map(at)).toStrictEqual([
          ["running", "running", "settled"],
          ["running", "running", "settled"],
        ]);
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
      })
  );

  it.effect(
    "an admission during a fork counts the copy as booting, not the source the fork shares",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();
        const { release, entered } = host.fake.holdNext("fork");

        const fork = yield* Effect.forkChild(
          client.forkMachine({ machine: "dev", name: "copy" })
        );

        const booting = () =>
          Object.fromEntries(
            (host.fake.activations.at(-1)?.machines ?? []).map((activated) => [
              activated.machine.name,
              activated.booting,
            ])
          );

        yield* entered;
        yield* client.create("other", request("other"));

        const duringFork = booting();

        yield* release;
        yield* Fiber.join(fork);
        yield* client.create("later", request("later"));

        expect(duringFork).toStrictEqual({
          dev: false,
          copy: true,
          other: true,
        });
        expect(booting()).toStrictEqual({
          dev: false,
          copy: false,
          other: false,
          later: true,
        });
      })
  );

  it.effect(
    "a fork refused at admission answers Capacity, and leaves a failed row and no VM",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();

        host.fake.failNext("admit", new Capacity({ message: "no room" }));

        const error = yield* Effect.flip(
          client.forkMachine({ machine: "dev", name: "copy" })
        );

        expect([error._tag, error.message]).toStrictEqual([
          "Capacity",
          "no room",
        ]);
        expect(yield* client.getMachine({ id: "copy" })).toMatchObject({
          state: "missing",
          phase: "failed",
          error: { _tag: "Capacity" },
        });
        expect(host.fake.machines.has("copy")).toBe(false);
      })
  );

  it.effect(
    "a fork of a source the runtime doesn't copy is refused, and leaves no VM",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();

        yield* client.stopMachine({ id: "dev" });

        const error = yield* Effect.flip(
          client.forkMachine({ machine: "dev", name: "copy" })
        );

        expect([error._tag, error.message]).toStrictEqual([
          "WrongState",
          "dev is stopped: start it first",
        ]);
        expect(host.fake.machines.has("copy")).toBe(false);
        expect(callsTo(host, "fork")).toStrictEqual(["fork copy"]);
      })
  );

  it.effect(
    "a fork or restore that fails natively takes its VM away, keeps a failed row, and answers the failure",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        for (const [name, operation, make] of [
          [
            "forked",
            "fork",
            client.forkMachine({ machine: "dev", name: "forked" }),
          ],
          [
            "restored",
            "restore",
            client.restoreMachine({ checkpoint: "snap", name: "restored" }),
          ],
        ] as const) {
          host.fake.calls.length = 0;
          host.fake.failNext(
            operation,
            new Internal({ message: "port swap failed" })
          );

          const error = yield* Effect.flip(make);
          const got = yield* client.getMachine({ id: name });

          expect([error._tag, error.message]).toStrictEqual([
            "Internal",
            "port swap failed",
          ]);
          expect(got).toMatchObject({ state: "missing", phase: "failed" });
          expect(host.fake.calls).toStrictEqual([
            `admit ${name}`,
            `${operation} ${name}`,
            `delete ${name}`,
          ]);
        }
      })
  );

  it.effect(
    "a fork or restore that fails in preparation is undone, and its copy deleted",
    () =>
      Effect.gen(function* () {
        const { client, host, store } = yield* withSource();

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        for (const [name, make] of [
          ["forked", client.forkMachine({ machine: "dev", name: "forked" })],
          [
            "restored",
            client.restoreMachine({ checkpoint: "snap", name: "restored" }),
          ],
        ] as const) {
          host.fake.failNext(
            "exec",
            new Internal({ message: "sshd didn't start" })
          );
          const error = yield* Effect.flip(make);
          const row = Option.getOrThrow(yield* store.findMachine(name));

          expect([error._tag, error.message]).toStrictEqual([
            "Internal",
            "sshd didn't start",
          ]);
          expect([row.state, row.error?.message]).toStrictEqual([
            "undone",
            "sshd didn't start",
          ]);
          expect(host.fake.machines.has(name)).toBe(false);
        }
      })
  );

  it.effect("a fork to a taken name is Conflict, and calls nothing", () =>
    Effect.gen(function* () {
      const { client, host, machines } = yield* withSource();

      yield* client.create("copy", request("copy"));
      host.fake.calls.length = 0;

      const error = yield* Effect.flip(
        machines.fork({ machine: "dev", name: "copy" })
      );

      expect(error).toStrictEqual(
        new Conflict({ message: "machine copy exists", id: "copy" })
      );
      expect(host.fake.calls).toStrictEqual([]);
    })
  );

  it.effect(
    "a capture to a taken name is Conflict, and leaves the checkpoint as it was",
    () =>
      Effect.gen(function* () {
        const { client, checkpoints } = yield* withSource();

        const first = yield* client.captureCheckpoint({
          machine: "dev",
          name: "snap",
        });

        const error = yield* Effect.flip(
          checkpoints.capture({ machine: "dev", name: "snap" })
        );

        expect(error).toStrictEqual(
          new Conflict({ message: "checkpoint snap exists", id: "snap" })
        );
        expect(yield* client.listCheckpoints()).toStrictEqual([first]);
      })
  );

  it.effect("a new name too long is Invalid, and calls nothing", () =>
    Effect.gen(function* () {
      const { client, host } = yield* withSource();
      const long = "a".repeat(63);

      yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
      host.fake.calls.length = 0;

      const errors = [
        yield* Effect.flip(client.forkMachine({ machine: "dev", name: long })),
        yield* Effect.flip(
          client.restoreMachine({ checkpoint: "snap", name: long })
        ),
        yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: long })
        ),
      ];

      expect(errors.map(({ _tag }) => _tag)).toStrictEqual([
        "Invalid",
        "Invalid",
        "Invalid",
      ]);
      expect(host.fake.calls).toStrictEqual([]);
    })
  );

  it.effect(
    "a capture of a running machine is ram, with the source's spec and the runtime's pin",
    () =>
      Effect.gen(function* () {
        const { client, store } = yield* withSource();

        const ram = yield* client.captureCheckpoint({
          machine: "dev",
          name: "hot",
        });

        const rows = yield* captured(store);

        expect(ram).toStrictEqual({
          id: "hot",
          createdAt: ram.createdAt,
          machine: "dev",
          kind: "ram",
          phase: "ready",
          base: "ubuntu",
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
        });
        expect(rows.map(({ name, pin }) => [name, pin])).toStrictEqual([
          ["hot", "fake 1"],
        ]);
        expect(yield* client.listCheckpoints()).toStrictEqual([ram]);
      })
  );

  it.effect(
    "a capture of a stopped machine on a ram runtime is WrongState, and leaves a failed row no list shows",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource();
        const { client, host } = served;

        yield* client.stopMachine({ id: "dev" });

        const error = yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: "cold" })
        );

        expect([error._tag, error.message]).toStrictEqual([
          "WrongState",
          "dev is stopped: start it first",
        ]);
        expect((yield* rested(served, "cold")).state).toBe("failed");
        expect(yield* client.getCheckpoint({ id: "cold" })).toMatchObject({
          phase: "failed",
          error: { _tag: "WrongState" },
        });
        expect(yield* checkpointIds(client)).toStrictEqual([]);
        expect(host.fake.calls).toContain("deleteCheckpoint cold");
      })
  );

  it.effect("a mac capture of a stopped machine is disk, with no pin", () =>
    Effect.gen(function* () {
      const { client, store } = yield* withSource(onKind("mac"));

      yield* client.stopMachine({ id: "dev" });

      const disk = yield* client.captureCheckpoint({
        machine: "dev",
        name: "cold",
      });

      const rows = yield* captured(store);

      expect(disk).toMatchObject({ id: "cold", kind: "disk", phase: "ready" });
      expect(rows.map(({ name, pin }) => [name, pin])).toStrictEqual([
        ["cold", undefined],
      ]);
    })
  );

  it.effect(
    "a capture sent while a create runs is NotMade, and works once the machine is made",
    () =>
      Effect.gen(function* () {
        const { client, host, checkpoints } = yield* withClient();
        const { release, entered } = host.fake.holdNext("create");

        const create = yield* Effect.forkChild(
          client.create("dev", request("dev"))
        );

        yield* entered;

        const early = yield* Effect.flip(
          checkpoints.capture({ machine: "dev", name: "snap" })
        );

        yield* release;
        yield* Fiber.join(create);

        const snap = yield* client.captureCheckpoint({
          machine: "dev",
          name: "snap",
        });

        expect(early).toBeInstanceOf(NotMade);
        expect(callsTo(host, "capture")).toStrictEqual(["capture snap"]);
        expect(snap.phase).toBe("ready");
      })
  );

  it.effect(
    "a capture waits for a step that owns its machine, then captures",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();
        const { release, entered } = host.fake.holdNext("stop");

        const stopping = yield* Effect.forkChild(
          client.stopMachine({ id: "dev" })
        );

        yield* entered;

        const capturing = yield* Effect.forkChild(
          client
            .captureCheckpoint({ machine: "dev", name: "snap" })
            .pipe(Effect.flip)
        );

        yield* pause;

        const beforeRelease = [...host.fake.calls];

        yield* release;
        yield* Fiber.join(stopping);

        const refused = yield* Fiber.join(capturing);

        expect(beforeRelease).not.toContain("capture snap");
        expect(refused._tag).toBe("WrongState");
        expect(host.fake.calls.indexOf("capture snap")).toBeGreaterThan(
          host.fake.calls.indexOf("stop dev")
        );
      })
  );

  it.effect(
    "a capture of a machine the runtime doesn't have is Missing, and of no machine NotFound",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();

        host.fake.machines.clear();

        const missing = yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: "snap" })
        );

        const none = yield* Effect.flip(
          client.captureCheckpoint({ machine: "gone", name: "other" })
        );

        expect(missing._tag).toBe("Missing");
        expect(none._tag).toBe("NotFound");
        expect(yield* checkpointIds(client)).toStrictEqual([]);
      })
  );

  it.effect(
    "a capture that fails natively clears what it began, and its row says why",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource();
        const { client, host } = served;

        host.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));

        const error = yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: "snap" })
        );

        const row = yield* rested(served, "snap");

        expect(error.message).toBe("ENOTSUP");
        expect(row).toMatchObject({
          state: "failed",
          error: { message: "ENOTSUP" },
        });
        expect(row.failedAt).toBeDefined();
        expect(callsTo(host, "capture")).toStrictEqual(["capture snap"]);
        expect(host.fake.calls.at(-1)).toBe("deleteCheckpoint snap");
      })
  );

  it.effect(
    "a capture refused is deleted once, by its host, with no step of the control plane's",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.forEach(
          ["linux", "mac"] as const,
          (kind) =>
            Effect.gen(function* () {
              const served = yield* withSource(onKind(kind));
              const { client, host } = served;

              if (kind === "linux") {
                yield* client.stopMachine({ id: "dev" });
              }

              host.fake.calls.length = 0;

              const error = yield* Effect.flip(
                client.captureCheckpoint({ machine: "dev", name: "snap" })
              );

              const row = yield* rested(served, "snap");

              return {
                tag: error._tag,
                state: row.state,
                failed: row.failedAt !== undefined,
                calls: [...host.fake.calls],
                freed: Option.isSome(
                  yield* Effect.timeoutOption(
                    client.deleteMachine({ id: "dev" }),
                    Duration.seconds(10)
                  )
                ),
              };
            })
        );

        expect(refused).toStrictEqual(
          ["linux", "mac"].map(() => ({
            tag: "WrongState",
            state: "failed",
            failed: true,
            calls: ["capture snap", "deleteCheckpoint snap"],
            freed: true,
          }))
        );
      })
  );

  it.effect(
    "a capture carries its labels and expiry, which a restore of it doesn't take, and a list takes a filter",
    () =>
      Effect.gen(function* () {
        const { client } = yield* withSource();

        const expiresAt = DateTime.addDuration(
          yield* DateTime.now,
          Duration.days(1)
        );

        const snap = yield* client.captureCheckpoint({
          machine: "dev",
          name: "snap",
          labels: { app: "web" },
          expiresAt,
        });

        yield* client.captureCheckpoint({ machine: "dev", name: "plain" });

        const restored = yield* client.restoreMachine({
          checkpoint: "snap",
          name: "copy",
          labels: { from: "snap" },
        });

        const got = yield* client.getCheckpoint({ id: "snap" });

        expect(snap.labels).toStrictEqual({ app: "web" });
        expect(
          [snap, got].map((shown) =>
            shown.expiresAt === undefined
              ? undefined
              : DateTime.toEpochMillis(shown.expiresAt)
          )
        ).toStrictEqual([
          DateTime.toEpochMillis(expiresAt),
          DateTime.toEpochMillis(expiresAt),
        ]);
        expect(restored.labels).toStrictEqual({ from: "snap" });
        expect(
          (yield* client.listCheckpoints({ labels: { app: "web" } })).map(
            ({ id }) => id
          )
        ).toStrictEqual(["snap"]);
        expect(yield* checkpointIds(client)).toStrictEqual(["snap", "plain"]);
      })
  );

  it.effect(
    "a ready checkpoint past its expiry is deleted at a recheck, and one with none stays",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource({ recheck: nearby });
        const { client, host } = served;

        const soon = DateTime.addDuration(
          yield* DateTime.now,
          Duration.millis(300)
        );

        yield* client.captureCheckpoint({
          machine: "dev",
          name: "brief",
          expiresAt: soon,
        });
        yield* client.captureCheckpoint({ machine: "dev", name: "kept" });
        yield* gone(served, "brief");

        expect(yield* checkpointIds(client)).toStrictEqual(["kept"]);
        expect(callsTo(host, "deleteCheckpoint")).toStrictEqual([
          "deleteCheckpoint brief",
        ]);
      })
  );

  it.effect(
    "a pause with a capture records the checkpoint first, and pauses once the capture has begun, so it holds the machine as it ran",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();
        const { entered, release } = host.fake.holdNext("capture");

        const pausing = yield* Effect.forkChild(
          client.pauseMachine({
            id: "dev",
            capture: { name: "snap", labels: { app: "web" } },
          })
        );

        yield* entered;

        const during = yield* eventually(
          client.getMachine({ id: "dev" }),
          ({ desired }) => desired === "paused"
        );

        yield* pause;

        const still = yield* client.getMachine({ id: "dev" });

        yield* release;

        const paused = yield* Fiber.join(pausing);
        const snap = yield* client.getCheckpoint({ id: "snap" });

        expect([during.phase, during.state]).toStrictEqual([
          "observing",
          "running",
        ]);
        expect([still.phase, still.state]).toStrictEqual([
          "observing",
          "running",
        ]);
        expect([paused.state, paused.phase]).toStrictEqual([
          "paused",
          "settled",
        ]);
        expect(snap).toMatchObject({ phase: "ready", labels: { app: "web" } });
        expect(host.fake.calls).toStrictEqual([
          "capture snap",
          "exec dev",
          "pause dev",
        ]);
      })
  );

  it.effect(
    "a pause whose capture fails still pauses, after the capture, and answers the capture's error",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource();
        const { client, host } = served;

        host.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));

        const error = yield* Effect.flip(
          client.pauseMachine({ id: "dev", capture: { name: "snap" } })
        );

        const dev = yield* client.getMachine({ id: "dev" });
        const row = yield* rested(served, "snap");

        expect(error.message).toBe("ENOTSUP");
        expect([dev.state, dev.phase]).toStrictEqual(["paused", "settled"]);
        expect(row.state).toBe("failed");
        expect(callsTo(host, "capture")).toStrictEqual(["capture snap"]);
        expect(host.fake.calls.indexOf("capture snap")).toBeLessThan(
          host.fake.calls.indexOf("pause dev")
        );
      })
  );

  it.effect(
    "a pause with a capture of a taken name is Conflict, and of a stopped machine WrongState, recording no pause",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        host.fake.calls.length = 0;

        const taken = yield* Effect.flip(
          client.pauseMachine({ id: "dev", capture: { name: "snap" } })
        );

        yield* client.stopMachine({ id: "dev" });

        const stopped = yield* Effect.flip(
          client.pauseMachine({ id: "dev", capture: { name: "late" } })
        );

        const dev = yield* client.getMachine({ id: "dev" });

        expect(taken._tag).toBe("Conflict");
        expect(stopped).toMatchObject({ _tag: "WrongState", state: "stopped" });
        expect(dev.desired).toBe("stopped");
        expect(host.fake.calls).toStrictEqual(["exec dev", "stop dev"]);
        expect(yield* checkpointIds(client)).toStrictEqual(["snap"]);
      })
  );

  it.effect(
    "a pause with a capture pauses after the capture across a restart of the control plane between them",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const first = yield* planned.start();
        const host = firstHost(planned);
        const client = yield* clientOf(first.url);
        const asking = yield* clientOf(first.url, { noWait: true });

        yield* client.create("dev", request("dev"));
        host.fake.calls.length = 0;

        const { entered, release } = host.fake.holdNext("capture");

        yield* asking.pauseMachine({ id: "dev", capture: { name: "snap" } });
        yield* entered;
        yield* first.crash;
        yield* release;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        const again = yield* clientOf(second.url);

        const paused = yield* eventually(
          again.getMachine({ id: "dev" }),
          ({ state, phase }) => state === "paused" && phase === "settled"
        );

        const snap = yield* again.getCheckpoint({ id: "snap" });

        expect(paused.desired).toBe("paused");
        expect(snap.phase).toBe("ready");
        expect(host.fake.calls).toStrictEqual([
          "capture snap",
          "exec dev",
          "pause dev",
        ]);
      })
  );

  it.effect(
    "a capture under way is no checkpoint yet: a restore of it is NotFound and no list shows it",
    () =>
      Effect.gen(function* () {
        const { client, host, machines, checkpoints } = yield* withSource();
        const { release, entered } = host.fake.holdNext("capture");

        yield* checkpoints.capture({ machine: "dev", name: "snap" });
        yield* entered;

        const restoring = yield* Effect.flip(
          machines.restore({ checkpoint: "snap", name: "copy" })
        );

        const listed = yield* checkpointIds(client);
        const got = yield* client.getCheckpoint({ id: "snap" });

        yield* release;
        yield* eventually(checkpointIds(client), (ids) => ids.length === 1);

        expect(restoring._tag).toBe("NotFound");
        expect(listed).toStrictEqual([]);
        expect(got.phase).toBe("capturing");
      })
  );

  it.effect(
    "a delete asked during a capture stands: the capture ends, and the checkpoint goes",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource();
        const { client, host, checkpoints } = served;
        const { release, entered } = host.fake.holdNext("capture");

        yield* checkpoints.capture({ machine: "dev", name: "snap" });
        yield* entered;
        yield* pause;

        const deleting = yield* Effect.forkChild(
          client.deleteCheckpoint({ id: "snap" })
        );

        yield* eventually(
          client.getCheckpoint({ id: "snap" }),
          ({ phase }) => phase === "deleting"
        );
        yield* release;

        expect(yield* Fiber.join(deleting)).toBe("deleted");
        expect(yield* served.store.findCheckpoint("snap")).toStrictEqual(
          Option.none()
        );
        expect(host.fake.calls).toStrictEqual([
          "capture snap",
          "deleteCheckpoint snap",
        ]);
      })
  );

  it.effect(
    "a delete asked during a capture that then fails takes the row with it",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource();
        const { client, host, checkpoints } = served;
        const { release, entered } = host.fake.holdNext("capture");

        yield* checkpoints.capture({ machine: "dev", name: "snap" });
        yield* entered;
        yield* checkpoints.delete("snap");
        host.fake.machines.clear();
        yield* release;

        yield* gone(served, "snap");

        expect(
          (yield* Effect.flip(client.getCheckpoint({ id: "snap" })))._tag
        ).toBe("NotFound");
      })
  );

  it.effect(
    "a capture whose machine's row went before it began ends failed, not waiting on it",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const first = yield* planned.start();
        const client = yield* clientOf(first.url);

        yield* client.create("dev", request("dev"));

        const source = yield* first.checkpoints.capture({
          machine: "dev",
          name: "snap",
        });

        yield* rested(first, "snap");
        yield* first.crash;
        yield* seeded(planned, (store) =>
          Effect.gen(function* () {
            const row = Option.getOrThrow(yield* store.findCheckpoint("snap"));

            yield* store.advance("checkpoint", "snap", () => ({
              next: "removed",
              finish: false,
            }));
            yield* store.insertCheckpoint({
              ...row,
              name: "orphan",
              machine: "gone",
              state: "capturing.due",
              createdAt: yield* DateTime.now,
            });
          })
        ).pipe(Effect.provide(NodeServices.layer));

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        const row = yield* rested(second, "orphan");

        expect(source.machine).toBe("dev");
        expect(row).toMatchObject({
          state: "failed",
          error: { _tag: "NotFound", id: "gone" },
        });
        expect(firstHost(planned).fake.calls).not.toContain("capture orphan");
      })
  );

  it.effect(
    "a capture that begins once its machine has gone ends failed, with no capture on the host",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const first = yield* planned.start();
        const host = firstHost(planned);
        const client = yield* clientOf(first.url);

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        const record = Option.getOrThrow(
          yield* first.store.findCheckpoint("snap")
        );

        yield* first.store.insertCheckpoint({
          ...record,
          name: "late",
          machine: "gone",
          state: "capturing.due",
        });
        yield* first.crash;
        host.fake.calls.length = 0;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        expect(yield* rested(second, "late")).toMatchObject({
          state: "failed",
          error: { _tag: "NotFound", id: "gone" },
        });
        expect(callsTo(host, "capture")).toStrictEqual([]);
      })
  );

  it.effect(
    "a restore makes a machine with the checkpoint's spec, prepared with a new identity, and may take its deleted source's name",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();
        const source = yield* client.getMachine({ id: "dev" });

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* client.deleteMachine({ id: "dev" });
        host.fake.calls.length = 0;

        const restored = yield* client.restoreMachine({
          checkpoint: "snap",
          name: "dev",
        });

        expect(restored).toMatchObject({
          id: "dev",
          state: "running",
          phase: "settled",
          ssh: { host: "127.0.0.1" },
        });
        expect(restored.hostKey).not.toBe(source.hostKey);
        expect(yield* machineId(host, "dev")).toBe("dev\n");
        expect(host.fake.calls).toStrictEqual([
          "admit dev",
          "restore dev",
          "exec dev",
          "exec dev",
        ]);
        expect(yield* checkpointIds(client)).toStrictEqual(["snap"]);
      })
  );

  it.effect(
    "restores of one checkpoint share it, so they run side by side",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        const { release, entered } = host.fake.holdNext("restore");

        const first = yield* Effect.forkChild(
          client.restoreMachine({ checkpoint: "snap", name: "one" })
        );

        yield* entered;

        const second = yield* client.restoreMachine({
          checkpoint: "snap",
          name: "two",
        });

        yield* release;

        const one = yield* Fiber.join(first);

        expect([one.state, second.state]).toStrictEqual(["running", "running"]);
        expect(one.ssh?.port).not.toBe(second.ssh?.port);
      })
  );

  it.effect(
    "a capture of a machine a restore makes, into the checkpoint it reads, can't deadlock: it is refused",
    () =>
      Effect.gen(function* () {
        const { client, host, checkpoints } = yield* withSource();

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        const { release, entered } = host.fake.holdNext("admit");

        const restoring = yield* Effect.forkChild(
          client.restoreMachine({ checkpoint: "snap", name: "restored" })
        );

        yield* entered;

        const early = yield* Effect.flip(
          checkpoints.capture({ machine: "restored", name: "snap" })
        );

        yield* release;

        const restored = yield* Fiber.join(restoring);

        const late = yield* Effect.flip(
          checkpoints.capture({ machine: "restored", name: "snap" })
        );

        expect([restored.id, early._tag, late._tag]).toStrictEqual([
          "restored",
          "NotMade",
          "Conflict",
        ]);
      })
  );

  it.effect(
    "a capture or a fork of a machine being deleted is NotFound, and makes nothing",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource();
        const { client, host, store } = served;
        const { entered, release } = host.fake.holdNext("delete");

        const deleting = yield* Effect.forkChild(
          client.deleteMachine({ id: "dev" })
        );

        yield* entered;

        const refused = [
          yield* Effect.flip(
            client.captureCheckpoint({ machine: "dev", name: "snap" })
          ),
          yield* Effect.flip(
            client.forkMachine({ machine: "dev", name: "copy" })
          ),
        ];

        yield* release;
        yield* Fiber.join(deleting);

        expect(refused.map(({ _tag }) => _tag)).toStrictEqual([
          "NotFound",
          "NotFound",
        ]);
        expect(yield* captured(store)).toStrictEqual([]);
        expect(yield* machineNames(served)).toStrictEqual([]);
      })
  );

  it.effect(
    "a delete of a checkpoint waits for the restore that reads it, which succeeds",
    () =>
      Effect.gen(function* () {
        const { client, host } = yield* withSource();

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        const { release, entered } = host.fake.holdNext("restore");

        const restore = yield* Effect.forkChild(
          client.restoreMachine({ checkpoint: "snap", name: "copy" })
        );

        yield* entered;

        const deleting = yield* Effect.forkChild(
          client.deleteCheckpoint({ id: "snap" })
        );

        yield* pause;

        const beforeRelease = [...host.fake.calls];

        yield* release;

        const copy = yield* Fiber.join(restore);

        yield* Fiber.join(deleting);

        expect(beforeRelease).not.toContain("deleteCheckpoint snap");
        expect(at(copy)).toStrictEqual(["running", "running", "settled"]);
        expect(yield* checkpointIds(client)).toStrictEqual([]);
      })
  );

  it.effect(
    "a restore of no checkpoint is NotFound, and makes no machine",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource();

        const none = yield* Effect.flip(
          served.client.restoreMachine({ checkpoint: "gone", name: "copy" })
        );

        expect(none._tag).toBe("NotFound");
        expect(yield* machineNames(served)).toStrictEqual(["dev"]);
      })
  );

  it.effect(
    "a ram checkpoint restores only under its pin, and writes nothing otherwise",
    () =>
      Effect.gen(function* () {
        const { client, host, store } = yield* withSource();

        const hot = yield* client.captureCheckpoint({
          machine: "dev",
          name: "hot",
        });

        const row = Option.getOrThrow(yield* store.findCheckpoint(hot.id));

        yield* store.insertCheckpoint({ ...row, name: "old", pin: "fake 0" });
        host.fake.calls.length = 0;

        const refused = yield* Effect.flip(
          client.restoreMachine({ checkpoint: "old", name: "copy" })
        );

        expect(refused).toBeInstanceOf(PinMismatch);
        expect(refused.message).toBe(
          "checkpoint old holds RAM state saved under fake 0, and this host runs fake 1; it restores only under the same one"
        );
        expect(callsTo(host, "restore")).toStrictEqual([]);
        expect(host.fake.machines.has("copy")).toBe(false);
      })
  );

  it.effect(
    "a machine whose VM booted under another runtime build is captured or forked only after a stop and a start",
    () =>
      Effect.gen(function* () {
        const { client, host, store } = yield* withSource();

        yield* patched(store, "dev", { pin: "fake 0" });

        const refused = [
          yield* Effect.flip(
            client.captureCheckpoint({ machine: "dev", name: "hot" })
          ),
          yield* Effect.flip(
            client.forkMachine({ machine: "dev", name: "copy" })
          ),
        ];

        expect(
          refused.map(({ _tag, message }) => [_tag, message])
        ).toStrictEqual(
          Array.from({ length: 2 }, () => [
            "PinMismatch",
            "machine dev's VM booted under fake 0, and this host runs fake 1, so a copy of its RAM would restore under the wrong one: stop it and start it again first",
          ])
        );
        expect(callsTo(host, "capture")).toStrictEqual([]);
        expect(callsTo(host, "fork")).toStrictEqual([]);
        expect(callsTo(host, "deleteCheckpoint")).toStrictEqual([]);
        expect(yield* store.findCheckpoint("hot")).toMatchObject({
          value: { state: "failed" },
        });

        yield* client.deleteMachine({ id: "copy" });
        yield* client.deleteCheckpoint({ id: "hot" });
        yield* client.stopMachine({ id: "dev" });
        yield* client.startMachine({ id: "dev" });

        yield* client.captureCheckpoint({ machine: "dev", name: "hot" });
        yield* client.forkMachine({ machine: "dev", name: "copy" });

        expect(yield* checkpointIds(client)).toStrictEqual(["hot"]);
      })
  );

  it.effect(
    "a capture cut short by its host's restart clears what it began, and fails with why",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource({ recheck: Duration.millis(50) });
        const { host, checkpoints } = served;
        const { entered } = host.fake.holdNext("capture");

        yield* checkpoints.capture({ machine: "dev", name: "snap" });
        yield* entered;
        yield* restarted(host);

        const row = yield* rested(served, "snap");

        expect(row).toMatchObject({
          state: "failed",
          error: { _tag: "Internal" },
        });
        expect(row.error?.message).toContain(
          "ended before its host reported it"
        );
        expect(host.fake.calls.at(-1)).toBe("deleteCheckpoint snap");
      })
  );

  it.effect(
    "a capture asked while its host is away waits, and runs when the host is back",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource({ recheck: Duration.millis(50) });
        const { host, checkpoints } = served;
        const { port } = new URL(host.url);

        yield* host.dispose;
        yield* checkpoints.capture({ machine: "dev", name: "snap" });
        yield* pause;

        const again = yield* startHost(host.dir, {
          id: host.id,
          fake: host.fake,
          port: Number(port),
        });

        yield* Effect.addFinalizer(() => again.dispose);

        expect((yield* rested(served, "snap")).state).toBe("ready");
      })
  );

  it.effect(
    "a control plane killed mid-capture finishes the capture when it comes back",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const first = yield* planned.start();
        const host = firstHost(planned);
        const client = yield* clientOf(first.url);

        yield* client.create("dev", request("dev"));

        const { release, entered } = host.fake.holdNext("capture");

        yield* first.checkpoints.capture({ machine: "dev", name: "snap" });
        yield* entered;
        yield* first.crash;
        yield* release;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        expect((yield* rested(second, "snap")).state).toBe("ready");
        expect(callsTo(host, "capture")).toStrictEqual(["capture snap"]);
      })
  );

  it.effect(
    "a capture recorded by a control plane that died before it began runs on the next one",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const first = yield* planned.start();
        const client = yield* clientOf(first.url);

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* first.crash;
        yield* seeded(planned, (store) =>
          Effect.gen(function* () {
            const row = Option.getOrThrow(yield* store.findCheckpoint("snap"));

            yield* store.insertCheckpoint({
              ...row,
              name: "next",
              instance: "cafe0001cafe0001cafe0001cafe0001",
              state: "capturing.due",
            });
          })
        ).pipe(Effect.provide(NodeServices.layer));

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        expect(yield* rested(second, "next")).toMatchObject({ state: "ready" });
      })
  );

  it.effect(
    "a control plane killed mid-delete finishes the delete when it comes back",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const first = yield* planned.start();
        const host = firstHost(planned);
        const client = yield* clientOf(first.url);

        yield* client.create("dev", request("dev"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });

        const { release, entered } = host.fake.holdNext("deleteCheckpoint");

        yield* first.checkpoints.delete("snap");
        yield* entered;
        yield* first.crash;
        yield* release;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);
        yield* gone(second, "snap");

        expect(callsTo(host, "deleteCheckpoint")).toStrictEqual([
          "deleteCheckpoint snap",
        ]);
      })
  );

  it.effect(
    "a checkpoint whose native delete fails answers why, and runs again at the recheck until it goes",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource({ recheck: nearby });
        const { client, host } = served;

        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        host.fake.calls.length = 0;
        host.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "EBUSY" })
        );

        const error = yield* Effect.flip(
          client.deleteCheckpoint({ id: "snap" })
        );

        const unlisted = yield* checkpointIds(client);

        yield* gone(served, "snap");

        expect(error.message).toBe("EBUSY");
        expect(unlisted).toStrictEqual([]);
        expect(host.fake.calls).toStrictEqual([
          "deleteCheckpoint snap",
          "deleteCheckpoint snap",
        ]);
        expect(yield* client.deleteCheckpoint({ id: "snap" })).toBe("absent");
      })
  );

  it.effect(
    "a failed capture's row goes at once with a delete, or at expiry",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource({
          recheck: Duration.millis(50),
          failedRowsLast: Duration.days(1),
        });

        const { client, host, store } = served;

        host.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));
        yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: "snap" })
        );
        yield* rested(served, "snap");
        host.fake.calls.length = 0;

        expect(yield* client.deleteCheckpoint({ id: "snap" })).toBe("deleted");
        expect(host.fake.calls).toStrictEqual([]);

        host.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));
        yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: "aged" })
        );

        const row = yield* rested(served, "aged");

        yield* store.expire(
          DateTime.addDuration(
            row.failedAt ?? DateTime.makeUnsafe(0),
            Duration.seconds(1)
          )
        );

        expect(yield* store.findCheckpoint("aged")).toStrictEqual(
          Option.none()
        );
      })
  );

  it.effect(
    "a capture whose cleanup fails too keeps its own error, and is cleared at the recheck",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource({ recheck: nearby });
        const { client, host } = served;

        host.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));
        host.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "first" })
        );
        host.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "EBUSY" })
        );

        const error = yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: "snap" })
        );

        const row = yield* rested(served, "snap");

        expect(error.message).toBe("ENOTSUP");
        expect(row).toMatchObject({
          state: "failed",
          error: { message: "ENOTSUP" },
        });
        expect(callsTo(host, "deleteCheckpoint").length).toBeGreaterThanOrEqual(
          2
        );
      })
  );

  it.effect(
    "a capture under a name a failure is still clearing is Conflict; once failed, it replaces the row",
    () =>
      Effect.gen(function* () {
        const served = yield* withSource({ recheck: nearby });
        const { client, host, checkpoints } = served;

        host.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));
        host.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "first" })
        );
        host.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "EBUSY" })
        );

        yield* Effect.flip(
          client.captureCheckpoint({ machine: "dev", name: "snap" })
        );

        const clearing = yield* Effect.flip(
          checkpoints.capture({ machine: "dev", name: "snap" })
        );

        yield* rested(served, "snap");

        const again = yield* client.captureCheckpoint({
          machine: "dev",
          name: "snap",
        });

        expect(clearing._tag).toBe("Conflict");
        expect(again).toMatchObject({ id: "snap", phase: "ready" });
        expect(yield* checkpointIds(client)).toStrictEqual(["snap"]);
      })
  );
});
