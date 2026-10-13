import { createServer, type Server } from "node:net";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Capacity, Conflict, type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Machines from "../src/machines.ts";
import * as BindProbe from "../src/platform/bind-probe.ts";
import { Refusal } from "../src/runtime.ts";
import * as Store from "../src/store.ts";
import { exists, read, remove, scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { hostConfig, request, startHost, type TestHost } from "./support.ts";

/** No other test file's host gives out these ports. */
const ports = { first: 21_100, last: 21_109 };

const host = (options?: Parameters<typeof startHost>[1] & { readonly dir?: string }) =>
  Effect.gen(function* () {
    return yield* startHost(options?.dir ?? (yield* scratch), { ports, ...options });
  });

const failure = <A, E>(host: TestHost, effect: Effect.Effect<A, E>) =>
  host.run(Effect.flip(effect));

const rows = (host: TestHost) => host.run(host.store.list);

const pause = Effect.sleep(Duration.millis(50));

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

// Setups and timeouts run on the real clock, as on a host; `onTestClock` moves its own.
layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "create runs setup once, then preparation, and reports the machine as the runtime sees it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        const made = yield* linux.run(
          linux.machines.create(request("dev", { setup: installsStart })),
        );

        const root = linux.fake.root("dev") ?? "";

        expect(made).toMatchObject({
          id: "linux_dev",
          runtime: "smolvm",
          base: "ubuntu",
          state: "running",
          action: { name: "create", status: "done" },
          ssh: { host: "127.0.0.1", port: ports.first },
        });
        expect(made.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(yield* read(join(root, "var/lib/clankerbox/machine-id"))).toBe("linux_dev\n");
        expect(yield* read(join(root, "starts"))).toBe("start\n");
        expect(linux.fake.calls).toEqual([
          "startup",
          "admit linux_dev",
          "create linux_dev",
          "exec linux_dev",
          "exec linux_dev",
        ]);
      }),
  );

  it.effect(
    "start on a running machine is admitted, calls the runtime's start and runs preparation again; setup never runs again",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev", { setup: installsStart })));
        linux.fake.calls.length = 0;

        const started = yield* linux.run(linux.machines.start("linux_dev"));

        expect(started).toMatchObject({
          state: "running",
          action: { name: "start", status: "done" },
        });
        expect(linux.fake.calls).toEqual(["admit linux_dev", "start linux_dev", "exec linux_dev"]);
        expect(yield* read(join(linux.fake.root("dev") ?? "", "starts"))).toBe("start\nstart\n");
      }),
  );

  it.effect("stop, start and delete run the runtime's calls in turn", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.calls.length = 0;

      const stopped = yield* linux.run(linux.machines.stop("linux_dev"));
      const started = yield* linux.run(linux.machines.start("linux_dev"));

      yield* linux.run(linux.machines.delete("linux_dev"));

      expect(stopped).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
      expect(started).toMatchObject({
        state: "running",
        action: { name: "start", status: "done" },
      });
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

  it.effect("stop on a stopped machine calls the runtime's stop, which leaves it stopped", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));
      linux.fake.calls.length = 0;

      const again = yield* linux.run(linux.machines.stop("linux_dev"));

      expect(again).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
      expect(linux.fake.calls).toEqual(["stop linux_dev"]);
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
    "a read of every machine that fails reads them all unknown, and never fails the action it follows",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("a")));
        linux.fake.failNextObserve(new Internal({ message: "tart list exited 1" }));

        // The create's own read, after it is done, is the one that fails.
        const made = yield* linux.run(linux.machines.create(request("b")));

        linux.fake.failNextObserve(new Internal({ message: "tart list exited 1" }));

        const listed = yield* linux.run(linux.machines.list);

        expect(made).toMatchObject({
          state: "unknown",
          action: { name: "create", status: "done" },
        });
        expect(made.ssh).toBeUndefined();
        expect(listed.map(({ id, state }) => [id, state])).toEqual([
          ["linux_a", "unknown"],
          ["linux_b", "unknown"],
        ]);
        expect(yield* linux.run(linux.machines.get("linux_b"))).toMatchObject({ state: "running" });
      }),
  );

  /** Rebuilds the actions on a test clock and moves it a second at a time until `use` ends. */
  const onTestClock = <A>(
    linux: TestHost,
    use: (machines: Machines.Interface) => Effect.Effect<A, HostError>,
  ) =>
    linux.run(
      Effect.gen(function* () {
        const machines = yield* Machines.make(hostConfig(linux.stateDir, ports)).pipe(
          Effect.provideService(Store.Store, linux.store),
          Effect.provide(linux.fake.layer),
          Effect.provide(BindProbe.layer),
        );

        const fiber = yield* Effect.forkChild(Effect.result(use(machines)));
        let waited = Duration.zero;

        while (fiber.pollUnsafe() === undefined) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.seconds(1));
          waited = Duration.sum(waited, Duration.seconds(1));
        }

        return { result: yield* Fiber.join(fiber), waited: Duration.format(waited) };
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
    );

  it.effect(
    "a read of runtime state that doesn't answer within 9 s reads every machine unknown",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        linux.fake.hangNextObserve();

        const { result, waited } = yield* onTestClock(linux, (machines) =>
          machines.get("linux_dev"),
        );

        expect(waited).toBe("9s");
        expect(Result.getOrThrow(result)).toMatchObject({
          state: "unknown",
          action: { name: "create", status: "done" },
        });
      }),
  );

  it.effect(
    "an admit whose reads don't answer within 9 s fails the check with Internal, writing nothing",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        yield* linux.run(linux.machines.stop("linux_dev"));
        linux.fake.calls.length = 0;

        const { release } = linux.fake.holdNext("admit");

        const { result, waited } = yield* onTestClock(linux, (machines) =>
          machines.start("linux_dev"),
        );

        yield* release;

        const [row] = yield* rows(linux);

        expect(waited).toBe("9s");
        expect(Result.isFailure(result) && [result.failure._tag, result.failure.message]).toEqual([
          "Internal",
          "start linux_dev: the smolvm runtime's admission check didn't answer within 9s",
        ]);
        expect(row?.action).toEqual({ name: "stop", status: "done" });
        expect(linux.fake.calls).toEqual(["admit linux_dev"]);
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

  it.effect("stop on a machine the runtime can't read calls the runtime's stop", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.machines.set("dev", { state: "unknown", root: linux.fake.root("dev") ?? "" });
      linux.fake.calls.length = 0;

      const stopped = yield* linux.run(linux.machines.stop("linux_dev"));

      expect(stopped).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
      expect(linux.fake.calls).toEqual(["stop linux_dev"]);
    }),
  );

  it.effect(
    "a machine has an SSH endpoint, as the runtime's user on its port of the publish address, only while it runs",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        // With no setup, nothing installs sshd, so preparation records no host key.
        const made = yield* linux.run(linux.machines.create(request("dev")));
        const stopped = yield* linux.run(linux.machines.stop("linux_dev"));

        linux.fake.machines.clear();

        const missing = yield* linux.run(linux.machines.get("linux_dev"));
        const [row] = yield* rows(linux);

        expect(made.ssh).toEqual({ user: "root", host: "127.0.0.1", port: row?.port });
        expect(made.hostKey).toBeUndefined();
        expect([stopped, missing].map(({ state, ssh }) => [state, ssh])).toEqual([
          ["stopped", undefined],
          ["missing", undefined],
        ]);
      }),
  );

  it.effect(
    "start on a machine the runtime can't read admits it and calls the runtime's start",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.machines.create(request("dev")));
        linux.fake.machines.set("dev", { state: "unknown", root: linux.fake.root("dev") ?? "" });
        linux.fake.calls.length = 0;

        const started = yield* linux.run(linux.machines.start("linux_dev"));

        expect(started).toMatchObject({
          state: "running",
          action: { name: "start", status: "done" },
        });
        expect(linux.fake.calls).toEqual(["admit linux_dev", "start linux_dev", "exec linux_dev"]);
      }),
  );

  it.effect("a duplicate name is Conflict{exists}, and the runtime is never called", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.calls.length = 0;

      const error = yield* failure(linux, linux.machines.create(request("dev")));

      expect(error).toEqual(new Conflict({ message: "machine linux_dev exists", kind: "exists" }));
      expect(linux.fake.calls).toEqual([]);
    }),
  );

  it.effect("a base the host doesn't offer is Precondition, before anything is written", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const error = yield* failure(
        linux,
        linux.machines.create(request("dev", { base: "fedora" })),
      );

      expect(error._tag).toBe("Precondition");
      expect(error.message).toContain("offers ubuntu");
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect("an error before the first runtime call writes nothing", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      linux.fake.failNext("admit", new Capacity({ message: "no room" }));

      const error = yield* failure(linux, linux.machines.create(request("dev")));

      expect(error).toEqual(new Capacity({ message: "no room" }));
      expect(yield* rows(linux)).toEqual([]);
      expect(linux.fake.calls).toEqual(["startup", "admit linux_dev"]);
    }),
  );

  it.effect("a check that fails on an existing row puts its last action back", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      yield* linux.run(linux.machines.stop("linux_dev"));
      linux.fake.failNext("admit", new Capacity({ message: "no room" }));

      const error = yield* failure(linux, linux.machines.start("linux_dev"));
      const [row] = yield* rows(linux);

      expect(error._tag).toBe("Capacity");
      expect(row?.action).toEqual({ name: "stop", status: "done" });
    }),
  );

  it.effect("a runtime refusal is handled like a failed check: the new row is removed", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      linux.fake.refuseNext(
        "create",
        new Refusal({ error: new Capacity({ message: "account full" }) }),
      );

      const error = yield* failure(linux, linux.machines.create(request("dev")));

      expect(error).toEqual(new Capacity({ message: "account full" }));
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect(
    "a native failure leaves the row failed with the reply's error, and delete cleans up",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        linux.fake.failNext("create", new Internal({ message: "krun EINVAL" }));

        const error = yield* failure(linux, linux.machines.create(request("dev")));
        const got = yield* linux.run(linux.machines.get("linux_dev"));

        yield* linux.run(linux.machines.delete("linux_dev"));

        expect(error).toEqual(new Internal({ message: "krun EINVAL" }));
        expect(got.action).toEqual({
          name: "create",
          status: "failed",
          error: { tag: "Internal", message: "krun EINVAL" },
        });
        expect(linux.fake.calls).toContain("delete linux_dev");
        expect(yield* rows(linux)).toEqual([]);
      }),
  );

  it.effect("stop and delete of a made machine are never refused for an earlier failure", () =>
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

      expect(stopped.action).toEqual({ name: "stop", status: "done" });
      expect(stopFailed.message).toBe("guest didn't flush");
      expect(yield* rows(linux)).toEqual([]);
    }),
  );

  it.effect("delete removes a row whose create never reached the runtime", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      yield* linux.run(linux.machines.create(request("dev")));

      const row = Option.getOrThrow(yield* linux.run(linux.store.find("dev")));

      // A crash between inserting the row and the first runtime call leaves this row and nothing
      // native.
      yield* linux.run(linux.machines.delete("linux_dev"));
      yield* linux.run(linux.store.insert("create", { kind: "machine", record: row }));
      yield* linux.dispose;
      linux.fake.calls.length = 0;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

      yield* restarted.run(restarted.machines.delete("linux_dev"));

      expect(linux.fake.calls).toEqual(["startup", "delete linux_dev"]);
      expect(yield* rows(restarted)).toEqual([]);
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

  it.effect("start of a machine the runtime no longer has is Precondition and writes nothing", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
      linux.fake.machines.clear();

      const error = yield* failure(linux, linux.machines.start("linux_dev"));
      const [row] = yield* rows(linux);

      expect([error._tag, error.message]).toEqual([
        "Precondition",
        "machine linux_dev is missing from the smolvm runtime; delete it",
      ]);
      expect(row?.action).toEqual({ name: "create", status: "done" });
    }),
  );

  it.effect("a second action on a claimed machine is Conflict{busy}", () =>
    Effect.gen(function* () {
      const linux = yield* host();
      const { release, entered } = linux.fake.holdNext("create");
      const create = yield* Effect.forkChild(linux.machines.create(request("dev")));

      yield* entered;

      const [start, remove] = yield* Effect.all(
        [
          failure(linux, linux.machines.start("linux_dev")),
          failure(linux, linux.machines.delete("linux_dev")),
        ],
        { concurrency: "unbounded" },
      );

      yield* release;
      yield* Fiber.join(create);

      const busy = new Conflict({
        message: "machine linux_dev is busy: create is running",
        kind: "busy",
      });

      expect(start).toEqual(busy);
      expect(remove).toEqual(busy);
    }),
  );

  it.effect(
    "a caller that goes away doesn't interrupt the action, and its outcome is recorded",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const { release, entered } = linux.fake.holdNext("create");
        const caller = yield* Effect.forkChild(linux.machines.create(request("dev")));

        yield* entered;
        yield* Fiber.interrupt(caller);
        yield* release;

        for (let tries = 0; tries < 50; tries++) {
          const [row] = yield* rows(linux);

          if (row?.action.status === "done") {
            break;
          }

          yield* pause;
        }

        const [row] = yield* rows(linux);

        expect(row?.action).toEqual({ name: "create", status: "done" });
        expect(linux.fake.calls).toContain("exec linux_dev");
      }),
  );

  it.effect("host startup fails every action the last host process left running", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      const { entered } = linux.fake.holdNext("create");

      yield* Effect.forkChild(linux.machines.create(request("dev")));
      yield* entered;
      yield* linux.dispose;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });
      const got = yield* restarted.run(restarted.machines.get("linux_dev"));

      expect(got.action).toEqual({
        name: "create",
        status: "failed",
        error: { tag: "Internal", message: "host restarted during create" },
      });
      expect(linux.fake.calls.filter((call) => call === "startup")).toHaveLength(2);
    }),
  );

  const restartedDuringCreate = {
    name: "create",
    status: "failed",
    error: { tag: "Internal", message: "host restarted during create" },
  } as const;

  it.effect(
    "a machine whose create failed is only read, stopped or deleted: start, fork and capture refuse it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        const neverMade = [
          "Precondition",
          "machine linux_dev was never made: its create, fork or restore failed; delete it",
        ];

        // A setup that fails after the runtime's create leaves its VM running.
        const error = yield* failure(
          linux,
          linux.machines.create(
            request("dev", { setup: { script: "#!/bin/sh\nexit 3\n", timeoutSeconds: 30 } }),
          ),
        );

        linux.fake.calls.length = 0;

        const refused = yield* Effect.all(
          [
            failure(linux, linux.machines.start("linux_dev")),
            failure(linux, linux.machines.fork("linux_dev", "copy")),
            failure(linux, linux.checkpoints.capture("linux_dev", "snap")),
          ],
          { concurrency: "unbounded" },
        );

        const got = yield* linux.run(linux.machines.get("linux_dev"));
        const stopped = yield* linux.run(linux.machines.stop("linux_dev"));

        // Still never made once stopped: the check runs before the runtime's own state checks.
        const refusedStopped = yield* Effect.all(
          [
            failure(linux, linux.machines.start("linux_dev")),
            failure(linux, linux.machines.fork("linux_dev", "copy")),
            failure(linux, linux.checkpoints.capture("linux_dev", "snap")),
          ],
          { concurrency: "unbounded" },
        );

        yield* linux.run(linux.machines.delete("linux_dev"));

        expect(error._tag).toBe("Precondition");
        expect([...refused, ...refusedStopped].map(({ _tag, message }) => [_tag, message])).toEqual(
          Array.from({ length: 6 }, () => neverMade),
        );
        expect(got).toMatchObject({
          state: "running",
          made: false,
          action: { name: "create", status: "failed" },
        });
        expect(stopped).toMatchObject({
          state: "stopped",
          made: false,
          action: { name: "stop", status: "done" },
        });
        expect(linux.fake.calls).toEqual(["stop linux_dev", "delete linux_dev"]);
        expect(yield* rows(linux)).toEqual([]);
        expect(yield* linux.run(linux.store.checkpoints)).toEqual([]);
      }),
  );

  it.effect(
    "after a restart during create's setup, the machine is never made: stop stops its VM, start refuses it and delete removes it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        // Held in setup's exec: the runtime's create has made and booted the machine.
        const { entered } = linux.fake.holdNext("exec");

        yield* Effect.forkChild(
          linux.machines.create(
            request("dev", { setup: { script: "#!/bin/sh\n", timeoutSeconds: 30 } }),
          ),
        );
        yield* entered;
        yield* linux.dispose;

        const restarted = yield* host({ fake: linux.fake, dir: linux.dir });
        const before = yield* restarted.run(restarted.machines.get("linux_dev"));

        linux.fake.calls.length = 0;

        const stopped = yield* restarted.run(restarted.machines.stop("linux_dev"));
        const start = yield* failure(restarted, restarted.machines.start("linux_dev"));

        yield* restarted.run(restarted.machines.delete("linux_dev"));

        expect(before).toMatchObject({ state: "running", action: restartedDuringCreate });
        expect(stopped).toMatchObject({
          state: "stopped",
          action: { name: "stop", status: "done" },
        });
        expect([start._tag, start.message]).toEqual([
          "Precondition",
          "machine linux_dev was never made: its create, fork or restore failed; delete it",
        ]);
        expect(linux.fake.calls).toEqual(["stop linux_dev", "delete linux_dev"]);
        expect(yield* rows(restarted)).toEqual([]);
      }),
  );

  it.effect("a create, fork or restore that succeeds marks its machine made", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(linux.machines.create(request("dev")));
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
    "a create that fails only in preparation leaves its machine made, and start prepares it again",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        // With no setup, the first guest command is preparation's.
        linux.fake.failNext("exec", new Internal({ message: "sshd didn't start" }));

        const error = yield* failure(linux, linux.machines.create(request("dev")));
        const [row] = yield* rows(linux);

        linux.fake.calls.length = 0;

        const started = yield* linux.run(linux.machines.start("linux_dev"));

        expect(error).toEqual(new Internal({ message: "sshd didn't start" }));
        expect(row).toMatchObject({ made: true, action: { name: "create", status: "failed" } });
        expect(started).toMatchObject({
          state: "running",
          action: { name: "start", status: "done" },
        });
        expect(linux.fake.calls).toEqual(["admit linux_dev", "start linux_dev", "exec linux_dev"]);
      }),
  );

  it.effect(
    "after a restart during create's preparation, the machine is made, and start prepares it again",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        // Held in preparation's exec: with no setup, the runtime's create is all the work.
        const { entered } = linux.fake.holdNext("exec");

        yield* Effect.forkChild(linux.machines.create(request("dev")));
        yield* entered;
        yield* linux.dispose;

        const restarted = yield* host({ fake: linux.fake, dir: linux.dir });
        const [row] = yield* rows(restarted);
        const started = yield* restarted.run(restarted.machines.start("linux_dev"));

        expect(row).toMatchObject({ made: true, action: restartedDuringCreate });
        expect(started).toMatchObject({
          state: "running",
          action: { name: "start", status: "done" },
        });
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

      const got = yield* linux.run(linux.machines.get("linux_dev"));

      expect(error._tag).toBe("Precondition");
      expect(error.message).toContain("setup exited 3");
      expect(error.message).toContain("line 29\nbroke");
      expect(error.message).not.toContain("line 10\n");
      expect(error.message.includes(marker)).toBe(false);
      expect(got.action).toEqual({
        name: "create",
        status: "failed",
        error: { tag: "Precondition", message: error.message },
      });
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

      expect(made.action).toEqual({ name: "create", status: "done" });
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

      // The killed setup leaves its file, as on smolvm; the fake's guest shares this host's
      // /var/tmp.
      yield* remove(file);

      expect(error._tag).toBe("Precondition");
      expect(error.message).toContain("setup ran past its 1s timeout");
      expect(error.message.includes(marker)).toBe(false);
    }),
  );

  it.effect(
    "the RAM budget counts running machines and refuses with Capacity, writing nothing",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ runtime: { ramBudgetMib: 2048 } });

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));

        const full = yield* failure(linux, linux.machines.create(request("c")));

        yield* linux.run(linux.machines.stop("linux_a"));
        yield* linux.run(linux.machines.create(request("c")));

        const restart = yield* failure(linux, linux.machines.start("linux_a"));
        const again = yield* linux.run(linux.machines.start("linux_b"));

        expect(full._tag).toBe("Capacity");
        expect(full.message).toContain("needs 1G of RAM, and none of the host's 2G budget is free");
        expect(restart._tag).toBe("Capacity");
        expect(again.action).toEqual({ name: "start", status: "done" });
        expect((yield* rows(linux)).map(({ name }) => name).sort()).toEqual(["a", "b", "c"]);
      }),
  );

  it.effect(
    "the host's capacity is what step 3 counts: running machines, and one an action is booting",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ runtime: { ramBudgetMib: 4096 } });

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));
        yield* linux.run(linux.machines.stop("linux_a"));

        const idle = yield* linux.run(linux.machines.capacity);

        // A create held in the runtime is past its check, and its machine doesn't run yet.
        const { entered, release } = linux.fake.holdNext("create");

        const creating = yield* Effect.forkChild(
          linux.run(linux.machines.create(request("c", { ramMib: 2048 }))),
        );

        yield* entered;

        const booting = yield* linux.run(linux.machines.capacity);
        const full = yield* failure(linux, linux.machines.create(request("d", { ramMib: 2048 })));

        yield* release;
        yield* Fiber.join(creating);

        expect(idle).toEqual([{ host: "linux", resource: "ramMib", limit: 4096, used: 1024 }]);
        expect(booting).toEqual([{ host: "linux", resource: "ramMib", limit: 4096, used: 3072 }]);
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
      const { result, waited } = yield* onTestClock(linux, (machines) => machines.capacity);

      yield* release;

      expect([failed._tag, failed.message]).toEqual(["Internal", "tart list exited 1"]);
      expect(waited).toBe("9s");
      expect(Result.isFailure(result) && [result.failure._tag, result.failure.message]).toEqual([
        "Internal",
        "the smolvm runtime didn't answer within 9s",
      ]);
    }),
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

  it.effect("the RAM budget counts a running machine's start once: it already runs", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { ramBudgetMib: 2048 } });

      yield* linux.run(linux.machines.create(request("a")));
      yield* linux.run(linux.machines.create(request("b")));

      const started = yield* linux.run(linux.machines.start("linux_b"));

      expect(started.action).toEqual({ name: "start", status: "done" });
    }),
  );

  it.effect(
    "a start reads state once under the admission permit: the RAM budget's one observe",
    () =>
      Effect.gen(function* () {
        const linux = yield* host({ runtime: { ramBudgetMib: 4096 } });

        yield* linux.run(linux.machines.create(request("a")));
        yield* linux.run(linux.machines.create(request("b")));
        yield* linux.run(linux.machines.stop("linux_b"));
        linux.fake.observed.length = 0;

        const { release, entered } = linux.fake.holdNext("start");
        const start = yield* Effect.forkChild(linux.machines.start("linux_b"));

        yield* entered;

        const read = [...linux.fake.observed];

        yield* release;
        yield* Fiber.join(start);

        expect(read).toEqual([["linux_a"]]);
      }),
  );

  it.effect("the RAM budget reads the machines no action boots in one observe", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { ramBudgetMib: 4096 } });

      yield* linux.run(linux.machines.create(request("a")));
      yield* linux.run(linux.machines.create(request("b")));
      linux.fake.observed.length = 0;
      yield* linux.run(linux.machines.create(request("c")));

      expect(linux.fake.observed[0]).toEqual(["linux_a", "linux_b"]);
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

      // The second create waits for the first's check, so only one admit has run.
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

  it.effect("a host whose ports are all taken refuses a create with Capacity", () =>
    Effect.gen(function* () {
      const linux = yield* host({ ports: { first: ports.first, last: ports.first + 1 } });

      yield* linux.run(linux.machines.create(request("a")));
      yield* linux.run(linux.machines.create(request("b")));

      const full = yield* failure(linux, linux.machines.create(request("c")));

      expect(full._tag).toBe("Capacity");
      expect(full.message).toBe(`no free port in ${ports.first}-${ports.first + 1} on 127.0.0.1`);
    }),
  );

  it.effect("a runtime without a publish address gives machines no port", () =>
    Effect.gen(function* () {
      const linux = yield* host({ runtime: { publishAddress: undefined } });
      const made = yield* linux.run(linux.machines.create(request("dev")));
      const row = yield* linux.run(linux.store.find("dev"));

      expect(made.ssh).toBeUndefined();
      expect(Option.getOrUndefined(row)?.port).toBeUndefined();
    }),
  );
});
