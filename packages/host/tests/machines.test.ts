import { createServer, type Server } from "node:net";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Capacity,
  Conflict,
  type HostError,
  Internal,
  NotOffered,
  ScriptFailed,
  Superseded,
} from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { exists, operatorKey, read, remove, stat } from "@gjermundgaraba/clankerbox-sdk/testing";
import { loginSetup } from "./fake-runtime.ts";
import { at, eventually, failure, hostOn, pause, request, type TestHost } from "./support.ts";

const ports = { first: 21_100, last: 21_109 };

const host = hostOn(ports);

const rows = (host: TestHost) => host.run(host.store.machines);

const theirs = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITheirKeyForTests clankerbox-theirs";

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

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "create runs setup once, then preparation, and answers once the machine runs as asked",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        const made = yield* linux.run(
          linux.machines.create(request("dev", { setup: installsStart })),
        );

        const root = linux.fake.root("dev") ?? "";

        expect(made).toMatchObject({
          id: "linux_dev",
          kind: "linux",
          base: "ubuntu",
          state: "running",
          desired: "running",
          phase: "settled",
          ssh: { host: "127.0.0.1", port: ports.first },
        });
        expect(made.error).toBeUndefined();
        expect(made.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(yield* read(join(root, "var/lib/clankerbox/machine-id"))).toBe("linux_dev\n");
        expect(yield* read(join(root, "starts"))).toBe("start\n");
        expect(linux.fake.calls).toEqual([
          "startup",
          "admit linux_dev",
          "create linux_dev",
          "exec linux_dev",
          "start linux_dev",
          "exec linux_dev",
        ]);
      }),
  );

  it.effect("a mac host's machine is mac", () =>
    Effect.gen(function* () {
      const mac = yield* host({ kind: "mac" });
      const made = yield* mac.run(mac.machines.create(request("dev", {}, "mac")));

      expect(made).toMatchObject({ id: "mac_dev", kind: "mac" });
    }),
  );

  it.effect("a start of a machine that already runs prepares it again, admitting nothing", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev", { setup: installsStart })));
      linux.fake.calls.length = 0;

      const started = yield* linux.run(linux.machines.start("linux_dev"));

      expect(at(started)).toEqual(["running", "running", "settled"]);
      expect(linux.fake.calls).toEqual(["start linux_dev", "exec linux_dev"]);
      expect(yield* read(join(linux.fake.root("dev") ?? "", "starts"))).toBe("start\nstart\n");
    }),
  );

  it.effect("stop, start and delete run the runtime's calls in turn, start preparing again", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.calls.length = 0;

      const stopped = yield* linux.run(linux.machines.stop("linux_dev"));
      const started = yield* linux.run(linux.machines.start("linux_dev"));

      yield* linux.run(linux.machines.delete("linux_dev"));

      expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
      expect(at(started)).toEqual(["running", "running", "settled"]);
      expect(linux.fake.calls).toEqual([
        "stop linux_dev",
        "admit linux_dev",
        "start linux_dev",
        "exec linux_dev",
        "delete linux_dev",
      ]);
      expect(yield* rows(linux)).toEqual([]);
      expect(linux.fake.machines.size).toBe(0);
    }),
  );

  it.effect("a stop of a machine that is already stopped calls nothing", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));
      linux.fake.calls.length = 0;

      const again = yield* linux.run(linux.machines.stop("linux_dev"));

      expect(at(again)).toEqual(["stopped", "stopped", "settled"]);
      expect(linux.fake.calls).toEqual([]);
    }),
  );

  it.effect("a machine's state is read from the runtime every time", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.machines.clear();

      const [got, listed] = yield* linux.run(
        Effect.all([linux.machines.get("linux_dev"), linux.machines.list]),
      );

      expect(got.state).toBe("missing");
      expect(listed.map(({ id, state }) => [id, state])).toEqual([["linux_dev", "missing"]]);
    }),
  );

  it.effect("a list reads every machine's state in one observe", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("a")));
      yield* linux.run(linux.machines.create(request("b")));
      linux.fake.observed.length = 0;

      const listed = yield* linux.run(linux.machines.list);

      expect(listed.map(({ id, state }) => [id, state])).toEqual([
        ["linux_a", "running"],
        ["linux_b", "running"],
      ]);
      expect(linux.fake.observed).toEqual([["linux_a", "linux_b"]]);
    }),
  );

  it.effect(
    "a read of every machine that fails reads them all unknown, and a list goes on to answer",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));
        linux.fake.failNextObserve(new Internal({ message: "tart list exited 1" }));

        const listed = yield* linux.run(linux.machines.list);

        expect(listed.map(({ id, state }) => [id, state])).toEqual([
          ["linux_a", "unknown"],
          ["linux_b", "unknown"],
        ]);
        expect(listed.map(({ ssh }) => ssh)).toEqual([undefined, undefined]);
        expect((yield* linux.run(linux.machines.get("linux_b"))).state).toBe("running");
      }),
  );

  it.effect(
    "a stop sent while the runtime can't read the machine fails, and the next recheck stops it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ recheck: Duration.millis(200) });

        yield* linux.run(linux.machines.create(request("dev")));
        linux.fake.machines.set("dev", { state: "unknown", root: linux.fake.root("dev") ?? "" });
        linux.fake.calls.length = 0;

        const unread = yield* failure(linux, linux.machines.stop("linux_dev"));
        const whileUnread = [...linux.fake.calls];

        linux.fake.machines.set("dev", { state: "running", root: linux.fake.root("dev") ?? "" });

        const stopped = yield* eventually(
          linux.run(linux.machines.get("linux_dev")),
          (machine) => machine.phase === "settled",
        );

        expect([unread, whileUnread]).toEqual([
          new Internal({
            message:
              "the linux runtime couldn't read machine linux_dev; the host reads it again at its next recheck",
          }),
          [],
        ]);
        expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
        expect(linux.fake.calls).toEqual(["stop linux_dev"]);
      }),
  );

  it.effect(
    "a create whose runtime can't be read after the copy fails though it is made, and a recheck prepares it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ recheck: Duration.millis(200) });
        const { entered, release } = linux.fake.holdNext("exec");

        const creating = yield* Effect.forkChild(
          linux.run(Effect.flip(linux.machines.create(request("dev", { setup: installsStart })))),
        );

        yield* entered;
        linux.fake.failNextObserve(new Internal({ message: "tart list exited 1" }));
        yield* release;

        const unread = yield* Fiber.join(creating);

        const settled = yield* eventually(
          linux.run(linux.machines.get("linux_dev")),
          (machine) => machine.phase === "settled",
        );

        expect(unread._tag).toBe("Internal");
        expect((yield* rows(linux)).map(({ made }) => made)).toEqual([true]);
        expect([at(settled), settled.hostKey === undefined]).toEqual([
          ["running", "running", "settled"],
          false,
        ]);
      }),
  );

  const onTestClock = <A>(use: Effect.Effect<A, HostError>) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(use));
      let waited = Duration.zero;

      while (fiber.pollUnsafe() === undefined) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        waited = Duration.sum(waited, Duration.seconds(1));
      }

      return { result: yield* Fiber.join(fiber), waited: Duration.format(waited) };
    });

  it.effect(
    "a read of runtime state that doesn't answer within 9 s reads every machine unknown",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        linux.fake.hangNextObserve();

        const { result, waited } = yield* onTestClock(linux.machines.get("linux_dev"));

        expect(waited).toBe("9s");
        expect(Result.getOrThrow(result).state).toBe("unknown");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "an admission whose reads don't answer within 9 s fails the start with Internal, which the machine shows",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.stop("linux_dev"));
        linux.fake.calls.length = 0;

        const { release } = linux.fake.holdNext("admit");

        const { result } = yield* onTestClock(
          Effect.flatMap(Effect.result(linux.machines.start("linux_dev")), (started) =>
            Effect.map(linux.machines.get("linux_dev"), (got) => ({ started, got })),
          ),
        );

        yield* release;

        const { started, got } = Result.getOrThrow(result);

        const timedOut = new Internal({
          message:
            "startMachine linux_dev: the linux runtime's admission check didn't answer within 9s",
        });

        expect(started).toEqual(Result.fail(timedOut));
        expect([got.phase, got.error]).toEqual(["failed", timedOut]);
        expect(linux.fake.calls).toEqual(["admit linux_dev"]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a read of runtime state that dies reads unknown, and the machine lives on", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.dieNextObserve();

      const died = yield* linux.run(linux.machines.get("linux_dev"));
      const stopped = yield* linux.run(linux.machines.stop("linux_dev"));

      expect([died.state, at(stopped)]).toEqual(["unknown", ["stopped", "stopped", "settled"]]);
    }),
  );

  it.effect(
    "a step that dies fails with Internal, whose message leaves the cause to the host log",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.stop("linux_dev"));
        linux.fake.dieNext("admit", "admit blew up");

        const error = yield* failure(linux, linux.machines.start("linux_dev"));
        const got = yield* linux.run(linux.machines.get("linux_dev"));

        expect(error).toEqual(
          new Internal({ message: "start linux_dev died; the host log has why" }),
        );
        expect([got.phase, got.error]).toEqual(["failed", error]);
      }),
  );

  it.effect(
    "one machine the runtime can't read is unknown, and the list still reads the rest",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));
        linux.fake.machines.set("a", { state: "unknown", root: linux.fake.root("a") ?? "" });

        const listed = yield* linux.run(linux.machines.list);

        expect(listed.map(({ id, state }) => [id, state])).toEqual([
          ["linux_a", "unknown"],
          ["linux_b", "running"],
        ]);
      }),
  );

  it.effect(
    "a machine has an SSH endpoint, as the runtime's user on its port of the publish address, only while it runs",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        const made = yield* linux.run(linux.machines.create(request("dev")));
        const stopped = yield* linux.run(linux.machines.stop("linux_dev"));

        linux.fake.machines.clear();

        const missing = yield* linux.run(linux.machines.get("linux_dev"));
        const [row] = yield* rows(linux);

        expect(made.ssh).toEqual({ user: "admin", host: "127.0.0.1", port: row?.port });
        expect(made.hostKey).toBeUndefined();
        expect([stopped, missing].map(({ state, ssh }) => [state, ssh])).toEqual([
          ["stopped", undefined],
          ["missing", undefined],
        ]);
      }),
  );

  it.effect("a duplicate name is Conflict, and the runtime is never called", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.calls.length = 0;

      const error = yield* failure(linux, linux.machines.create(request("dev")));

      expect(error).toEqual(new Conflict({ message: "machine linux_dev exists", id: "linux_dev" }));
      expect(linux.fake.calls).toEqual([]);
    }),
  );

  it.effect("a base the host doesn't offer is NotOffered, before anything is written", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const error = yield* failure(
        linux,
        linux.machines.create(request("dev", { base: "fedora" })),
      );

      expect(error).toBeInstanceOf(NotOffered);
      expect(error).toMatchObject({ base: "fedora" });
      expect(error.message).toContain("offers ubuntu");
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect("a create refused at admission leaves nothing behind, and creates nothing", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      linux.fake.failNext("admit", new Capacity({ message: "no room" }));

      const error = yield* failure(linux, linux.machines.create(request("dev")));

      expect(error).toEqual(new Capacity({ message: "no room" }));
      expect(yield* rows(linux)).toEqual([]);
      expect(linux.fake.calls).toEqual(["startup", "admit linux_dev", "delete linux_dev"]);
    }),
  );

  it.effect(
    "a start refused at admission rests failed with the refusal, and the next start tries again",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.stop("linux_dev"));
        linux.fake.failNext("admit", new Capacity({ message: "no room" }));

        const error = yield* failure(linux, linux.machines.start("linux_dev"));
        const got = yield* linux.run(linux.machines.get("linux_dev"));
        const retried = yield* linux.run(linux.machines.start("linux_dev"));

        expect(error).toEqual(new Capacity({ message: "no room" }));
        expect([...at(got), got.error]).toEqual(["stopped", "running", "failed", error]);
        expect([...at(retried), retried.error]).toEqual([
          "running",
          "running",
          "settled",
          undefined,
        ]);
      }),
  );

  it.effect("a create whose native work failed deletes what it left, and answers the failure", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      linux.fake.failNext("create", new Internal({ message: "krun EINVAL" }));

      const error = yield* failure(linux, linux.machines.create(request("dev")));
      const got = yield* failure(linux, linux.machines.get("linux_dev"));

      expect(error).toEqual(new Internal({ message: "krun EINVAL" }));
      expect(got._tag).toBe("NotFound");
      expect(linux.fake.calls).toEqual([
        "startup",
        "admit linux_dev",
        "create linux_dev",
        "delete linux_dev",
      ]);
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect("a create a caller left before it failed is deleted all the same", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const { release, entered } = linux.fake.holdNext("admit");

      linux.fake.failNext("create", new Internal({ message: "krun EINVAL" }));

      const caller = yield* Effect.forkChild(linux.machines.create(request("dev")));

      yield* entered;
      yield* Fiber.interrupt(caller);
      yield* release;

      const left = yield* eventually(rows(linux), (found) => found.length === 0);

      expect(left).toEqual([]);
      expect(linux.fake.calls).toContain("delete linux_dev");
    }),
  );

  it.effect("a restore whose checkpoint was captured again under its name copies nothing", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

      const { release, entered } = linux.fake.holdNext("admit");

      const restoring = yield* Effect.forkChild(
        linux.run(Effect.flip(linux.machines.restore("linux_snap", "copy"))),
      );

      yield* entered;
      yield* linux.run(linux.checkpoints.delete("linux_snap"));
      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));
      yield* release;

      const error = yield* Fiber.join(restoring);

      expect([error._tag, error.message]).toEqual(["NotFound", "no checkpoint linux_snap"]);
      expect(linux.fake.calls).not.toContain("restore linux_copy");
      expect((yield* rows(linux)).map(({ name }) => name)).toEqual(["dev"]);
    }),
  );

  it.effect("a stop and a delete of a made machine are never refused for an earlier failure", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));
      linux.fake.failNext("start", new Internal({ message: "crun create failed" }));
      yield* failure(linux, linux.machines.start("linux_dev"));

      const stopped = yield* linux.run(linux.machines.stop("linux_dev"));

      linux.fake.failNext("stop", new Internal({ message: "guest didn't flush" }));
      linux.fake.machines.forEach((machine) => {
        machine.state = "running";
      });

      const stopFailed = yield* failure(linux, linux.machines.stop("linux_dev"));

      yield* linux.run(linux.machines.delete("linux_dev"));

      expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
      expect(stopFailed.message).toBe("guest didn't flush");
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect("delete of a machine that doesn't exist is NotFound", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const error = yield* failure(linux, linux.machines.delete("linux_gone"));

      expect(error._tag).toBe("NotFound");
    }),
  );

  it.effect("an ID for another host is Invalid", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const error = yield* failure(linux, linux.machines.get("mac_dev"));

      expect(error._tag).toBe("Invalid");
      expect(error.message).toContain("this is host linux");
    }),
  );

  it.effect(
    "a made machine the runtime no longer has is lost: a start is Missing, a delete removes it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.stop("linux_dev"));
        linux.fake.machines.clear();
        linux.fake.calls.length = 0;

        const error = yield* failure(linux, linux.machines.start("linux_dev"));
        const got = yield* linux.run(linux.machines.get("linux_dev"));

        yield* linux.run(linux.machines.delete("linux_dev"));

        expect([error._tag, error.message]).toEqual([
          "Missing",
          "machine linux_dev is missing from the linux runtime; delete it",
        ]);
        expect(at(got)).toEqual(["missing", "running", "lost"]);
        expect(linux.fake.calls).toEqual(["delete linux_dev"]);
      }),
  );

  it.effect("a stop sent while a start boots cuts the start short: the start is Superseded", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));

      const { entered, release } = linux.fake.holdNext("start");

      const starting = yield* Effect.forkChild(
        linux.run(Effect.flip(linux.machines.start("linux_dev"))),
      );

      yield* entered;

      const stopped = yield* linux.run(linux.machines.stop("linux_dev"));
      const start = yield* Fiber.join(starting);

      yield* release;

      expect(start).toEqual(
        new Superseded({
          message: "a later request asked machine linux_dev to be stopped before it got to running",
          by: "stopped",
        }),
      );
      expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
    }),
  );

  const pausedPins = (host: TestHost) =>
    Effect.map(rows(host), (intents) => intents.map(({ pausedPin }) => pausedPin));

  it.effect(
    "a pause keeps the runtime's pin until a start resumes the machine and prepares it again",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        linux.fake.calls.length = 0;

        const paused = yield* linux.run(linux.machines.pause("linux_dev"));
        const pinned = yield* pausedPins(linux);
        const started = yield* linux.run(linux.machines.start("linux_dev"));

        expect(at(paused)).toEqual(["paused", "paused", "settled"]);
        expect(pinned).toEqual(["fake 1"]);
        expect(at(started)).toEqual(["running", "running", "settled"]);
        expect(yield* pausedPins(linux)).toEqual([undefined]);
        expect(linux.fake.calls).toEqual([
          "pause linux_dev",
          "admit linux_dev",
          "start linux_dev",
          "exec linux_dev",
        ]);
      }),
  );

  it.effect("a pause of a stopped machine leaves it stopped, and calls no runtime", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));
      linux.fake.calls.length = 0;

      const paused = yield* linux.run(linux.machines.pause("linux_dev"));

      expect(at(paused)).toEqual(["stopped", "paused", "settled"]);
      expect(yield* pausedPins(linux)).toEqual([undefined]);
      expect(linux.fake.calls).toEqual([]);
    }),
  );

  it.effect(
    "a machine paused under another runtime build is PinMismatch to a start or a stop, and never resumed",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.pause("linux_dev"));
        yield* linux.run(linux.store.pausedUnder("dev", "fake 0"));
        linux.fake.calls.length = 0;

        const errors = [
          yield* failure(linux, linux.machines.start("linux_dev")),
          yield* failure(linux, linux.machines.stop("linux_dev")),
        ];

        expect(errors.map((error) => [error._tag, error.message])).toEqual(
          Array.from({ length: 2 }, () => [
            "PinMismatch",
            "machine linux_dev was paused under fake 0, and this host runs fake 1; it resumes only under the same one: delete it, or resume it under that one",
          ]),
        );
        expect(linux.fake.calls).toEqual([]);
        expect(yield* pausedPins(linux)).toEqual(["fake 0"]);
      }),
  );

  it.effect(
    "a stop of a paused machine boots it through admission, as a stop, and drops its pin",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.pause("linux_dev"));
        linux.fake.calls.length = 0;

        const stopped = yield* linux.run(linux.machines.stop("linux_dev"));
        const [activation] = linux.fake.activations.slice(-1);

        expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
        expect(activation?.action).toBe("stopMachine");
        expect(linux.fake.calls).toEqual(["admit linux_dev", "stop linux_dev"]);
        expect(yield* pausedPins(linux)).toEqual([undefined]);
      }),
  );

  it.effect(
    "on a runtime whose stop discards a pause, a stop of a paused machine admits nothing and needs no pin",
    () =>
      Effect.gen(function* () {
        const mac = yield* host({ kind: "mac" });

        yield* mac.run(mac.machines.create(request("dev", {}, "mac")));
        yield* mac.run(mac.machines.pause("mac_dev"));
        yield* mac.run(mac.store.pausedUnder("dev", "fake 0"));
        mac.fake.calls.length = 0;

        const stopped = yield* mac.run(mac.machines.stop("mac_dev"));

        expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
        expect(mac.fake.calls).toEqual(["stop mac_dev"]);
        expect(yield* pausedPins(mac)).toEqual([undefined]);
      }),
  );

  it.effect("two starts at once both answer with the running machine", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));
      linux.fake.calls.length = 0;

      const started = yield* linux.run(
        Effect.all([linux.machines.start("linux_dev"), linux.machines.start("linux_dev")], {
          concurrency: "unbounded",
        }),
      );

      expect(started.map(at)).toEqual([
        ["running", "running", "settled"],
        ["running", "running", "settled"],
      ]);
      expect(linux.fake.calls).toEqual(["admit linux_dev", "start linux_dev", "exec linux_dev"]);
    }),
  );

  it.effect("a delete sent while a create runs cuts it short, and the create is Superseded", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const { entered } = linux.fake.holdNext("create");

      const creating = yield* Effect.forkChild(
        linux.run(Effect.flip(linux.machines.create(request("dev")))),
      );

      yield* entered;

      const held = yield* linux.run(linux.machines.get("linux_dev"));

      yield* linux.run(linux.machines.delete("linux_dev"));

      expect([held.desired, held.phase]).toEqual(["running", "creating"]);
      expect((yield* Fiber.join(creating))._tag).toBe("Superseded");
      expect(linux.fake.calls).toEqual([
        "startup",
        "admit linux_dev",
        "create linux_dev",
        "delete linux_dev",
      ]);
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect("a delete sent while a create's setup runs cuts the setup short and deletes it", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const { entered } = linux.fake.holdNext("exec");

      const creating = yield* Effect.forkChild(
        linux.run(Effect.flip(linux.machines.create(request("dev", { setup: installsStart })))),
      );

      yield* entered;
      yield* linux.run(linux.machines.delete("linux_dev"));

      expect((yield* Fiber.join(creating))._tag).toBe("Superseded");
      expect(linux.fake.calls.slice(-2)).toEqual(["exec linux_dev", "delete linux_dev"]);
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect(
    "a stop sent while a start boots reads the machine only once the start's native work ends",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.stop("linux_dev"));

        const { entered, release } = linux.fake.holdNext("start", { runsOn: true });

        const starting = yield* Effect.forkChild(
          linux.run(Effect.flip(linux.machines.start("linux_dev"))),
        );

        yield* entered;

        const stopping = yield* Effect.forkChild(linux.run(linux.machines.stop("linux_dev")));

        yield* eventually(
          linux.run(linux.machines.get("linux_dev")),
          (machine) => machine.desired === "stopped",
        );
        yield* release;

        const stopped = yield* Fiber.join(stopping);

        expect((yield* Fiber.join(starting))._tag).toBe("Superseded");
        expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
        expect(linux.fake.machines.get("dev")?.state).toBe("stopped");
        expect(linux.fake.calls.slice(-2)).toEqual(["start linux_dev", "stop linux_dev"]);
      }),
  );

  it.effect("a start sent to a machine being deleted is Superseded at once, booting nothing", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.calls.length = 0;

      const { entered, release } = linux.fake.holdNext("delete");
      const deleting = yield* Effect.forkChild(linux.run(linux.machines.delete("linux_dev")));

      yield* entered;

      const refused = yield* failure(linux, linux.machines.start("linux_dev"));

      yield* release;
      yield* Fiber.join(deleting);

      expect(refused).toEqual(
        new Superseded({ message: "machine linux_dev is being deleted", by: "deleted" }),
      );
      expect(linux.fake.calls.filter((call) => call.startsWith("start "))).toEqual([]);
    }),
  );

  it.effect("the next host finishes a delete the last one's end cut off", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));

      const { entered } = linux.fake.holdNext("delete");

      yield* Effect.forkChild(linux.run(linux.machines.delete("linux_dev")));
      yield* entered;
      yield* linux.dispose;
      linux.fake.calls.length = 0;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

      yield* eventually(rows(restarted), (left) => left.length === 0);

      expect(yield* rows(restarted)).toEqual([]);
      expect(linux.fake.calls).toEqual(["startup", "delete linux_dev"]);
    }),
  );

  it.effect(
    "a host that starts reads every machine in one read, then starts each running one",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.create(request("other")));
        yield* linux.run(linux.machines.stop("linux_other"));
        yield* linux.dispose;
        linux.fake.calls.length = 0;
        linux.fake.observed.length = 0;

        const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

        yield* eventually(restarted.run(restarted.machines.list), (machines) =>
          machines.every(({ phase }) => phase === "settled"),
        );

        expect(linux.fake.observed[0]).toEqual(["linux_dev", "linux_other"]);
        expect(linux.fake.calls.filter((call) => !call.startsWith("exec "))).toEqual([
          "startup",
          "start linux_dev",
        ]);
      }),
  );

  it.effect("a caller that goes away doesn't interrupt the work, which carries on to rest", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const { release, entered } = linux.fake.holdNext("create");
      const caller = yield* Effect.forkChild(linux.machines.create(request("dev")));

      yield* entered;
      yield* Fiber.interrupt(caller);
      yield* release;

      const settled = yield* eventually(
        linux.run(linux.machines.get("linux_dev")),
        (machine) => machine.phase === "settled",
      );

      expect(at(settled)).toEqual(["running", "running", "settled"]);
      expect(linux.fake.calls).toContain("exec linux_dev");
    }),
  );

  it.effect(
    "a create the last host's end cut off is deleted by the next host, with what it left",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const { entered } = linux.fake.holdNext("create");

        yield* Effect.forkChild(linux.machines.create(request("dev")));
        yield* entered;
        yield* linux.dispose;
        linux.fake.calls.length = 0;

        const restarted = yield* host({ fake: linux.fake, dir: linux.dir });
        const left = yield* eventually(rows(restarted), (found) => found.length === 0);

        expect(left).toEqual([]);
        expect(linux.fake.calls).toEqual(["startup", "delete linux_dev"]);
      }),
  );

  it.effect("a start the last host's end cut off is finished by the next host", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));

      const { entered } = linux.fake.holdNext("admit");

      yield* Effect.forkChild(linux.machines.start("linux_dev"));
      yield* entered;
      yield* linux.dispose;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

      const settled = yield* eventually(
        restarted.run(restarted.machines.get("linux_dev")),
        (machine) => machine.phase === "settled",
      );

      expect(at(settled)).toEqual(["running", "running", "settled"]);
    }),
  );

  it.effect(
    "a setup's authorized keys go to the login user once it exits 0, in the same exec, beside the keys already there",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const keys = join("home", "admin", ".ssh", "authorized_keys");

        yield* linux.run(
          linux.machines.create(
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
            }),
          ),
        );
        yield* linux.run(
          linux.machines.create(
            request("fresh", {
              setup: { script: `#!/bin/sh\n${loginSetup}`, authorizedKeys: operatorKey },
            }),
          ),
        );

        const fresh = join(linux.fake.root("fresh") ?? "", keys);

        expect(yield* read(join(linux.fake.root("dev") ?? "", keys))).toBe(
          `${theirs}\n${operatorKey}\n\n`,
        );
        expect(linux.fake.calls.filter((call) => call === "exec linux_dev")).toHaveLength(2);
        expect(yield* read(fresh)).toBe(`\n${operatorKey}\n`);
        expect((yield* stat(fresh)).mode & 0o777).toBe(0o600);
      }),
  );

  it.effect(
    "a setup with authorized keys that leaves no login user fails, and deletes the machine",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        const error = yield* failure(
          linux,
          linux.machines.create(
            request("dev", {
              setup: { script: "#!/bin/sh\ntrue\n", authorizedKeys: operatorKey },
            }),
          ),
        );

        expect(error._tag).toBe("ScriptFailed");
        expect(error).toMatchObject({ script: "setup" });
        expect(error.message).toContain("sudo: unknown user admin");
        expect(error.message).toContain(
          "couldn't install the authorized keys for admin: setup must leave that user, and sudo",
        );
        expect(yield* rows(linux)).toEqual([]);
      }),
  );

  it.effect("a setup with no authorized keys installs none, so it needs no login user", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev", { setup: installsStart })));

      expect(yield* exists(join(linux.fake.root("dev") ?? "", "home"))).toBe(false);
    }),
  );

  it.effect("a setup that fails deletes the machine, VM and all", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const error = yield* failure(
        linux,
        linux.machines.create(
          request("dev", { setup: { script: "#!/bin/sh\nexit 3\n", timeoutSeconds: 30 } }),
        ),
      );

      const got = yield* failure(linux, linux.machines.get("linux_dev"));

      expect([error._tag, got._tag]).toEqual(["ScriptFailed", "NotFound"]);
      expect(linux.fake.calls.slice(-2)).toEqual(["exec linux_dev", "delete linux_dev"]);
      expect(linux.fake.machines.size).toBe(0);
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect(
    "a setup that fails answers its failure though the delete after it fails, and the next recheck deletes the machine",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ recheck: Duration.millis(200) });

        linux.fake.failNext("delete", new Internal({ message: "krun busy" }));

        const error = yield* failure(
          linux,
          linux.machines.create(
            request("dev", { setup: { script: "#!/bin/sh\nexit 3\n", timeoutSeconds: 30 } }),
          ),
        );

        const left = yield* linux.run(linux.machines.get("linux_dev"));

        expect(error._tag).toBe("ScriptFailed");
        expect([left.desired, left.phase, left.error?._tag]).toEqual([
          "deleted",
          "failed",
          "Internal",
        ]);

        yield* eventually(rows(linux), (intents) => intents.length === 0);

        expect(linux.fake.machines.size).toBe(0);
      }),
  );

  it.effect(
    "a fork of a machine whose setup still runs is NotMade, and a stop waits for the setup, then stops it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const { release, entered } = linux.fake.holdNext("exec");

        const creating = yield* Effect.forkChild(
          linux.run(
            Effect.flip(
              linux.machines.create(
                request("dev", { setup: { script: "#!/bin/sh\n", timeoutSeconds: 30 } }),
              ),
            ),
          ),
        );

        yield* entered;

        const refused = yield* failure(linux, linux.machines.fork("linux_dev", "copy"));
        const stopping = yield* Effect.forkChild(linux.run(linux.machines.stop("linux_dev")));

        yield* eventually(
          linux.run(linux.machines.get("linux_dev")),
          (machine) => machine.desired === "stopped",
        );
        yield* release;

        const [superseded, stopped] = yield* Effect.all([
          Fiber.join(creating),
          Fiber.join(stopping),
        ]);

        expect([refused._tag, refused.message]).toEqual([
          "NotMade",
          "machine linux_dev isn't made yet: its create or setup still runs",
        ]);
        expect(superseded).toEqual(
          new Superseded({
            message:
              "a later request asked machine linux_dev to be stopped before it got to running",
            by: "stopped",
          }),
        );
        expect(at(stopped)).toEqual(["stopped", "stopped", "settled"]);
        expect((yield* rows(linux)).map(({ made }) => made)).toEqual([true]);
      }),
  );

  it.effect("a create whose setup the last host's end cut off is deleted by the next host", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const { entered } = linux.fake.holdNext("exec");

      yield* Effect.forkChild(
        linux.machines.create(
          request("dev", { setup: { script: "#!/bin/sh\n", timeoutSeconds: 30 } }),
        ),
      );
      yield* entered;
      yield* linux.dispose;
      linux.fake.calls.length = 0;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });
      const left = yield* eventually(rows(restarted), (found) => found.length === 0);

      expect(left).toEqual([]);
      expect(linux.fake.calls).toEqual(["startup", "delete linux_dev"]);
    }),
  );

  it.effect("a create, fork or restore that succeeds makes its machine, setup and all", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev", { setup: installsStart })));
      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));
      yield* linux.run(linux.machines.fork("linux_dev", "forked"));
      yield* linux.run(linux.machines.restore("linux_snap", "restored"));

      expect((yield* rows(linux)).map(({ name, made }) => [name, made])).toEqual([
        ["dev", true],
        ["forked", true],
        ["restored", true],
      ]);
    }),
  );

  it.effect(
    "a create that fails only in preparation leaves its machine made, and a start prepares it again",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        linux.fake.failNext("exec", new Internal({ message: "sshd didn't start" }));

        const error = yield* failure(linux, linux.machines.create(request("dev")));
        const [row] = yield* rows(linux);

        linux.fake.calls.length = 0;

        const started = yield* linux.run(linux.machines.start("linux_dev"));

        expect(error).toEqual(new Internal({ message: "sshd didn't start" }));
        expect(row?.made).toBe(true);
        expect(at(started)).toEqual(["running", "running", "settled"]);
        expect(linux.fake.calls).toEqual(["start linux_dev", "exec linux_dev"]);
      }),
  );

  it.effect("the next host finishes a preparation the last one's end cut off", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const { entered } = linux.fake.holdNext("exec");

      yield* Effect.forkChild(linux.machines.create(request("dev")));
      yield* entered;
      yield* linux.dispose;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

      const settled = yield* eventually(
        restarted.run(restarted.machines.get("linux_dev")),
        (machine) => machine.phase === "settled",
      );

      const [row] = yield* rows(restarted);

      expect(at(settled)).toEqual(["running", "running", "settled"]);
      expect(row?.made).toBe(true);
    }),
  );

  const marker = "setup-text-marker";

  it.effect("a failing setup fails the create with its last lines of output, never its text", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const script = [
        "#!/bin/sh",
        `# ${marker}`,
        "i=0",
        "while [ $i -lt 30 ]; do echo line $i; i=$((i+1)); done",
        "echo broke >&2",
        "exit 3",
      ].join("\n");

      const error = yield* failure(
        linux,
        linux.machines.create(request("dev", { setup: { script, timeoutSeconds: 30 } })),
      );

      const got = yield* failure(linux, linux.machines.get("linux_dev"));

      expect(error).toBeInstanceOf(ScriptFailed);
      expect(error).toMatchObject({ script: "setup" });
      expect(error.message).toContain("setup exited 3");
      expect(error.message).toContain("line 29\nbroke");
      expect(error.message).not.toContain("line 10\n");
      expect(error.message.includes(marker)).toBe(false);
      expect(got._tag).toBe("NotFound");
    }),
  );

  it.effect("a setup that exits removes its file", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const script = `#!/bin/sh\necho "running as $0"\nexit 3\n`;

      const error = yield* failure(
        linux,
        linux.machines.create(request("dev", { setup: { script, timeoutSeconds: 30 } })),
      );

      const file = /running as (\S+)/u.exec(error.message)?.[1] ?? "";

      expect(file).toMatch(/^\/var\/tmp\/clankerbox-setup\./u);
      expect(yield* exists(file)).toBe(false);
    }),
  );

  it.effect("create accepts a setup that names no timeout", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const made = yield* linux.run(
        linux.machines.create(request("dev", { setup: { script: installsStart.script } })),
      );

      expect(made.phase).toBe("settled");
    }),
  );

  it.effect("a setup that runs past its timeout fails the create with the output so far", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const script = `#!/bin/sh\n# ${marker}\necho "running as $0"\nsleep 30\n`;

      const error = yield* failure(
        linux,
        linux.machines.create(request("dev", { setup: { script, timeoutSeconds: 1 } })),
      );

      const file = /running as (\S+)/u.exec(error.message)?.[1] ?? "";

      expect(file).toMatch(/^\/var\/tmp\/clankerbox-setup\./u);

      yield* remove(file);

      expect(error).toBeInstanceOf(ScriptFailed);
      expect(error).toMatchObject({ script: "setup" });
      expect(error.message).toContain("setup ran past its 1s timeout");
      expect(error.message.includes(marker)).toBe(false);
    }),
  );

  it.effect(
    "the next recheck reads every settled machine in one read, and starts those that stopped under them",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({
          recheck: Duration.millis(200),
        });

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.create(request("other")));
        linux.fake.calls.length = 0;
        linux.fake.observed.length = 0;
        linux.fake.machines.forEach((machine) => {
          machine.state = "stopped";
        });

        yield* eventually(
          Effect.sync(() => [...linux.fake.calls]),
          (calls) => calls.length >= 6,
        );

        expect(linux.fake.observed[0]).toEqual(["linux_dev", "linux_other"]);
        expect(linux.fake.calls.toSorted()).toEqual([
          "admit linux_dev",
          "admit linux_other",
          "exec linux_dev",
          "exec linux_other",
          "start linux_dev",
          "start linux_other",
        ]);
      }),
  );

  it.effect(
    "a recheck's reading of a machine that a step changed while it read is dropped, not acted on",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ recheck: Duration.millis(200) });

        yield* linux.run(linux.machines.create(request("dev")));

        const { entered, release } = linux.fake.holdNextObserve();

        yield* entered;
        yield* linux.run(linux.machines.stop("linux_dev"));
        linux.fake.calls.length = 0;

        const reads = linux.fake.observed.length;

        yield* release;
        yield* eventually(
          Effect.sync(() => linux.fake.observed.length),
          (count) => count > reads,
        );

        const got = yield* linux.run(linux.machines.get("linux_dev"));

        expect(linux.fake.calls).toEqual([]);
        expect(at(got)).toEqual(["stopped", "stopped", "settled"]);
      }),
  );

  it.effect(
    "the RAM budget counts running machines and refuses with Capacity, a create leaving nothing behind",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ runtime: { ramBudgetMib: 2048 } });

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));

        const full = yield* failure(linux, linux.machines.create(request("c")));
        const before = (yield* rows(linux)).map(({ name }) => name);

        yield* linux.run(linux.machines.stop("linux_a"));
        yield* linux.run(linux.machines.create(request("c")));

        const restart = yield* failure(linux, linux.machines.start("linux_a"));

        expect(full._tag).toBe("Capacity");
        expect(full.message).toContain("needs 1G of RAM, and none of the host's 2G budget is free");
        expect(before).toEqual(["a", "b"]);
        expect(restart._tag).toBe("Capacity");
        expect((yield* rows(linux)).map(({ name }) => name).sort()).toEqual(["a", "b", "c"]);
      }),
  );

  it.effect("a create a delete cuts short after admission is no longer counted as booting", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { ramBudgetMib: 4096 } });
      const { entered } = linux.fake.holdNext("create");

      const creating = yield* Effect.forkChild(
        linux.run(Effect.flip(linux.machines.create(request("c", { ramMib: 2048 })))),
      );

      yield* entered;
      yield* linux.run(linux.machines.delete("linux_c"));
      yield* Fiber.join(creating);

      expect(yield* linux.run(linux.machines.capacity)).toEqual([
        { host: "linux", resource: "cpu", used: 0 },
        { host: "linux", resource: "ramMib", limit: 4096, used: 0 },
      ]);
    }),
  );

  it.effect("a delete that fails is tried again at each recheck until it succeeds", () =>
    Effect.gen(function* () {
      const linux = yield* host({
        recheck: Duration.millis(200),
      });

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.failNext("delete", new Internal({ message: "EBUSY" }));
      linux.fake.calls.length = 0;

      const refused = yield* failure(linux, linux.machines.delete("linux_dev"));

      yield* eventually(rows(linux), (left) => left.length === 0);

      expect(refused).toEqual(new Internal({ message: "EBUSY" }));
      expect(yield* rows(linux)).toEqual([]);
      expect(linux.fake.calls.filter((call) => call.startsWith("delete"))).toEqual([
        "delete linux_dev",
        "delete linux_dev",
      ]);
    }),
  );

  it.effect(
    "the host's capacity counts running machines and one a step is booting, for cpu too",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ runtime: { ramBudgetMib: 4096 } });

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));
        yield* linux.run(linux.machines.stop("linux_a"));

        const idle = yield* linux.run(linux.machines.capacity);

        const { entered, release } = linux.fake.holdNext("create");

        const creating = yield* Effect.forkChild(
          linux.run(linux.machines.create(request("c", { ramMib: 2048 }))),
        );

        yield* entered;

        const booting = yield* linux.run(linux.machines.capacity);
        const full = yield* failure(linux, linux.machines.create(request("d", { ramMib: 2048 })));

        yield* release;
        yield* Fiber.join(creating);

        expect(idle).toEqual([
          { host: "linux", resource: "cpu", used: 1 },
          { host: "linux", resource: "ramMib", limit: 4096, used: 1024 },
        ]);
        expect(booting).toEqual([
          { host: "linux", resource: "cpu", used: 2 },
          { host: "linux", resource: "ramMib", limit: 4096, used: 3072 },
        ]);
        expect(full._tag).toBe("Capacity");
        expect(full.message).toContain("needs 2G of RAM, and 1G of the host's 4G budget is free");
      }),
  );

  it.effect("a capacity read that fails, or doesn't answer within 9 s, fails with Internal", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { ramBudgetMib: 4096 } });

      linux.fake.failNext("capacity", new Internal({ message: "tart list exited 1" }));

      const failed = yield* failure(linux, linux.machines.capacity);
      const { release } = linux.fake.holdNext("capacity");
      const { result, waited } = yield* onTestClock(linux.machines.capacity);

      yield* release;

      expect([failed._tag, failed.message]).toEqual(["Internal", "tart list exited 1"]);
      expect(waited).toBe("9s");
      expect(Result.isFailure(result) && [result.failure._tag, result.failure.message]).toEqual([
        "Internal",
        "the linux runtime didn't answer within 9s",
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("the RAM budget counts a machine the runtime can't read as running", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { ramBudgetMib: 2048 } });

      yield* linux.run(linux.machines.create(request("a")));
      linux.fake.machines.set("a", { state: "unknown", root: linux.fake.root("a") ?? "" });

      const full = yield* failure(linux, linux.machines.create(request("c", { ramMib: 2048 })));

      expect(full._tag).toBe("Capacity");
      expect(full.message).toContain("needs 2G of RAM, and 1G of the host's 2G budget is free");
    }),
  );

  it.effect(
    "admission counts the machine it boots, and reads the machines no step boots in one observe",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ runtime: { ramBudgetMib: 4096 } });

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));
        yield* linux.run(linux.machines.stop("linux_b"));

        const { release, entered } = linux.fake.holdNext("start");
        const start = yield* Effect.forkChild(linux.machines.start("linux_b"));

        yield* entered;

        const [activation] = linux.fake.activations.slice(-1);
        const read = linux.fake.observed.at(-1);

        yield* release;
        yield* Fiber.join(start);

        expect(read).toEqual(["linux_a"]);
        expect(activation?.machines.map(({ machine, booting }) => [machine.id, booting])).toEqual([
          ["linux_a", false],
          ["linux_b", true],
        ]);
      }),
  );

  const together = <A>(actions: ReadonlyArray<Effect.Effect<A, HostError>>) =>
    Effect.forEach(actions, (action) => Effect.forkChild(Effect.result(action)));

  const results = <A>(fibers: ReadonlyArray<Fiber.Fiber<Result.Result<A, HostError>>>) =>
    Effect.forEach(fibers, Fiber.join);

  it.effect("of two concurrent creates that each fit only alone, exactly one passes", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { ramBudgetMib: 1536 } });
      const { release, entered } = linux.fake.holdNext("admit");

      const creates = yield* together([
        linux.machines.create(request("x")),
        linux.machines.create(request("y")),
      ]);

      yield* entered;
      yield* pause;

      const admitsWhileHeld = linux.fake.calls.filter((call) => call.startsWith("admit")).length;

      yield* release;

      const ended = yield* results(creates);
      const refused = ended.filter(Result.isFailure).map(({ failure }) => failure._tag);

      expect(admitsWhileHeld).toBe(1);
      expect(ended.filter(Result.isSuccess)).toHaveLength(1);
      expect(refused).toEqual(["Capacity"]);
      expect(yield* rows(linux)).toHaveLength(1);
    }),
  );

  it.effect("of two concurrent starts that each fit only alone, exactly one passes", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { ramBudgetMib: 1536 } });

      yield* linux.run(linux.machines.create(request("x")));
      yield* linux.run(linux.machines.stop("linux_x"));
      yield* linux.run(linux.machines.create(request("y")));
      yield* linux.run(linux.machines.stop("linux_y"));

      const { release, entered } = linux.fake.holdNext("admit");
      linux.fake.calls.length = 0;

      const starts = yield* together([
        linux.machines.start("linux_x"),
        linux.machines.start("linux_y"),
      ]);

      yield* entered;
      yield* pause;

      const admitsWhileHeld = linux.fake.calls.filter((call) => call.startsWith("admit")).length;

      yield* release;

      const ended = yield* results(starts);
      const refused = ended.filter(Result.isFailure).map(({ failure }) => failure._tag);

      expect(admitsWhileHeld).toBe(1);
      expect(ended.filter(Result.isSuccess)).toHaveLength(1);
      expect(refused).toEqual(["Capacity"]);
    }),
  );

  it.effect(
    "ports skip one that something else listens on, and concurrent creates get distinct ones",
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const server = createServer();

            server.listen({ host: "127.0.0.1", port: ports.first, exclusive: true }, () =>
              resume(Effect.succeed(server)),
            );
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
            }),
        );

        const linux = yield* host();

        const made = yield* linux.run(
          Effect.all(
            ["a", "b", "c"].map((name) => linux.machines.create(request(name))),
            { concurrency: "unbounded" },
          ),
        );

        const taken = made.map(({ ssh }) => ssh?.port ?? 0).sort((a, b) => a - b);

        expect(taken).toEqual([ports.first + 1, ports.first + 2, ports.first + 3]);
      }),
  );

  it.effect(
    "a host whose ports are all taken refuses a create with Capacity, writing nothing",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ ports: { first: ports.first, last: ports.first + 1 } });

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));

        const full = yield* failure(linux, linux.machines.create(request("c")));

        expect(full._tag).toBe("Capacity");
        expect(full.message).toBe(`no free port in ${ports.first}-${ports.first + 1} on 127.0.0.1`);
        expect(yield* rows(linux)).toHaveLength(2);
      }),
  );
});
