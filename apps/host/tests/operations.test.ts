import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import type {
  MachineRef,
  Operation,
  Report,
  Source,
  Step,
} from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Internal,
  Missing,
  readTimeout,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Setup, Sizing } from "@gjermundgaraba/clankerbox-sdk";
import {
  chmod,
  exists,
  mkdir,
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Ref,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import type { BuildStore } from "../src/builds.ts";
import { PortProbe } from "../src/machine-ports.ts";
import type { Probe } from "../src/machine-ports.ts";
import * as Operations from "../src/operations.ts";
import * as Relay from "../src/platform/relay.ts";
import * as Reach from "../src/reach.ts";
import { Handle, Runtime } from "../src/runtime.ts";
import type { Bind } from "../src/runtime.ts";
import { Tailnet } from "../src/tailnet.ts";
import {
  baseResolver,
  fakeRuntime,
  writeTailscaleStubs,
} from "./fake-runtime.ts";
import type { FakeRuntimeName, Preset } from "./fake-runtime.ts";
import {
  accepts,
  holding,
  image,
  hostKeySetup,
  memoryBuildStore,
  pause,
} from "./support.ts";

const firstPort = 10_000;

const relayPorts = 21_600;

const allFree: Probe = { free: () => Effect.succeed(true) };

const freePorts: ReadonlyMap<FakeRuntimeName, string> = new Map([
  ["smolvm", "ubuntu"],
  ["tart", "macos"],
]);

interface RunnerOptions {
  readonly builds?: Layer.Layer<BuildStore>;
  readonly as?: FakeRuntimeName;
  readonly pin?: string;
  readonly ramBudgetMib?: number;
  readonly ports?: number;
  readonly probe?: Probe;
  readonly relayed?: boolean;
  readonly owned?: Preset["owned"];
  readonly runtime?: (fake: Runtime["Service"]) => Runtime["Service"];
  readonly tailnet?: Tailnet["Service"];
  readonly tailscale?: boolean;
}

const runner = (options?: RunnerOptions) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const faked = options?.as ?? "smolvm";

    const fake = fakeRuntime({
      dir,
      as: faked,
      ramBudgetMib: options?.ramBudgetMib,
      pin: options?.pin,
      relayed: options?.relayed,
      owned: options?.owned,
    });

    const first = options?.relayed === true ? relayPorts : firstPort;

    if (options?.tailscale === true) {
      writeTailscaleStubs(path.join(dir, "bin"));
    }

    const operations = yield* Layer.build(
      Operations.layer({
        id: faked,
        bases: new Map([[freePorts.get(faked) ?? "ubuntu", image]]),
      }).pipe(
        Layer.provide(
          Reach.layer({ first, last: first + (options?.ports ?? 10) - 1 })
        ),
        Layer.provideMerge(
          options?.runtime === undefined
            ? fake.layer
            : Layer.effect(Runtime, Effect.map(Runtime, options.runtime)).pipe(
                Layer.provide(fake.layer)
              )
        ),
        Layer.provide(
          Layer.merge(
            Layer.succeed(PortProbe, options?.probe ?? allFree),
            Relay.layer
          )
        ),
        Layer.provide(
          options?.tailnet === undefined
            ? Layer.empty
            : Layer.succeed(Tailnet, options.tailnet)
        ),
        Layer.provide(options?.builds ?? Layer.empty)
      )
    ).pipe(Effect.map(Context.get(Operations.Operations)));

    return { dir, fake, operations };
  });

type Runner = Effect.Success<ReturnType<typeof runner>>;

const ref = (name: string, fields?: Partial<MachineRef>): MachineRef => ({
  name,
  instance: `${name}-instance`,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

const checkpoint = (name: string) => ref(name);

const reached = (port: number) => ({
  endpoint: { host: "127.0.0.1", port },
});

const portIn = ({ endpoint }: MachineRef) => endpoint?.port ?? 0;

const keptByRuntime = (host: Runner, name: string) => {
  host.fake.hold({
    state: "running",
    name,
    root: "",
    instance: `${name}-instance`,
    handle: Handle.make(`held-${name}`),
  });
};

const capturingSnap: Step = {
  _tag: "capture",
  machine: ref("dev"),
  checkpoint: checkpoint("snap"),
  pin: "fake 1",
};

const stored = (host: Runner, name: string, suffix = "") =>
  exists(path.join(host.dir, "checkpoints", `${name}-instance${suffix}`));

const ofSnap = (host: Runner) =>
  host.fake.calls.filter((call) => call.endsWith(" snap"));

const makes = (
  name: string,
  fields?: {
    readonly machine?: Partial<MachineRef>;
    readonly source?: Source;
    readonly setup?: Setup;
    readonly authorizedKeys?: string;
    readonly join?: { readonly hostname: string };
    readonly taken?: readonly number[];
    readonly machines?: readonly MachineRef[];
  }
): Step => ({
  _tag: "make",
  machine: ref(name, fields?.machine),
  source: fields?.source ?? {
    _tag: "base",
    base: "ubuntu",
    ...(fields?.setup === undefined ? {} : { setup: fields.setup }),
  },
  ...(fields?.authorizedKeys === undefined
    ? {}
    : { authorizedKeys: fields.authorizedKeys }),
  ...(fields?.join === undefined ? {} : { join: fields.join }),
  taken: fields?.taken ?? [],
  machines: fields?.machines ?? [],
});

let delivered = 0;

const scopeOf = (step: Step): Operation["scope"] =>
  "checkpoint" in step
    ? { resource: "checkpoint", name: step.checkpoint.name }
    : { resource: "machine", name: step.machine.name };

const delivery = (step: Step, sequence = 1): Omit<Operation, "boot"> => {
  delivered += 1;

  return { id: `op-${delivered}`, scope: scopeOf(step), sequence, step };
};

const deliver = (
  { operations }: Pick<Runner, "operations">,
  operation: Omit<Operation, "boot">
) => operations.run({ ...operation, boot: operations.boot });

const ended = ({ operations }: Pick<Runner, "operations">, id: string) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200; tries += 1) {
      const report = yield* operations.wait(id);

      if (report.status !== "running") {
        return report;
      }

      yield* pause;
    }

    return yield* Effect.die(`operation ${id} never ended`);
  });

const finished = (host: Pick<Runner, "operations">, step: Step, sequence = 1) =>
  Effect.gen(function* () {
    const operation = delivery(step, sequence);

    yield* deliver(host, operation);

    return yield* ended(host, operation.id);
  });

const stillRunning = ({ operations }: Runner, id: string) =>
  Effect.gen(function* () {
    const waiting = yield* Effect.forkChild(operations.wait(id));

    yield* pause;

    const answered = waiting.pollUnsafe() !== undefined;

    yield* Fiber.interrupt(waiting);

    return !answered;
  });

const counted = (calls: readonly string[], call: string) =>
  calls.filter((seen) => seen === call).length;

const capturing = (lines: string[]) =>
  Logger.make(({ message, cause }) => {
    lines.push(
      [
        String(message),
        ...(cause.reasons.length === 0 ? [] : [Cause.pretty(cause)]),
      ].join("\n")
    );
  });

const errorOf = (report: Report) => [report.status, report.error?._tag];

const portOf = (report: Report) => report.outcome.endpoint?.port;

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a make whose provider answer was dropped answers the machine it finds by instance, and makes no second one",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ as: "fixed" });

        yield* host.fake.faults.dropAnswer("make");

        const report = yield* finished(host, makes("dev"));

        expect([report.status, report.outcome.handle]).toStrictEqual([
          "done",
          host.fake.machines.get("dev")?.handle,
        ]);
        expect([
          host.fake.machines.size,
          counted(host.fake.calls, "create dev"),
          counted(host.fake.calls, "lost the answer of make"),
        ]).toStrictEqual([1, 1, 1]);
      })
  );

  it.effect(
    "a sweep deletes a marked checkpoint whose instance is retired, and nothing else",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({
          as: "fixed",
          owned: { checkpoints: "marked" },
        });

        yield* finished(host, makes("dev"));
        yield* finished(
          host,
          { _tag: "stop", machine: ref("dev"), machines: [] },
          2
        );

        const captures = ["snap", "kept", "named"].map((name) => ({
          _tag: "capture" as const,
          machine: ref("dev"),
          checkpoint: checkpoint(name),
        }));

        const reports = yield* Effect.forEach(captures, (step) =>
          finished(host, step)
        );

        yield* Effect.forEach(reports, ({ id }) => host.operations.collect(id));
        yield* Effect.sleep(Duration.millis(5));

        yield* host.operations.sweep({
          machines: ["gone-instance"],
          checkpoints: ["snap-instance", "gone-instance"],
        });

        expect(
          host.fake.calls.filter((call) => call.startsWith("deleteCheckpoint"))
        ).toStrictEqual(["deleteCheckpoint snap-instance"]);
        expect(host.fake.machines.has("dev")).toBe(true);
      })
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
        yield* host.operations.sweep({
          machines: ["dev-instance"],
          checkpoints: [],
        });

        expect(
          host.fake.removals.map(([name, keep]) => [name, [...keep]])
        ).toStrictEqual([["dev-instance", [captured.outcome.handle]]]);
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

        const retired = { machines: ["dev-instance"], checkpoints: [] };

        yield* host.operations.sweep(retired);

        const whileHeld = counted(host.fake.calls, "delete dev-instance");

        yield* held.release;
        yield* ended(host, stop.id);
        yield* host.operations.collect(stop.id);
        yield* host.operations.sweep(retired);

        expect([
          whileHeld,
          counted(host.fake.calls, "delete dev-instance"),
        ]).toStrictEqual([0, 1]);
      })
  );

  it.effect(
    "a remove with no handle finds the machine by its instance and deletes it, and one that finds none is done touching nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const other = yield* finished(
          host,
          {
            _tag: "remove",
            keep: [],
            machine: { name: "dev", instance: "an-earlier-one" },
          },
          2
        );

        const kept = host.fake.machines.has("dev");

        const removed = yield* finished(
          host,
          {
            _tag: "remove",
            keep: [],
            machine: { name: "dev", instance: "dev-instance" },
          },
          3
        );

        expect([other.status, kept, removed.status]).toStrictEqual([
          "done",
          true,
          "done",
        ]);
        expect(host.fake.machines.has("dev")).toBe(false);
        expect(counted(host.fake.calls, "delete dev")).toBe(1);
      })
  );

  it.effect("the same ID returns the same report, and runs once", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const { release, entered } = host.fake.holdNext("create");
      const operation = delivery(makes("dev"));

      const first = yield* deliver(host, operation);

      yield* entered;

      const again = yield* deliver(host, operation);

      yield* release;

      const done = yield* ended(host, operation.id);
      const late = yield* deliver(host, operation);

      expect(again).toStrictEqual(first);
      expect(first.status).toBe("running");
      expect(done.status).toBe("done");
      expect(late).toStrictEqual(done);
      expect(counted(host.fake.calls, "create dev")).toBe(1);
    })
  );

  it.effect(
    "a lower or equal sequence in a scope is Conflict and runs nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(
          host,
          { _tag: "remove", machine: ref("dev"), keep: [] },
          5
        );

        const calls = [...host.fake.calls];

        const equal = yield* Effect.flip(
          deliver(
            host,
            delivery({ _tag: "remove", machine: ref("dev"), keep: [] }, 5)
          )
        );

        const lower = yield* Effect.flip(
          deliver(
            host,
            delivery({ _tag: "remove", machine: ref("dev"), keep: [] }, 4)
          )
        );

        expect([equal._tag, lower._tag]).toStrictEqual([
          "Conflict",
          "Conflict",
        ]);
        expect(equal.message).toContain("this host has seen 5");
        expect(host.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect("a sequence counts in its scope, not across scopes", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(
        host,
        { _tag: "remove", machine: ref("dev"), keep: [] },
        5
      );

      const other = yield* finished(
        host,
        { _tag: "remove", machine: ref("other"), keep: [] },
        1
      );

      expect(other.status).toBe("done");
    })
  );

  it.effect(
    "an operation delivered again after it was collected is Conflict, never run twice",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const operation = delivery(makes("dev"));

        yield* deliver(host, operation);
        yield* ended(host, operation.id);
        yield* host.operations.collect(operation.id);

        const again = yield* Effect.flip(deliver(host, operation));

        expect(again._tag).toBe("Conflict");
        expect(counted(host.fake.calls, "create dev")).toBe(1);
      })
  );

  it.effect(
    "a higher sequence cuts short what runs, and runs only after it ended",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const { release, entered } = host.fake.holdNext("stop", {
          runsOn: true,
        });

        const stopping = delivery(
          { _tag: "stop", machine: ref("dev"), machines: [] },
          2
        );

        const removing = delivery(
          { _tag: "remove", machine: ref("dev"), keep: [] },
          3
        );

        yield* deliver(host, stopping);
        yield* entered;
        yield* deliver(host, removing);
        yield* pause;

        expect(host.fake.calls).not.toContain("delete dev");
        expect(yield* stillRunning(host, stopping.id)).toBe(true);

        yield* release;

        const removed = yield* ended(host, removing.id);

        expect(removed.status).toBe("done");
        expect(
          host.fake.calls.filter((call) => /^(?:stop|delete) /u.test(call))
        ).toStrictEqual(["stop dev", "delete dev"]);
      })
  );

  it.effect(
    "a third step waits for the first when the second, cut short, never began, and forgets the second",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const { release, entered } = host.fake.holdNext("stop", {
          runsOn: true,
        });

        const stop: Step = {
          _tag: "stop",
          machine: ref("dev"),

          machines: [],
        };

        yield* deliver(host, delivery(stop, 2));
        yield* entered;

        const second = delivery(
          { _tag: "remove", machine: ref("dev"), keep: [] },
          3
        );

        const third = delivery(
          { _tag: "remove", machine: ref("dev"), keep: [] },
          4
        );

        yield* deliver(host, second);
        yield* pause;
        yield* deliver(host, third);
        yield* pause;

        expect(counted(host.fake.calls, "delete dev")).toBe(0);

        yield* release;

        expect((yield* ended(host, third.id)).status).toBe("done");
        expect((yield* host.operations.wait(second.id)).status).toBe("absent");
        expect(counted(host.fake.calls, "delete dev")).toBe(1);
      })
  );

  it.effect("wait answers as soon as the step ends", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const { release, entered } = host.fake.holdNext("create");
      const operation = delivery(makes("dev"));

      yield* deliver(host, operation);
      yield* entered;

      const waiting = yield* Effect.forkChild(
        host.operations.wait(operation.id)
      );

      yield* release;

      expect((yield* Fiber.join(waiting)).status).toBe("done");
    })
  );

  it.effect(
    "cancel turns the report cancelled only once the step has ended",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const { release, entered } = host.fake.holdNext("pause", {
          runsOn: true,
        });

        const pausing = delivery(
          { _tag: "pause", machine: ref("dev"), pin: "fake 1" },
          2
        );

        yield* deliver(host, pausing);
        yield* entered;
        yield* host.operations.cancel(pausing.id);
        yield* pause;

        expect(yield* stillRunning(host, pausing.id)).toBe(true);

        yield* release;

        expect((yield* ended(host, pausing.id)).status).toBe("cancelled");
      })
  );

  it.effect("a cancel straight after the delivery still ends the report", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const operation = delivery(makes("dev"));

      host.fake.holdNext("create");

      yield* deliver(host, operation);
      yield* host.operations.cancel(operation.id);

      expect((yield* ended(host, operation.id)).status).toBe("cancelled");
    })
  );

  it.effect("cancelling what ended, or was never held, changes nothing", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const operation = delivery(makes("dev"));

      yield* deliver(host, operation);

      const done = yield* ended(host, operation.id);

      yield* host.operations.cancel(operation.id);
      yield* host.operations.cancel("never-sent");
      yield* pause;

      expect(yield* host.operations.wait(operation.id)).toStrictEqual(done);
    })
  );

  it.effect("collect forgets only what has ended", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const { release, entered } = host.fake.holdNext("create");
      const operation = delivery(makes("dev"));

      yield* deliver(host, operation);
      yield* entered;
      yield* host.operations.collect(operation.id);

      expect(yield* stillRunning(host, operation.id)).toBe(true);

      yield* release;
      yield* ended(host, operation.id);
      yield* host.operations.collect(operation.id);

      expect((yield* host.operations.wait(operation.id)).status).toBe("absent");
    })
  );

  it.effect(
    "an operation meant for another boot is refused and runs nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const operation = delivery(makes("dev"));

        const refused = yield* Effect.flip(
          host.operations.run({ ...operation, boot: "an earlier process" })
        );

        expect(refused._tag).toBe("Conflict");
        expect((yield* host.operations.wait(operation.id)).status).toBe(
          "absent"
        );
        expect(host.fake.calls).not.toContain("create dev");
      })
  );

  it.effect(
    "a report never collected is forgotten once a later step on its machine is accepted, and frees its port",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ports: 1 });
        const make = delivery(makes("one"));

        yield* deliver(host, make);
        yield* ended(host, make.id);
        yield* finished(
          host,
          {
            _tag: "remove",
            keep: [],
            machine: { name: "one", instance: "one-instance" },
          },
          2
        );

        const next = yield* finished(host, makes("two"));

        expect((yield* host.operations.wait(make.id)).status).toBe("absent");
        expect([next.status, portOf(next)]).toStrictEqual(["done", firstPort]);
      })
  );

  it.effect("a setup never outlives the step that runs it", () =>
    Effect.gen(function* () {
      setFlagsFromString("--expose-gc");

      const host = yield* runner();

      const { id, setup } = yield* Effect.suspend(() => {
        const held: Setup = { script: hostKeySetup };
        const operation = delivery(makes("dev", { setup: held }));

        return Effect.as(deliver(host, operation), {
          id: operation.id,
          setup: new WeakRef(held),
        });
      });

      expect((yield* ended(host, id)).status).toBe("done");

      yield* pause;
      runInNewContext("gc()");
      yield* pause;

      expect(setup.deref()).toBeUndefined();
    })
  );

  it.effect("an unknown ID is absent, under this process's boot", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const other = yield* runner();

      expect(yield* host.operations.wait("never-sent")).toStrictEqual({
        id: "never-sent",
        boot: host.operations.boot,
        status: "absent",
        outcome: {},
      });
      expect(other.operations.boot).not.toBe(host.operations.boot);
    })
  );

  it.effect("a port is picked at accept, and is in the first report", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const { entered, release } = host.fake.holdNext("create");
      const operation = delivery(makes("dev"));
      const report = yield* deliver(host, operation);

      yield* entered;
      yield* release;

      const done = yield* ended(host, operation.id);

      const endpoint = { host: "127.0.0.1", port: firstPort };

      expect(report.outcome).toStrictEqual({ endpoint });
      expect(done.outcome).toMatchObject({ endpoint });
    })
  );

  it.effect("a port skips those given, and those of makes in flight", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      host.fake.holdNext("create");

      const first = yield* deliver(host, delivery(makes("one")));

      const second = yield* deliver(
        host,
        delivery(makes("two", { taken: [firstPort + 1, firstPort + 3] }))
      );

      const third = yield* deliver(
        host,
        delivery(makes("three", { taken: [firstPort + 1, firstPort + 3] }))
      );

      expect([first, second, third].map(portOf)).toStrictEqual([
        firstPort,
        firstPort + 2,
        firstPort + 4,
      ]);
    })
  );

  it.effect(
    "a make has the runtime bind the port it reports, from a base, a checkpoint or a machine",
    () =>
      Effect.gen(function* () {
        const given: Array<readonly [string, string, Bind]> = [];

        const host = yield* runner({
          runtime: (fake) => ({
            ...fake,
            make: (machine, origin, bind) =>
              Effect.andThen(
                Effect.sync(() =>
                  given.push([machine.name, origin._tag, bind])
                ),
                fake.make(machine, origin, bind)
              ),
          }),
        });

        const dev = yield* finished(host, makes("dev"));

        yield* finished(host, capturingSnap);

        const restored = yield* finished(
          host,
          makes("web", {
            source: {
              _tag: "checkpoint",
              checkpoint: checkpoint("snap"),
              pin: "fake 1",
            },
          })
        );

        const forked = yield* finished(
          host,
          makes("twin", {
            source: { _tag: "machine", machine: ref("dev"), pin: "fake 1" },
          })
        );

        expect([dev, restored, forked].map(portOf)).toStrictEqual([
          firstPort,
          firstPort + 1,
          firstPort + 2,
        ]);
        expect(given).toStrictEqual([
          ["dev", "image", { _tag: "forward", port: firstPort }],
          ["web", "checkpoint", { _tag: "forward", port: firstPort + 1 }],
          ["twin", "machine", { _tag: "forward", port: firstPort + 2 }],
        ]);
      })
  );

  it.effect("a port a bind probe finds taken is skipped", () =>
    Effect.gen(function* () {
      const host = yield* runner({
        probe: { free: (_, port) => Effect.succeed(port !== firstPort) },
      });

      const report = yield* deliver(host, delivery(makes("dev")));

      expect(portOf(report)).toBe(firstPort + 1);
    })
  );

  it.effect("a make that failed frees its port", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      host.fake.failNext("create", new Internal({ message: "no disk" }));

      const failed = yield* finished(host, makes("one"));
      const next = yield* deliver(host, delivery(makes("two")));

      expect(errorOf(failed)).toStrictEqual(["failed", "Internal"]);
      expect(portOf(failed)).toBe(firstPort);
      expect(portOf(next)).toBe(firstPort);
    })
  );

  it.effect("a make cut short frees its port", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const { entered } = host.fake.holdNext("create");
      const operation = delivery(makes("one"));

      yield* deliver(host, operation);
      yield* entered;
      yield* host.operations.cancel(operation.id);

      const cancelled = yield* ended(host, operation.id);
      const next = yield* deliver(host, delivery(makes("two")));

      expect(cancelled.status).toBe("cancelled");
      expect(portOf(next)).toBe(firstPort);
    })
  );

  it.effect(
    "a make keeps its port until it is collected, as its row may not have it yet",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const operation = delivery(makes("one"));

        yield* deliver(host, operation);
        yield* ended(host, operation.id);

        const second = yield* deliver(host, delivery(makes("two")));

        yield* host.operations.collect(operation.id);

        const third = yield* deliver(host, delivery(makes("three")));

        expect(portOf(second)).toBe(firstPort + 1);
        expect(portOf(third)).toBe(firstPort);
      })
  );

  it.effect(
    "collecting a failed make leaves its old port to the make that took it since",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        host.fake.failNext("create", new Internal({ message: "no disk" }));

        const failed = delivery(makes("one"));

        yield* deliver(host, failed);
        yield* ended(host, failed.id);

        host.fake.holdNext("create");

        const taken = yield* deliver(host, delivery(makes("two")));

        yield* host.operations.collect(failed.id);

        const next = yield* deliver(host, delivery(makes("three")));

        expect(portOf(taken)).toBe(firstPort);
        expect(portOf(next)).toBe(firstPort + 1);
      })
  );

  it.effect(
    "a host with no free port reports Capacity, so the control plane moves the create on",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ports: 1 });
        const operation = delivery(makes("dev", { taken: [firstPort] }));

        const report = yield* deliver(host, operation);
        const again = yield* host.operations.wait(operation.id);

        expect(errorOf(again)).toStrictEqual(["failed", "Capacity"]);
        expect(report.outcome).toStrictEqual({});
        expect(host.fake.calls).toStrictEqual([]);
      })
  );

  it.effect("a probe that fails reports the failure, and makes nothing", () =>
    Effect.gen(function* () {
      const host = yield* runner({
        probe: {
          free: () => Effect.fail(new Internal({ message: "bind refused" })),
        },
      });

      const operation = delivery(makes("dev"));

      yield* deliver(host, operation);

      const report = yield* ended(host, operation.id);

      expect(errorOf(report)).toStrictEqual(["failed", "Internal"]);
      expect(report.error?.message).toBe("bind refused");
      expect(host.fake.calls).toStrictEqual([]);
    })
  );

  it.effect(
    "a make that can't pick a port still cuts short the step it follows",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ports: 1 });

        yield* finished(host, makes("dev"));

        const { entered, release } = host.fake.holdNext("stop", {
          runsOn: true,
        });

        const stopping = delivery(
          { _tag: "stop", machine: ref("dev"), machines: [] },
          2
        );

        const making = delivery(makes("dev", { taken: [firstPort] }), 3);

        yield* deliver(host, stopping);
        yield* entered;
        yield* deliver(host, making);
        yield* pause;

        expect(host.fake.calls).toContain("stop dev");
        expect(yield* stillRunning(host, making.id)).toBe(true);

        yield* release;

        expect(errorOf(yield* ended(host, making.id))).toStrictEqual([
          "failed",
          "Capacity",
        ]);
      })
  );

  it.effect(
    "a delivery whose caller leaves during the pick records nothing, and can be sent again",
    () =>
      Effect.gen(function* () {
        const probing = yield* Deferred.make<undefined>();
        const held = yield* Ref.make(true);

        const host = yield* runner({
          probe: {
            free: () =>
              Effect.flatMap(Ref.getAndSet(held, false), (hold) =>
                hold
                  ? Effect.andThen(
                      Deferred.succeed(probing, undefined),
                      Effect.never
                    )
                  : Effect.succeed(true)
              ),
          },
        });

        const operation = delivery(makes("dev"));
        const leaving = yield* Effect.forkChild(deliver(host, operation));

        yield* Deferred.await(probing);
        yield* Fiber.interrupt(leaving);

        expect((yield* host.operations.wait(operation.id)).status).toBe(
          "absent"
        );

        const sent = yield* deliver(host, operation);

        expect(sent.status).toBe("running");
        expect((yield* ended(host, operation.id)).status).toBe("done");
      })
  );

  it.effect("admission counts the machine it admits", () =>
    Effect.gen(function* () {
      const host = yield* runner({ ramBudgetMib: 1024 });

      const report = yield* finished(
        host,
        makes("dev", { machine: { ramMib: 2048 } })
      );

      expect(errorOf(report)).toStrictEqual(["failed", "Capacity"]);
      expect(report.error?.message).toContain("createMachine dev needs");
      expect(host.fake.calls).not.toContain("create dev");
    })
  );

  it.effect("admission counts the machines given that run", () =>
    Effect.gen(function* () {
      const host = yield* runner({ ramBudgetMib: 2048 });

      yield* finished(host, makes("one"));

      const room = yield* finished(
        host,
        makes("two", { machines: [ref("one")] })
      );

      const none = yield* finished(
        host,
        makes("three", { machines: [ref("one"), ref("two")] })
      );

      expect(room.status).toBe("done");
      expect(errorOf(none)).toStrictEqual(["failed", "Capacity"]);
    })
  );

  it.effect(
    "admission counts machines still booting, which no row holds yet, and capacity shows them",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ramBudgetMib: 1024 });
        const { entered, release } = host.fake.holdNext("create");
        const booting = delivery(makes("one"));

        yield* deliver(host, booting);
        yield* entered;

        const refused = yield* finished(host, makes("two"));
        const reading = yield* host.operations.capacity([]);

        yield* release;
        yield* ended(host, booting.id);

        const after = yield* host.operations.capacity([]);

        expect(errorOf(refused)).toStrictEqual(["failed", "Capacity"]);
        expect(reading).toContainEqual({
          resource: "ramMib",
          limit: 1024,
          used: 1024,
        });
        expect(after).toContainEqual({
          resource: "ramMib",
          limit: 1024,
          used: 0,
        });
        expect(
          host.fake.activations[1]?.machines.find(
            ({ machine }) => machine.name === "one"
          )?._tag
        ).toBe("booting");
      })
  );

  it.effect(
    "a start admits a VM the runtime holds stopped beside the machines that run, and not one it holds running",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ramBudgetMib: 1024 });
        const dev = ref("dev", reached(firstPort));
        const other = ref("other", reached(firstPort + 1));

        yield* finished(
          host,
          makes("dev", { setup: { script: hostKeySetup } })
        );
        yield* finished(host, { _tag: "stop", machine: dev, machines: [] }, 2);
        yield* finished(
          host,
          makes("other", { setup: { script: hostKeySetup } })
        );

        const refused = yield* finished(
          host,
          {
            _tag: "start",
            keep: [],
            machine: dev,
            pin: "fake 1",
            machines: [other],
          },
          3
        );

        const started = yield* finished(
          host,
          {
            _tag: "start",
            keep: [],
            machine: other,
            pin: "fake 1",
            machines: [dev],
          },
          2
        );

        expect(errorOf(refused)).toStrictEqual(["failed", "Capacity"]);
        expect(host.fake.machines.get("dev")?.state).toBe("stopped");
        expect(started.status).toBe("done");
        expect(started.outcome.hostKey).toContain("ssh-ed25519");
        expect(host.fake.activations.map(({ action }) => action)).toStrictEqual(
          ["createMachine", "createMachine", "startMachine"]
        );
      })
  );

  it.effect(
    "a stop that resumes admits a VM the runtime holds paused, beside the machines that run",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ramBudgetMib: 1024 });
        const dev = ref("dev", reached(firstPort));
        const other = ref("other", reached(firstPort + 1));

        yield* finished(host, makes("dev"));
        yield* finished(
          host,
          { _tag: "pause", machine: dev, pin: "fake 1" },
          2
        );
        yield* finished(host, makes("other"));

        const stopped = yield* finished(
          host,
          { _tag: "stop", machine: dev, pin: "fake 1", machines: [other] },
          3
        );

        expect(errorOf(stopped)).toStrictEqual(["failed", "Capacity"]);
        expect(host.fake.machines.get("dev")?.state).toBe("paused");
      })
  );

  it.effect(
    "exec runs a command in a running machine as the user named, with its env and stdin",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const dev = ref("dev", reached(firstPort));

        yield* finished(host, makes("dev"));

        const executed = yield* host.operations.exec({
          machine: dev,
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
    "exec waits for a step on the machine to end, and then answers for the state it left",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const dev = ref("dev", reached(firstPort));

        yield* finished(host, makes("dev"));

        const { entered, release } = host.fake.holdNext("stop");

        yield* deliver(
          host,
          delivery({ _tag: "stop", machine: dev, machines: [] }, 2)
        );
        yield* entered;

        const running = yield* Effect.forkChild(
          Effect.flip(host.operations.exec({ machine: dev, argv: ["true"] }))
        );

        yield* pause;

        const early = running.pollUnsafe();

        yield* release;

        const error = yield* Fiber.join(running);

        expect(early).toBeUndefined();
        expect(error).toBeInstanceOf(WrongState);
        expect(error).toMatchObject({ machine: "dev", state: "stopped" });
        expect(counted(host.fake.calls, "exec dev")).toBe(0);
      })
  );

  it.effect(
    "exec in a stopped machine is WrongState, and in one the host doesn't hold Missing, running nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const dev = ref("dev", reached(firstPort));

        yield* finished(host, makes("dev"));
        yield* finished(host, { _tag: "stop", machine: dev, machines: [] }, 2);
        host.fake.calls.length = 0;

        const stopped = yield* Effect.flip(
          host.operations.exec({ machine: dev, argv: ["true"] })
        );

        const unheld = yield* Effect.flip(
          host.operations.exec({ machine: ref("other"), argv: ["true"] })
        );

        expect(stopped).toBeInstanceOf(WrongState);
        expect(unheld).toBeInstanceOf(Missing);
        expect(host.fake.calls).not.toContain("exec dev");
        expect(host.fake.calls).not.toContain("exec other");
      })
  );

  it.effect("an exec cut short ends its command", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const dev = ref("dev", reached(firstPort));

      yield* finished(host, makes("dev"));

      const pidFile = path.join(host.fake.root("dev") ?? "", "exec.pid");

      const running = yield* Effect.forkChild(
        host.operations.exec({
          machine: dev,
          argv: [
            "/bin/sh",
            "-c",
            'echo "$$" >"$0.partial" && mv "$0.partial" "$0" && exec sleep 30',
            pidFile,
          ],
        })
      );

      const pid = Number(yield* Effect.eventually(read(pidFile)));

      yield* Fiber.interrupt(running);

      expect(() => process.kill(pid, 0)).toThrow("ESRCH");
    })
  );

  it.effect("a make from a base boots the image its host maps it to", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      expect((yield* finished(host, makes("dev"))).status).toBe("done");
      expect(host.fake.images.get("dev")).toBe(image);
    })
  );

  it.effect("a checkpoint restores only under the pin it was saved under", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      const report = yield* finished(
        host,
        makes("dev", {
          source: {
            _tag: "checkpoint",
            checkpoint: checkpoint("snap"),
            pin: "fake 0",
          },
        })
      );

      expect(errorOf(report)).toStrictEqual(["failed", "PinMismatch"]);
      expect(report.error?.message).toContain("fake 0");
      expect(host.fake.calls).not.toContain("restore dev");
    })
  );

  it.effect("a fork copies only a VM booted under the host's pin", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      const report = yield* finished(
        host,
        makes("copy", {
          source: { _tag: "machine", machine: ref("dev"), pin: "fake 0" },
        })
      );

      expect(errorOf(report)).toStrictEqual(["failed", "PinMismatch"]);
      expect(report.error?.message).toContain("stop it and start it again");
      expect(host.fake.calls).not.toContain("fork copy");
    })
  );

  it.effect(
    "a checkpoint and a fork under the host's pin make the machine",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const taken = yield* finished(host, capturingSnap);

        const restored = yield* finished(
          host,
          makes("again", {
            source: {
              _tag: "checkpoint",
              checkpoint: checkpoint("snap"),
              pin: "fake 1",
            },
          })
        );

        const forked = yield* finished(
          host,
          makes("copy", {
            source: { _tag: "machine", machine: ref("dev"), pin: "fake 1" },
          })
        );

        expect(
          [taken, restored, forked].map(({ status }) => status)
        ).toStrictEqual(["done", "done", "done"]);
      })
  );

  it.effect(
    "a copy from a template's build installs the step's keys once, however often it runs",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        const secondKey =
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISecondKey second";

        const keysOf = (name: string) =>
          path.join(
            host.fake.root(name) ?? "",
            "home",
            "admin",
            ".ssh",
            "authorized_keys"
          );

        yield* finished(
          host,
          makes("builder", { setup: { script: hostKeySetup } })
        );
        yield* finished(host, {
          _tag: "capture",
          machine: ref("builder"),
          checkpoint: checkpoint("built"),
          pin: "fake 1",
        });

        const authorizedKeys = `${operatorKey}\n\n${secondKey}\n`;

        const restored = yield* finished(
          host,
          makes("dev", {
            source: {
              _tag: "checkpoint",
              checkpoint: checkpoint("built"),
              pin: "fake 1",
            },
            authorizedKeys,
          })
        );

        const forked = yield* finished(
          host,
          makes("copy", {
            source: { _tag: "machine", machine: ref("dev"), pin: "fake 1" },
            authorizedKeys,
          })
        );

        const installed = `\n${operatorKey}\n\n${secondKey}\n`;

        expect([restored.status, forked.status]).toStrictEqual([
          "done",
          "done",
        ]);
        expect(yield* exists(keysOf("builder"))).toBe(false);
        expect(yield* read(keysOf("dev"))).toBe(installed);
        expect(yield* read(keysOf("copy"))).toBe(installed);
      })
  );

  it.effect("a paused machine starts only under the pin it booted under", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));
      yield* finished(
        host,
        { _tag: "pause", machine: ref("dev"), pin: "fake 1" },
        2
      );

      const report = yield* finished(
        host,
        {
          _tag: "start",
          keep: [],
          machine: ref("dev"),
          pin: "fake 0",
          machines: [],
        },
        3
      );

      expect(errorOf(report)).toStrictEqual(["failed", "PinMismatch"]);
      expect(host.fake.calls).not.toContain("start dev");
    })
  );

  it.effect("a stopped machine starts under any pin, as nothing resumes", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const setup = { script: hostKeySetup };

      yield* finished(host, makes("dev", { setup }));
      yield* finished(
        host,
        { _tag: "stop", machine: ref("dev"), machines: [] },
        2
      );

      const report = yield* finished(
        host,
        {
          _tag: "start",
          keep: [],
          machine: ref("dev"),
          pin: "fake 0",
          machines: [],
        },
        3
      );

      expect(report.status).toBe("done");
    })
  );

  it.effect(
    "a stop that resumes a paused machine does so only under its pin, and is admitted",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));
        yield* finished(
          host,
          { _tag: "pause", machine: ref("dev"), pin: "fake 1" },
          2
        );

        const refused = yield* finished(
          host,
          {
            _tag: "stop",
            machine: ref("dev"),
            pin: "fake 0",
            machines: [],
          },
          3
        );

        const stopped = yield* finished(
          host,
          {
            _tag: "stop",
            machine: ref("dev"),
            pin: "fake 1",
            machines: [],
          },
          4
        );

        expect(errorOf(refused)).toStrictEqual(["failed", "PinMismatch"]);
        expect(stopped.status).toBe("done");
        expect(counted(host.fake.calls, "stop dev")).toBe(1);
        expect(host.fake.activations.at(-1)?.action).toBe("stopMachine");
      })
  );

  it.effect(
    "a runtime whose stop doesn't resume stops a paused VM under any pin, and admits nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ as: "tart" });

        yield* finished(
          host,
          makes("dev", { source: { _tag: "base", base: "macos" } })
        );
        yield* finished(host, { _tag: "pause", machine: ref("dev") }, 2);
        host.fake.calls.length = 0;

        const report = yield* finished(
          host,
          {
            _tag: "stop",
            machine: ref("dev"),
            pin: "older",
            machines: [],
          },
          3
        );

        expect(host.fake.machines.get("dev")?.state).toBe("stopped");
        expect(report.status).toBe("done");
        expect(host.fake.calls).toStrictEqual(["stop dev"]);
      })
  );

  it.effect("a pause stops a VM booted under another pin instead", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));

      const report = yield* finished(
        host,
        { _tag: "pause", machine: ref("dev"), pin: "fake 0" },
        2
      );

      expect(report.status).toBe("done");
      expect(host.fake.calls).toContain("stop dev");
      expect(host.fake.calls).not.toContain("pause dev");
      expect(host.fake.machines.get("dev")?.state).toBe("stopped");
    })
  );

  it.effect("a pause under the host's pin saves the VM", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));
      yield* finished(
        host,
        { _tag: "pause", machine: ref("dev"), pin: "fake 1" },
        2
      );

      expect(host.fake.machines.get("dev")?.state).toBe("paused");
    })
  );

  it.effect(
    "a capture copies only a VM booted under the host's pin, and says a refusal left nothing",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const report = yield* finished(host, {
          _tag: "capture",
          machine: ref("dev"),
          checkpoint: checkpoint("snap"),
          pin: "fake 0",
        });

        expect(errorOf(report)).toStrictEqual(["failed", "PinMismatch"]);
        expect(host.fake.calls).not.toContain("capture snap");
        expect(host.fake.calls).not.toContain("deleteCheckpoint snap");
        expect(report.outcome.cleared).toBe(true);
      })
  );

  it.effect("a capture that fails clears what it left", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));
      host.fake.failNext("capture", new Internal({ message: "no disk" }));

      const report = yield* finished(host, capturingSnap);

      expect(errorOf(report)).toStrictEqual(["failed", "Internal"]);
      expect(host.fake.calls).toContain("deleteCheckpoint snap");
      expect(report.outcome.cleared).toBe(true);
    })
  );

  it.effect("a capture whose clearing fails doesn't say it cleared", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));
      host.fake.failNext("capture", new Internal({ message: "no disk" }));
      host.fake.failNext(
        "deleteCheckpoint",
        new Internal({ message: "EBUSY" })
      );

      const report = yield* finished(host, capturingSnap);

      expect(errorOf(report)).toStrictEqual(["failed", "Internal"]);
      expect(report.outcome.cleared).toBeUndefined();
    })
  );

  it.effect(
    "a capture that ends done keeps its checkpoint and leaves nothing to clear",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const report = yield* finished(host, capturingSnap);

        expect(report.status).toBe("done");
        expect(report.outcome.cleared).toBeUndefined();
        expect(host.fake.calls).not.toContain("deleteCheckpoint snap");
        expect(yield* stored(host, "snap")).toBe(true);
      })
  );

  it.effect(
    "a capture cut short after it copied ends cancelled, deletes its checkpoint, and says it cleared",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const { entered, release } = host.fake.holdNext("capture", {
          runsOn: true,
        });

        const operation = delivery(capturingSnap);

        yield* deliver(host, operation);
        yield* entered;
        yield* host.operations.cancel(operation.id);
        yield* release;

        const report = yield* ended(host, operation.id);

        expect(report.status).toBe("cancelled");
        expect(report.outcome.cleared).toBe(true);
        expect(ofSnap(host)).toStrictEqual([
          "capture snap",
          "deleteCheckpoint snap",
        ]);
        expect(yield* stored(host, "snap")).toBe(false);
      })
  );

  it.effect(
    "a host that stops during a capture deletes what the capture copied before it has stopped",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const host = yield* runner().pipe(Scope.provide(scope));

        yield* finished(host, makes("dev"));

        const { entered, release } = host.fake.holdNext("capture", {
          runsOn: true,
        });

        const deleting = host.fake.holdNext("deleteCheckpoint");

        yield* deliver(host, delivery(capturingSnap));
        yield* entered;

        const stopping = yield* Effect.forkChild(Scope.close(scope, Exit.void));

        yield* release;
        yield* deleting.entered;
        yield* pause;

        const stoppedFirst = stopping.pollUnsafe() !== undefined;

        yield* deleting.release;
        yield* Fiber.join(stopping);

        expect(stoppedFirst).toBe(false);
        expect(ofSnap(host)).toStrictEqual([
          "capture snap",
          "deleteCheckpoint snap",
        ]);
      })
  );

  it.effect(
    "a fetch cut short after its install ends cancelled, keeps the checkpoint it installed, and leaves no staging folder",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ builds: memoryBuildStore().layer });

        yield* finished(host, makes("dev"));
        yield* finished(host, capturingSnap);
        yield* finished(
          host,
          { _tag: "publish", checkpoint: checkpoint("snap") },
          2
        );

        const { entered, release } = host.fake.holdNext("install", {
          runsOn: true,
        });

        const operation = delivery({
          _tag: "fetch",
          checkpoint: checkpoint("fetched"),
          from: "snap",
          build: "web@1",
        });

        yield* deliver(host, operation);
        yield* entered;
        yield* host.operations.cancel(operation.id);
        yield* release;

        const report = yield* ended(host, operation.id);

        expect(report.status).toBe("cancelled");
        expect(report.outcome.cleared).toBeUndefined();
        expect(host.fake.calls).not.toContain("deleteCheckpoint fetched");
        expect(yield* stored(host, "fetched")).toBe(true);
        expect(yield* stored(host, "fetched", ".fetching")).toBe(false);
      })
  );

  it.effect(
    "a delete of a published copy that unpublishes it empties the build store of it, and one on a host with no store logs that it stays",
    () => {
      const logged: string[] = [];

      return Effect.gen(function* () {
        const { layer: builds, objects } = memoryBuildStore();
        const host = yield* runner({ builds });

        yield* finished(host, makes("dev"));
        yield* finished(host, capturingSnap);
        yield* finished(
          host,
          { _tag: "publish", checkpoint: checkpoint("snap") },
          2
        );

        const published = objects.size;

        const deleted = yield* finished(
          host,
          {
            _tag: "deleteCheckpoint",
            checkpoint: checkpoint("snap"),
            unpublish: true,
          },
          3
        );

        const bare = yield* runner();

        yield* finished(bare, makes("dev"));
        yield* finished(bare, capturingSnap);

        const kept = yield* finished(
          bare,
          {
            _tag: "deleteCheckpoint",
            checkpoint: checkpoint("snap"),
            unpublish: true,
          },
          2
        );

        expect({
          published: published > 0,
          left: objects.size,
          statuses: [deleted.status, kept.status],
          deleted: [host, bare].map((each) =>
            each.fake.calls.includes("deleteCheckpoint snap")
          ),
        }).toStrictEqual({
          published: true,
          left: 0,
          statuses: ["done", "done"],
          deleted: [true, true],
        });
        expect(logged.join("\n")).toContain(
          "so what it published stays in the build store"
        );
      }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
    }
  );

  it.effect("a resize answers the sizes the runtime reads back", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));

      const report = yield* finished(
        host,
        {
          _tag: "resize",
          machine: ref("dev"),
          to: { cpu: 2, ramMib: 2048 },
          machines: [],
        },
        2
      );

      expect(report.status).toBe("done");
      expect(report.outcome.sizes).toStrictEqual({
        cpu: 2,
        ramMib: 2048,
        diskGib: 10,
      });
    })
  );

  it.effect(
    "a resize whose read-back leaves a size out keeps the one it asked",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));
        yield* finished(
          host,
          { _tag: "stop", machine: ref("dev"), machines: [] },
          2
        );

        const reading = host.fake.holdNext("sizes");

        const resizing = yield* Effect.forkChild(
          finished(
            host,
            {
              _tag: "resize",
              machine: ref("dev"),
              to: { cpu: 2, diskGib: 20 },
              machines: [],
            },
            3
          )
        );

        yield* reading.entered;
        host.fake.resizedTo("dev", { cpu: 2, ramMib: 1024 });
        yield* reading.release;

        expect((yield* Fiber.join(resizing)).outcome.sizes).toStrictEqual({
          cpu: 2,
          ramMib: 1024,
          diskGib: 20,
        });
      })
  );

  it.effect("a resize that fails part way keeps the sizes it gave", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));
      host.fake.giveOnlyRamThenFailNextResize(
        new Internal({ message: "the disk didn't grow" })
      );

      const report = yield* finished(
        host,
        {
          _tag: "resize",
          machine: ref("dev"),
          to: { ramMib: 2048, diskGib: 20 },
          machines: [],
        },
        2
      );

      expect(errorOf(report)).toStrictEqual(["failed", "Internal"]);
      expect(report.outcome.sizes).toStrictEqual({
        cpu: 1,
        ramMib: 2048,
        diskGib: 10,
      });
    })
  );

  it.effect(
    "a resize whose sizes can't be read back keeps those asked, or on failure those it had",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));

        const unreadable = new Internal({ message: "no answer" });
        const to = { cpu: 2 };

        host.fake.failNext("sizes", unreadable);

        const given = yield* finished(
          host,
          { _tag: "resize", machine: ref("dev"), to, machines: [] },
          2
        );

        host.fake.failNext("resize", new Internal({ message: "refused" }));
        host.fake.failNext("sizes", unreadable);

        const refused = yield* finished(
          host,
          { _tag: "resize", machine: ref("dev"), to, machines: [] },
          3
        );

        expect(given.outcome.sizes).toStrictEqual({
          cpu: 2,
          ramMib: 1024,
          diskGib: 10,
        });
        expect(refused.status).toBe("failed");
        expect(refused.outcome.sizes).toStrictEqual({
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
        });
      })
  );

  it.effect(
    "a resize refused up front touches nothing, admission included, and says why",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const mac = yield* runner({ as: "tart" });
        const dev = ref("dev");

        const parked = ref("paused", reached(firstPort + 1));

        yield* finished(host, makes("dev"));
        yield* finished(host, makes("paused"));
        yield* finished(
          host,
          { _tag: "pause", machine: parked, pin: "fake 1" },
          2
        );
        yield* finished(
          mac,
          makes("dev", { source: { _tag: "base", base: "macos" } })
        );
        host.fake.calls.length = 0;
        mac.fake.calls.length = 0;

        const admitted = [
          host.fake.activations.length,
          mac.fake.activations.length,
        ];

        const resizing = (
          to: Sizing,
          sequence: number,
          on = host,
          machine = dev
        ) =>
          finished(on, { _tag: "resize", machine, to, machines: [] }, sequence);

        const disk = yield* resizing({ diskGib: 5 }, 2);
        const live = yield* resizing({ cpu: 2, ramMib: 512 }, 3);
        const gone = yield* resizing({ cpu: 2 }, 1, host, ref("gone"));
        const running = yield* resizing({ ramMib: 2048 }, 2, mac);
        const paused = yield* resizing({ cpu: 2 }, 3, host, parked);

        expect(
          [disk, live, running, paused].map(({ error }) => [
            error?._tag,
            error?.message,
          ])
        ).toStrictEqual([
          ["Unsizable", "machine dev's disk is 10G, and a disk only grows"],
          [
            "Unsizable",
            "a running machine's vCPUs and RAM only grow, and dev has 1 vCPUs and 1G: stop it to shrink them",
          ],
          [
            "WrongState",
            "machine dev is running, and the tart runtime resizes only a stopped machine: stop it first",
          ],
          [
            "WrongState",
            "machine paused is paused, and the smolvm runtime resizes a stopped or running machine: stop it first",
          ],
        ]);
        expect(gone.error?._tag).toBe("Missing");
        expect([...host.fake.calls, ...mac.fake.calls]).toStrictEqual([]);
        expect([
          host.fake.activations.length,
          mac.fake.activations.length,
        ]).toStrictEqual(admitted);
      })
  );

  it.effect(
    "sizes the runtime can't give are refused before admission and anything native, for a resize and a copy",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();
        const refused = new Unsizable({ message: "grows RAM in 128M steps" });

        yield* finished(host, makes("dev"));
        host.fake.sized.length = 0;

        const admitted = host.fake.activations.length;

        host.fake.refuseNextSizes(refused);

        const resized = yield* finished(
          host,
          {
            _tag: "resize",
            machine: ref("dev"),
            to: { ramMib: 2100 },
            machines: [],
          },
          2
        );

        host.fake.refuseNextSizes(refused);

        const forked = yield* finished(
          host,
          makes("copy", {
            machine: { ramMib: 2100 },
            source: { _tag: "machine", machine: ref("dev"), pin: "fake 1" },
          })
        );

        const held = { cpu: 1, ramMib: 1024, diskGib: 10 };
        const asked = { ...held, ramMib: 2100 };

        expect([resized.error, forked.error]).toStrictEqual([refused, refused]);
        expect(host.fake.sized).toStrictEqual([
          ["dev", held, asked, true],
          ["copy", held, asked, true],
        ]);
        expect(host.fake.calls).not.toContain("resize dev");
        expect(host.fake.calls).not.toContain("fork copy");
        expect(host.fake.activations).toHaveLength(admitted);
      })
  );

  it.effect("a resize of a machine the runtime couldn't read is refused", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));
      host.fake.failNextObserve(new Internal({ message: "unread" }));

      const report = yield* finished(
        host,
        { _tag: "resize", machine: ref("dev"), to: { cpu: 2 }, machines: [] },
        2
      );

      expect(errorOf(report)).toStrictEqual(["failed", "Internal"]);
      expect(host.fake.calls).not.toContain("resize dev");
    })
  );

  it.effect(
    "a live resize that adds RAM is admitted, with the RAM it adds",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ramBudgetMib: 1024 });

        yield* finished(host, makes("dev"));

        const report = yield* finished(
          host,
          {
            _tag: "resize",
            machine: ref("dev"),
            to: { ramMib: 2048 },
            machines: [],
          },
          2
        );

        expect(errorOf(report)).toStrictEqual(["failed", "Capacity"]);
        expect(host.fake.calls).not.toContain("resize dev");
      })
  );

  it.effect("a step whose setup fails leaves the VM for its undo", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      const report = yield* finished(
        host,
        makes("dev", { setup: { script: "exit 3" } })
      );

      expect(report.status).toBe("failed");
      expect(report.error?._tag).toBe("ScriptFailed");
      expect(host.fake.machines.has("dev")).toBe(true);
      expect(host.fake.calls).not.toContain("delete dev");
    })
  );

  it.effect("a step that dies reports Internal, and the log has why", () => {
    const logged: string[] = [];

    return Effect.gen(function* () {
      const host = yield* runner();

      host.fake.dieNext("create", "the runtime blew up");

      const report = yield* finished(host, makes("dev"));

      expect(errorOf(report)).toStrictEqual(["failed", "Internal"]);
      expect(report.error?.message).toBe(
        "make machine dev died; the host log has why"
      );
      expect(logged.join("\n")).toContain("the runtime blew up");
    }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
  });

  it.effect("a step that dies while it is cut short reports that it died", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));

      const { entered, release } = host.fake.holdNext("capture", {
        runsOn: true,
      });

      host.fake.dieNext("deleteCheckpoint", "the cleanup blew up");

      const operation = delivery(capturingSnap);

      yield* deliver(host, operation);
      yield* entered;

      const cancelling = yield* Effect.forkChild(
        host.operations.cancel(operation.id)
      );

      yield* release;
      yield* Fiber.join(cancelling);

      expect(errorOf(yield* ended(host, operation.id))).toStrictEqual([
        "failed",
        "Internal",
      ]);
    })
  );

  it.effect("a read of no machines asks the runtime nothing", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      expect((yield* host.operations.read([])).size).toBe(0);
      expect(host.fake.observed).toStrictEqual([]);
    })
  );

  it.effect("a read that dies answers Internal", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      keptByRuntime(host, "dev");
      host.fake.dieNextObserve();

      const error = yield* Effect.flip(host.operations.read([ref("dev")]));

      expect(error._tag).toBe("Internal");
    })
  );
});

const minting = (failures = 0) =>
  Effect.gen(function* () {
    const minted = yield* Ref.make(0);
    const failing = yield* Ref.make(failures);

    const mintedBuild = yield* Ref.make(0);

    const keyFrom = (counter: Ref.Ref<number>, prefix: string) =>
      Effect.gen(function* () {
        if ((yield* Ref.getAndUpdate(failing, (left) => left - 1)) > 0) {
          return yield* new Internal({
            message: "Tailscale refused the OAuth client",
          });
        }

        const count = yield* Ref.updateAndGet(counter, (all) => all + 1);

        return Redacted.make(`${prefix}-${count}`);
      });

    const tailnet = {
      mint: keyFrom(minted, "tskey-auth"),
      mintBuild: keyFrom(mintedBuild, "tskey-auth-build"),
    };

    return {
      tailnet,
      minted: Ref.get(minted),
      mintedBuild: Ref.get(mintedBuild),
    };
  });

const joining: Step = {
  _tag: "join",
  machine: ref("dev"),
  hostname: "linux-dev",
};

const joinedAs = { state: "joined", name: "linux-dev.example.ts.net" };

const tailnetDir = "var/lib/clankerbox/tailscale";

const builderMake = (setupBody: string) =>
  makes("building-1", {
    setup: {
      script: [
        "#!/bin/sh",
        "set -eu",
        'echo setup >>"$CLANKERBOX_ROOT/calls"',
        `tailscale --socket="$CLANKERBOX_ROOT/${tailnetDir}/tailscaled.sock" status --json >"$HOME/status.json" || true`,
        setupBody,
        "",
      ].join("\n"),
    },
    join: { hostname: "cbx-building-1" },
  });

const inBuilder = (host: Runner, file: string) =>
  path.join(host.fake.root("building-1") ?? "", file);

const tailnetStep = (line: string) => {
  if (line === "setup") {
    return ["setup"];
  }

  return line.startsWith("tailscale ") ? [line.split(" ")[2] ?? ""] : [];
};

const tailnetSteps = (host: Runner) =>
  Effect.map(
    Effect.orElseSucceed(read(inBuilder(host, "calls")), () => ""),
    (text) => text.split("\n").flatMap(tailnetStep)
  );

const rootOf = (host: Runner, file: string) =>
  path.join(host.fake.machines.get("dev")?.root ?? "", file);

const starting: Step = {
  _tag: "start",
  keep: [],
  machine: ref("dev"),
  machines: [],
};

const guestHook = (host: Runner, hook: string, body: string) =>
  Effect.gen(function* () {
    const file = rootOf(host, `etc/clankerbox/${hook}`);

    yield* mkdir(path.dirname(file));
    yield* write(file, `#!/bin/sh\nset -eu\n${body}\n`);
    yield* chmod(file, 0o755);
  });

const leftIn = (host: Runner) => path.join(host.dir, "left");

const leaveHooks = (host: Runner) =>
  Effect.forEach(
    ["stop", "pause", "delete"],
    (hook) => guestHook(host, hook, `echo ${hook} >>"${leftIn(host)}"`),
    { discard: true }
  );

const identified = (host: Runner, instance = "dev-instance") =>
  Effect.gen(function* () {
    const file = rootOf(host, "var/lib/clankerbox/instance");

    yield* mkdir(path.dirname(file));
    yield* write(file, `${instance}\n`);
  });

const hooksRun = (host: Runner) =>
  Effect.map(
    Effect.orElseSucceed(read(leftIn(host)), () => ""),
    (text) => text.split("\n").filter((line) => line !== "")
  );

const stateOf = (host: Runner) =>
  host.fake.machines.get("dev")?.state ?? "missing";

type LeavingStep = Extract<
  Step,
  { readonly _tag: "stop" | "pause" | "remove" }
>;

const stopping: LeavingStep = {
  _tag: "stop",
  machine: ref("dev"),
  pin: "fake 1",
  machines: [],
};

const pausing: LeavingStep = {
  _tag: "pause",
  machine: ref("dev"),
  pin: "fake 1",
};

const removing: LeavingStep = {
  _tag: "remove",
  keep: [],
  machine: { name: "dev", instance: "dev-instance" },
};

const leavings = [
  { step: "stop", sent: stopping, hook: "stop", ends: "stopped" },
  { step: "pause", sent: pausing, hook: "pause", ends: "paused" },
  {
    step: "pause under another pin",
    sent: { ...pausing, pin: "fake 0" },
    hook: "pause",
    ends: "stopped",
  },
  { step: "remove", sent: removing, hook: "delete", ends: "missing" },
] as const;

const notRunning = [
  { step: "remove", before: stopping, sent: removing, ends: "missing" },
  { step: "stop", before: pausing, sent: stopping, ends: "stopped" },
] as const;

const hooked = (step: LeavingStep, timeoutSeconds = 30): Step => ({
  ...step,
  hook: { timeoutSeconds },
});

const runningStatus = (health: readonly string[]) =>
  JSON.stringify(
    {
      BackendState: "Running",
      Health: health,
      Self: { ID: "n2", DNSName: "linux-dev.example.ts.net." },
    },
    undefined,
    2
  );

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a start resets a copied identity, then runs its hook, and joins nothing",
    () =>
      Effect.gen(function* () {
        const keys = yield* minting();
        const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

        yield* finished(
          host,
          makes("dev", { setup: { script: hostKeySetup } })
        );
        yield* mkdir(rootOf(host, "var/lib/clankerbox/tailscale/state"));
        yield* write(
          rootOf(host, "var/lib/clankerbox/tailscale/state/source"),
          "source node"
        );
        yield* guestHook(
          host,
          "start",
          [
            'test ! -e "$CLANKERBOX_ROOT/var/lib/clankerbox/tailscale/state/source"',
            'test "$(cat "$CLANKERBOX_ROOT/var/lib/clankerbox/instance")" = dev-instance',
            'echo started >"$CLANKERBOX_ROOT/started"',
          ].join("\n")
        );

        const report = yield* finished(host, starting, 2);

        expect(report.status).toBe("done");
        expect(report.outcome.tailnet).toBeUndefined();
        expect(report.outcome.hostKey).toContain("ssh-ed25519");
        expect(yield* read(rootOf(host, "started"))).toBe("started\n");
        expect(yield* read(rootOf(host, "calls"))).not.toContain("tailscale");
        expect(yield* keys.minted).toBe(0);
      })
  );

  for (const { step, sent, hook, ends } of leavings) {
    it.effect(
      `a ${step} that asks for its hook reads the VM once, runs the guest's ${hook} hook while it runs, then ends it ${ends}`,
      () =>
        Effect.gen(function* () {
          const host = yield* runner();

          yield* finished(host, makes("dev"));
          yield* identified(host);
          yield* leaveHooks(host);
          host.fake.observed.length = 0;

          const report = yield* finished(host, hooked(sent), 2);

          expect(report.status).toBe("done");
          expect(yield* hooksRun(host)).toStrictEqual([hook]);
          expect(stateOf(host)).toBe(ends);
          expect(host.fake.observed).toStrictEqual([["dev"]]);
        })
    );

    it.effect(
      `a ${step} that doesn't ask for a hook runs none, and ends the VM ${ends}`,
      () =>
        Effect.gen(function* () {
          const host = yield* runner();

          yield* finished(host, makes("dev"));
          yield* identified(host);
          yield* leaveHooks(host);

          const report = yield* finished(host, sent, 2);

          expect(report.status).toBe("done");
          expect(yield* hooksRun(host)).toStrictEqual([]);
          expect(stateOf(host)).toBe(ends);
        })
    );
  }

  for (const { step, before, sent, ends } of notRunning) {
    it.effect(
      `a ${step} of a VM that isn't running runs no hook, nor tries to`,
      () => {
        const logged: string[] = [];

        return Effect.gen(function* () {
          const host = yield* runner();

          yield* finished(host, makes("dev"));
          yield* finished(host, before, 2);
          yield* identified(host);
          yield* leaveHooks(host);

          const report = yield* finished(host, hooked(sent), 3);

          expect(report.status).toBe("done");
          expect(yield* hooksRun(host)).toStrictEqual([]);
          expect(stateOf(host)).toBe(ends);
          expect(logged.join("\n")).not.toContain("hook");
        }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
      }
    );
  }

  it.effect(
    "a hook cut short ends its step cancelled, leaving the VM running",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));
        yield* identified(host);
        yield* guestHook(
          host,
          "stop",
          `echo stop >>"${leftIn(host)}"\nexec sleep 30`
        );

        const operation = delivery(hooked(stopping), 2);

        yield* deliver(host, operation);
        yield* Effect.eventually(read(leftIn(host)));
        yield* host.operations.cancel(operation.id);

        const report = yield* ended(host, operation.id);

        expect(report.status).toBe("cancelled");
        expect(stateOf(host)).toBe("running");
        expect(host.fake.calls).not.toContain("stop dev");
      })
  );

  for (const [what, unread] of [
    [
      "fails",
      (host: Runner) => {
        host.fake.failNextObserve(new Internal({ message: "agent gone" }));
      },
    ],
    [
      "dies",
      (host: Runner) => {
        host.fake.dieNextObserve();
      },
    ],
  ] as const) {
    it.effect(
      `a delete whose read of the VM ${what} runs no hook, logs it, and goes on`,
      () => {
        const logged: string[] = [];

        return Effect.gen(function* () {
          const host = yield* runner();

          yield* finished(host, makes("dev"));
          yield* identified(host);
          yield* leaveHooks(host);
          unread(host);

          const report = yield* finished(host, hooked(removing), 2);

          expect(report.status).toBe("done");
          expect(yield* hooksRun(host)).toStrictEqual([]);
          expect(stateOf(host)).toBe("missing");
          expect(logged.join("\n")).toContain("delete dev goes on");
        }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
      }
    );
  }

  it.effect("a hook that fails is logged, and its stop goes on", () => {
    const logged: string[] = [];

    return Effect.gen(function* () {
      const host = yield* runner();

      yield* finished(host, makes("dev"));
      yield* identified(host);
      yield* guestHook(host, "stop", "echo the shipper is down\nexit 3");

      const report = yield* finished(host, hooked(stopping), 2);

      expect(report.status).toBe("done");
      expect(stateOf(host)).toBe("stopped");
      expect(logged.join("\n")).toContain(
        "stop dev goes on: its stop hook exited 3; its last output:\nthe shipper is down"
      );
    }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
  });

  it.effect(
    "a hook past its step's time limit is cut short, logged, and the delete goes on",
    () => {
      const logged: string[] = [];

      return Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));
        yield* identified(host);
        yield* guestHook(
          host,
          "delete",
          `echo delete >>"${leftIn(host)}"\nexec sleep 30`
        );

        const report = yield* finished(host, hooked(removing, 1), 2);

        expect(report.status).toBe("done");
        expect(yield* hooksRun(host)).toStrictEqual(["delete"]);
        expect(stateOf(host)).toBe("missing");
        expect(logged).toContain(
          "delete dev: running its delete hook, if its guest has one and has taken its identity, for at most 1s"
        );
        expect(logged.join("\n")).toContain(
          "delete dev goes on: its delete hook exited 124, past its 1s limit or by a timeout of its own"
        );
      }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
    }
  );

  for (const { guest, hooks, instance } of [
    {
      guest: "has no hook for its step",
      hooks: false,
      instance: "dev-instance",
    },
    { guest: "has no instance file", hooks: true, instance: undefined },
    {
      guest: "holds another machine's instance",
      hooks: true,
      instance: "src-instance",
    },
  ] as const) {
    it.effect(
      `a running VM whose guest ${guest} runs no hook, logs no failure, and its stop goes on`,
      () => {
        const logged: string[] = [];

        return Effect.gen(function* () {
          const host = yield* runner();

          yield* finished(host, makes("dev"));

          if (instance !== undefined) {
            yield* identified(host, instance);
          }

          if (hooks) {
            yield* leaveHooks(host);
          }

          const report = yield* finished(host, hooked(stopping), 2);

          expect(report.status).toBe("done");
          expect(yield* hooksRun(host)).toStrictEqual([]);
          expect(stateOf(host)).toBe("stopped");
          expect(logged.join("\n")).not.toContain("goes on");
        }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
      }
    );
  }

  it.effect(
    "a hook whose command the runtime fails to run is logged, and the step goes on without it",
    () => {
      const logged: string[] = [];

      return Effect.gen(function* () {
        const host = yield* runner();

        yield* finished(host, makes("dev"));
        yield* identified(host);
        yield* leaveHooks(host);
        host.fake.failNext("exec", new Internal({ message: "agent gone" }));

        const report = yield* finished(host, hooked(pausing), 2);

        expect(report.status).toBe("done");
        expect(yield* hooksRun(host)).toStrictEqual([]);
        expect(stateOf(host)).toBe("paused");
        expect(logged.join("\n")).toContain("agent gone");
      }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
    }
  );

  it.effect(
    "a make from a build identifies, installs keys and prepares, and reports the host key",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        const guest = (file: string) =>
          path.join(host.fake.root("dev") ?? "", file);

        yield* finished(
          host,
          makes("builder", { setup: { script: hostKeySetup } })
        );

        const hook = path.join(
          host.fake.root("builder") ?? "",
          "etc/clankerbox/start"
        );

        yield* mkdir(path.dirname(hook));
        yield* write(
          hook,
          '#!/bin/sh\nset -eu\ncat "$CLANKERBOX_ROOT/var/lib/clankerbox/instance" >"$CLANKERBOX_ROOT/started"\n'
        );
        yield* chmod(hook, 0o755);
        yield* finished(host, {
          _tag: "capture",
          machine: ref("builder"),
          checkpoint: checkpoint("built"),
          pin: "fake 1",
        });

        host.fake.calls.length = 0;

        const report = yield* finished(
          host,
          makes("dev", {
            source: {
              _tag: "checkpoint",
              checkpoint: checkpoint("built"),
              pin: "fake 1",
            },
            authorizedKeys: `${operatorKey}\n`,
          })
        );

        const shown = yield* read(guest("etc/ssh/ssh_host_ed25519_key.pub"));

        expect(report.status).toBe("done");
        expect(report.outcome.prepared).toBe(true);
        expect(report.outcome.hostKey).toBe(
          shown.trim().split(" ").slice(0, 2).join(" ")
        );
        expect(yield* read(guest("var/lib/clankerbox/machine-id"))).toBe(
          "dev\n"
        );
        expect(yield* read(guest("started"))).toBe("dev-instance\n");
        expect(yield* read(guest("home/admin/.ssh/authorized_keys"))).toContain(
          operatorKey
        );
        expect(host.fake.calls).toStrictEqual([
          "admit dev",
          "restore dev",
          "exec dev",
          "exec dev",
          "exec dev",
        ]);
      })
  );

  it.effect(
    "a make with a setup prepares the base first, then runs the setup as the login user with the step's keys",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        const report = yield* finished(
          host,
          makes("dev", {
            setup: {
              script:
                '#!/bin/sh\necho "setup in $HOME with $(cat "$HOME/.ssh/authorized_keys" | grep -c ssh-)" >>"$CLANKERBOX_ROOT/calls"\n',
            },
            authorizedKeys: `${operatorKey}\n`,
          })
        );

        const calls = yield* read(
          path.join(host.fake.root("dev") ?? "", "calls")
        );

        expect(report.status).toBe("done");
        expect(calls.split("\n").filter((line) => line !== "")).toStrictEqual([
          "apt-get -o Acquire::Retries=5 -o APT::Update::Error-Mode=any update",
          "apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates curl openssh-server sudo perl libnss-myhostname",
          "useradd -m -s /bin/bash -U admin",
          `setup in ${path.join(host.fake.root("dev") ?? "", "home/admin")} with 1`,
        ]);
      })
  );

  it.effect("a make from a base reports itself unprepared, for a start", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      const report = yield* finished(
        host,
        makes("dev", { setup: { script: hostKeySetup } })
      );

      expect(report.status).toBe("done");
      expect(report.outcome.prepared).toBeUndefined();
      expect(report.outcome.hostKey).toBeUndefined();
    })
  );

  it.effect(
    "a machine that needs a login gets one minted key, and shows the DNS name it joined as",
    () =>
      Effect.gen(function* () {
        const keys = yield* minting();
        const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

        yield* finished(host, makes("dev"));

        const report = yield* finished(host, joining, 2);

        expect(report.status).toBe("done");
        expect(report.outcome.tailnet).toStrictEqual(joinedAs);
        expect(yield* keys.minted).toBe(1);
        expect(yield* read(rootOf(host, "key-seen"))).toBe("tskey-auth-1");
        expect(
          (yield* read(rootOf(host, "tailscaled.env"))).split("\n")
        ).toContain("TS_PERMIT_CERT_UID=admin");
      })
  );

  it.effect("a machine still signed in mints nothing", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

      yield* finished(host, makes("dev"));
      yield* finished(host, joining, 2);

      const report = yield* finished(host, joining, 3);

      expect(report.outcome.tailnet).toStrictEqual(joinedAs);
      expect(yield* keys.minted).toBe(1);
    })
  );

  it.effect("a join that fails is done, and its status says why", () =>
    Effect.gen(function* () {
      const keys = yield* minting(1);
      const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

      yield* finished(host, makes("dev"));

      const report = yield* finished(host, joining, 2);

      expect(report.status).toBe("done");
      expect(report.outcome.tailnet).toStrictEqual({
        state: "failed",
        error: "Tailscale refused the OAuth client",
      });
    })
  );

  it.effect("a join that fails can run again and join", () =>
    Effect.gen(function* () {
      const keys = yield* minting(1);
      const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

      yield* finished(host, makes("dev"));
      yield* finished(host, joining, 2);

      const report = yield* finished(host, joining, 3);

      expect(report.outcome.tailnet).toStrictEqual(joinedAs);
      expect(yield* keys.minted).toBe(1);
    })
  );

  it.effect("a join whose mint dies is a failed join", () =>
    Effect.gen(function* () {
      const host = yield* runner({
        tailnet: {
          mint: Effect.die(new Error("the API client blew up")),
          mintBuild: Effect.die(new Error("the API client blew up")),
        },
        tailscale: true,
      });

      yield* finished(host, makes("dev"));

      const report = yield* finished(host, joining, 2);

      expect(report.status).toBe("done");
      expect(report.outcome.tailnet).toStrictEqual({
        state: "failed",
        error: "tailnet join dev died; the host log has why",
      });
    })
  );

  it.effect("a guest without tailscaled is missing, and no key is minted", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const host = yield* runner({ tailnet: keys.tailnet });

      yield* finished(host, makes("dev"));

      const report = yield* finished(host, joining, 2);

      expect(report.outcome.tailnet).toStrictEqual({ state: "missing" });
      expect(yield* keys.minted).toBe(0);
    })
  );

  it.effect("a host that joins no tailnet reports no status", () =>
    Effect.gen(function* () {
      const host = yield* runner({ tailscale: true });

      yield* finished(host, makes("dev"));

      const report = yield* finished(host, joining, 2);

      expect(report.status).toBe("done");
      expect(report.outcome.tailnet).toBeUndefined();
    })
  );

  it.effect(
    "a builder's make joins the tailnet before its setup, and logs its node out and restores its DNS after it",
    () => {
      const logged: string[] = [];

      return Effect.gen(function* () {
        const keys = yield* minting();
        const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

        const report = yield* finished(host, builderMake("echo done"));

        expect(report.status, report.error?.message).toBe("done");
        expect(yield* tailnetSteps(host)).toStrictEqual([
          "set",
          "up",
          "setup",
          "logout",
        ]);
        expect(yield* read(inBuilder(host, "calls"))).toContain(
          "--hostname=cbx-building-1"
        );
        expect(
          yield* read(inBuilder(host, "home/admin/status.json"))
        ).toContain('"BackendState": "Running"');
        expect(yield* exists(inBuilder(host, tailnetDir))).toBe(false);
        expect(yield* read(inBuilder(host, "etc/resolv.conf"))).toBe(
          `nameserver ${baseResolver}\n`
        );
        expect(
          yield* exists(
            inBuilder(host, "var/lib/clankerbox/resolv.conf.before-join")
          )
        ).toBe(false);
        expect([yield* keys.mintedBuild, yield* keys.minted]).toStrictEqual([
          1, 0,
        ]);
        expect(report.outcome.tailnet).toBeUndefined();
        expect(logged.join("\n")).toContain("so it is restored");
        expect(logged.join("\n")).not.toContain("tskey-");
      }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
    }
  );

  it.effect("a builder whose setup fails is logged out all the same", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

      const report = yield* finished(host, builderMake("exit 1"));

      expect(errorOf(report)).toStrictEqual(["failed", "ScriptFailed"]);
      expect(yield* tailnetSteps(host)).toStrictEqual([
        "set",
        "up",
        "setup",
        "logout",
      ]);
      expect(yield* exists(inBuilder(host, tailnetDir))).toBe(false);
      expect(yield* read(inBuilder(host, "etc/resolv.conf"))).toBe(
        `nameserver ${baseResolver}\n`
      );
    })
  );

  it.effect(
    "a builder that can't join fails before its setup, and leaves no node",
    () =>
      Effect.gen(function* () {
        const keys = yield* minting(1);
        const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

        const report = yield* finished(host, builderMake("echo done"));

        expect(errorOf(report)).toStrictEqual(["failed", "Internal"]);
        expect(report.error?.message).toContain(
          "didn't join the tailnet for its setup: Tailscale refused the OAuth client"
        );
        expect(yield* tailnetSteps(host)).toStrictEqual(["set", "logout"]);
        expect(yield* exists(inBuilder(host, tailnetDir))).toBe(false);
      })
  );

  it.effect("a make that asks no join mints no key, even with a setup", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

      const report = yield* finished(
        host,
        makes("building-1", { setup: { script: "#!/bin/sh\necho done\n" } })
      );

      expect(report.status, report.error?.message).toBe("done");
      expect(yield* tailnetSteps(host)).toStrictEqual([]);
      expect([yield* keys.mintedBuild, yield* keys.minted]).toStrictEqual([
        0, 0,
      ]);
    })
  );

  it.effect(
    "a make that asks a join of a host with no tailnet runs its setup off the tailnet",
    () => {
      const logged: string[] = [];

      return Effect.gen(function* () {
        const host = yield* runner({ tailscale: true });

        const report = yield* finished(host, builderMake("echo done"));

        expect(report.status, report.error?.message).toBe("done");
        expect(yield* tailnetSteps(host)).toStrictEqual(["setup"]);
        expect(logged.join("\n")).toContain(
          "make building-1: its step asks for a tailnet join, and host smolvm has no tailnet setting"
        );
      }).pipe(Effect.provide(Logger.layer([capturing(logged)])));
    }
  );

  it.effect("a status longer than an error's tail still reads whole", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const host = yield* runner({ tailnet: keys.tailnet, tailscale: true });

      yield* finished(host, makes("dev"));
      yield* finished(host, joining, 2);

      const status = runningStatus(
        Array.from({ length: 60 }, (_, at) => `${at} ${"w".repeat(180)}`)
      );

      expect(status.length).toBeGreaterThan(10_000);

      yield* write(rootOf(host, "status.json"), status);

      expect((yield* finished(host, joining, 3)).outcome.tailnet).toStrictEqual(
        joinedAs
      );
    })
  );
});

layer(NodeServices.layer)((it) => {
  it.effect("a join past its 3 minutes is done, and its status says so", () =>
    Effect.gen(function* () {
      const mintingKey = yield* Deferred.make<undefined>();

      const host = yield* runner({
        tailscale: true,
        tailnet: {
          mint: Effect.andThen(
            Deferred.succeed(mintingKey, undefined),
            Effect.never
          ),
          mintBuild: Effect.never,
        },
      });

      yield* finished(host, makes("dev"));

      const operation = delivery(joining, 2);

      yield* deliver(host, operation);
      yield* Deferred.await(mintingKey);
      yield* TestClock.adjust("3 minutes");

      const report = yield* host.operations.wait(operation.id);

      expect(report.status).toBe("done");
      expect(report.outcome.tailnet).toStrictEqual({
        state: "failed",
        error: "the join didn't finish within 3m",
      });
    })
  );

  it.effect("wait answers a step still running after five seconds", () =>
    Effect.gen(function* () {
      const host = yield* runner();
      const { entered } = host.fake.holdNext("create");
      const operation = delivery(makes("dev"));

      yield* deliver(host, operation);
      yield* entered;

      const waiting = yield* Effect.forkChild(
        host.operations.wait(operation.id)
      );

      yield* TestClock.adjust("4999 millis");

      expect(waiting.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("1 millis");

      expect((yield* Fiber.join(waiting)).status).toBe("running");
    })
  );

  it.effect("a runtime that doesn't answer a read answers Internal", () =>
    Effect.gen(function* () {
      const host = yield* runner();

      keptByRuntime(host, "dev");
      host.fake.hangNextObserve();

      const reading = yield* Effect.forkChild(
        Effect.flip(
          host.operations.read([
            ref("dev", { handle: Handle.make("held-dev") }),
          ])
        )
      );

      yield* TestClock.adjust(readTimeout);

      expect((yield* Fiber.join(reading)).message).toContain("didn't answer");
    })
  );
});

const refusedListen = (port: number) =>
  new RegExp(`^the relay couldn't listen on 127\\.0\\.0\\.1:${port}: `, "u");

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a make on a relayed runtime listens on its port once the runtime's make has answered, and one whose port is held fails with the listen error and the handle of what it made, which its remove deletes",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true });

        const refused = yield* Effect.scoped(
          Effect.andThen(holding(relayPorts), finished(host, makes("dev")))
        );

        const { handle } = refused.outcome;

        const removed = yield* finished(
          host,
          {
            _tag: "remove",
            keep: [],
            machine: {
              ...ref("dev"),
              ...(handle === undefined ? {} : { handle }),
            },
          },
          2
        );

        expect(errorOf(refused)).toStrictEqual(["failed", "Internal"]);
        expect(refused.error?.message).toMatch(refusedListen(relayPorts));
        expect(handle).toBeDefined();
        expect([
          counted(host.fake.calls, "create dev"),
          removed.status,
          host.fake.machines.has("dev"),
        ]).toStrictEqual([1, "done", false]);

        const { release, entered } = host.fake.holdNext("create");
        const making = delivery(makes("app"));

        yield* deliver(host, making);
        yield* entered;

        const early = yield* accepts(relayPorts);

        yield* release;

        const made = yield* ended(host, making.id);

        expect([
          early,
          made.status,
          portOf(made),
          yield* accepts(relayPorts),
        ]).toStrictEqual([false, "done", relayPorts, true]);
        expect(
          host.fake.calls.filter((call) => call.startsWith("relay"))
        ).toStrictEqual(["relay app"]);
      })
  );

  it.effect(
    "a make that fails natively opens no relay, and a made machine's relay stays through a stop and a failed delete, and ends once the delete is done",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true });

        host.fake.failNext("create", new Internal({ message: "no disk" }));

        const failed = yield* finished(host, makes("dev"));

        const made = yield* finished(
          host,
          makes("app", { taken: [relayPorts] })
        );

        const app = ref("app", reached(portOf(made) ?? 0));

        yield* finished(host, { _tag: "stop", machine: app, machines: [] }, 2);

        const stopped = yield* accepts(portIn(app));

        host.fake.failNext("delete", new Internal({ message: "EBUSY" }));

        const kept = yield* finished(
          host,
          { _tag: "remove", machine: app, keep: [] },
          3
        );

        const keptListening = yield* accepts(portIn(app));

        const removed = yield* finished(
          host,
          { _tag: "remove", machine: app, keep: [] },
          4
        );

        expect([
          failed.status,
          yield* accepts(portOf(failed) ?? 0),
          stopped,
          kept.status,
          keptListening,
          removed.status,
          yield* accepts(portIn(app)),
        ]).toStrictEqual([
          "failed",
          false,
          true,
          "failed",
          true,
          "done",
          false,
        ]);
      })
  );

  it.effect(
    "a start listens on its row's port before the runtime starts the machine, and one whose port is held fails before the runtime is called",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true });

        yield* finished(host, makes("dev"));

        const blocked = ref("dev", reached(relayPorts + 5));

        const refused = yield* Effect.scoped(
          Effect.andThen(
            holding(portIn(blocked)),
            finished(
              host,
              { _tag: "start", keep: [], machine: blocked, machines: [] },
              2
            )
          )
        );

        expect(errorOf(refused)).toStrictEqual(["failed", "Internal"]);
        expect(refused.error?.message).toMatch(refusedListen(portIn(blocked)));
        expect(host.fake.calls).not.toContain("start dev");

        const { release, entered } = host.fake.holdNext("start");

        const opening = delivery(
          { _tag: "start", keep: [], machine: blocked, machines: [] },
          3
        );

        yield* deliver(host, opening);
        yield* entered;

        const listening = yield* accepts(portIn(blocked));

        yield* release;

        expect([
          listening,
          (yield* ended(host, opening.id)).status,
        ]).toStrictEqual([true, "done"]);
      })
  );

  it.effect(
    "a start of a machine the runtime no longer has is refused before its relay listens",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true });
        const ghost = ref("ghost", reached(relayPorts + 6));

        const refused = yield* finished(host, {
          _tag: "start",
          keep: [],
          machine: ghost,
          machines: [],
        });

        expect(errorOf(refused)).toStrictEqual(["failed", "Missing"]);
        expect(yield* accepts(portIn(ghost))).toBe(false);
      })
  );

  it.effect(
    "a fork or a restore whose port is held fails with the listen error once the runtime has made it, and reports what it made",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true, as: "tart" });
        const src = ref("src", reached(relayPorts));

        yield* finished(host, makes("src"));
        yield* finished(host, { _tag: "stop", machine: src, machines: [] }, 2);

        const snap = yield* finished(host, {
          _tag: "capture",
          machine: src,
          checkpoint: checkpoint("snap"),
        });

        const refused = yield* Effect.scoped(
          Effect.andThen(
            holding(relayPorts + 1),
            Effect.forEach(
              [
                makes("twin", {
                  source: { _tag: "machine", machine: src },
                  taken: [relayPorts],
                }),
                makes("copy", {
                  source: {
                    _tag: "checkpoint",
                    checkpoint: {
                      ...checkpoint("snap"),
                      ...(snap.outcome.handle === undefined
                        ? {}
                        : { handle: snap.outcome.handle }),
                    },
                  },
                  taken: [relayPorts],
                }),
              ],
              (step) => finished(host, step)
            )
          )
        );

        expect(snap.status).toBe("done");

        for (const report of refused) {
          expect([
            ...errorOf(report),
            report.error?.message,
            report.outcome.handle !== undefined,
          ]).toStrictEqual([
            "failed",
            "Internal",
            expect.stringMatching(refusedListen(relayPorts + 1)),
            true,
          ]);
        }

        expect([
          counted(host.fake.calls, "fork twin"),
          counted(host.fake.calls, "restore copy"),
        ]).toStrictEqual([1, 1]);
      })
  );

  it.effect(
    "a fork the runtime refuses for its source's state, and a fork or a restore refused for the pin, open no relay, and their removes are done",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ relayed: true, as: "tart" });
        const src = ref("src", reached(relayPorts));

        yield* finished(host, makes("src"));

        const running = yield* finished(
          host,
          makes("twin", { source: { _tag: "machine", machine: src } })
        );

        const forkPinned = yield* finished(
          host,
          makes("pinned", {
            source: { _tag: "machine", machine: src, pin: "fake 0" },
            taken: [relayPorts + 1],
          })
        );

        const restorePinned = yield* finished(
          host,
          makes("copy", {
            source: {
              _tag: "checkpoint",
              checkpoint: checkpoint("snap"),
              pin: "fake 0",
            },
            taken: [relayPorts + 1, relayPorts + 2],
          })
        );

        const refused = [
          { name: "twin", report: running },
          { name: "pinned", report: forkPinned },
          { name: "copy", report: restorePinned },
        ];

        const open = yield* Effect.forEach(refused, ({ report }) =>
          accepts(portOf(report) ?? 0)
        );

        const removed = yield* Effect.forEach(refused, ({ name }) =>
          finished(host, { _tag: "remove", machine: ref(name), keep: [] }, 2)
        );

        expect(refused.map(({ report }) => errorOf(report))).toStrictEqual([
          ["failed", "WrongState"],
          ["failed", "PinMismatch"],
          ["failed", "PinMismatch"],
        ]);
        expect(refused.map(({ report }) => portOf(report))).toStrictEqual([
          relayPorts + 1,
          relayPorts + 2,
          relayPorts + 3,
        ]);
        expect([open, removed.map(({ status }) => status)]).toStrictEqual([
          [false, false, false],
          ["done", "done", "done"],
        ]);
        expect(
          host.fake.calls.filter((call) => call.startsWith("delete"))
        ).toStrictEqual([]);
      })
  );
});

const locked = new Internal({
  message: "smolvm machine status broken failed: database is locked",
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a machine whose search fails reads unknown, and every other machine on its host reads as it is",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        keptByRuntime(host, "ok");
        keptByRuntime(host, "broken");
        host.fake.failFind("broken", locked);

        const states = yield* host.operations.read([
          ref("ok"),
          ref("broken"),
          ref("gone"),
        ]);

        expect(Object.fromEntries(states)).toStrictEqual({
          ok: "running",
          broken: "unknown",
          gone: "missing",
        });
      })
  );

  it.effect(
    "capacity names a machine whose search fails as unread, as it names one the runtime couldn't read, counts the others, and leaves out one its search finds nothing of",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ramBudgetMib: 4096 });
        const ok = ref("ok", { handle: Handle.make("held-ok") });

        keptByRuntime(host, "ok");
        keptByRuntime(host, "broken");
        host.fake.failFind("broken", locked);

        const unfound = yield* host.operations.capacity([
          ok,
          ref("broken"),
          ref("gone"),
        ]);

        const found = yield* host.operations.capacity([
          ok,
          ref("broken", { handle: Handle.make("held-broken") }),
          ref("gone"),
        ]);

        expect(unfound).toStrictEqual([
          { resource: "cpu", unread: ["broken"] },
          { resource: "ramMib", unread: ["broken"], limit: 4096 },
        ]);
        expect(found).toStrictEqual([
          { resource: "cpu", used: 2 },
          { resource: "ramMib", used: 2048, limit: 4096 },
        ]);
      })
  );

  it.effect(
    "a make, a start and a resize of another machine go on while one machine's search fails, and admission counts that one at its whole RAM and none its search finds nothing of",
    () =>
      Effect.gen(function* () {
        const host = yield* runner({ ramBudgetMib: 3072 });
        const broken = ref("broken");
        const gone = ref("gone");

        keptByRuntime(host, "broken");
        host.fake.failFind("broken", locked);

        const made = yield* finished(
          host,
          makes("dev", { machines: [broken, gone] })
        );

        const dev = ref("dev");

        const stopped = yield* finished(
          host,
          { _tag: "stop", machine: dev, machines: [broken, gone] },
          2
        );

        const started = yield* finished(
          host,
          {
            _tag: "start",
            keep: [],
            machine: dev,
            pin: "fake 1",
            machines: [broken, gone],
          },
          3
        );

        const resized = yield* finished(
          host,
          {
            _tag: "resize",
            machine: dev,
            to: { ramMib: 2048 },
            machines: [broken, gone],
          },
          4
        );

        const refused = yield* finished(
          host,
          makes("big", {
            machine: { ramMib: 1024 },
            machines: [broken, gone, { ...dev, ramMib: 2048 }],
          })
        );

        expect(
          [made, stopped, started, resized, refused].map(errorOf)
        ).toStrictEqual([
          ["done", undefined],
          ["done", undefined],
          ["done", undefined],
          ["done", undefined],
          ["failed", "Capacity"],
        ]);
        expect(counted(host.fake.calls, "create dev")).toBe(1);
      })
  );

  it.effect(
    "a step on the machine whose search fails fails, and its remove is not done",
    () =>
      Effect.gen(function* () {
        const host = yield* runner();

        keptByRuntime(host, "broken");
        host.fake.failFind("broken", locked);

        const started = yield* finished(host, {
          _tag: "start",
          keep: [],
          machine: ref("broken"),
          pin: "fake 1",
          machines: [],
        });

        const removed = yield* finished(
          host,
          {
            _tag: "remove",
            keep: [],
            machine: { name: "broken", instance: "broken-instance" },
          },
          2
        );

        expect([started, removed].map(errorOf)).toStrictEqual([
          ["failed", "Internal"],
          ["failed", "Internal"],
        ]);
        expect(removed.error?.message).toContain("database is locked");
        expect(host.fake.machines.has("broken")).toBe(true);
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

        const ok = ref("ok", { endpoint: { port: relayPorts + 1 } });
        const broken = ref("broken", { endpoint: { port: relayPorts + 2 } });
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
            find: (what, found) =>
              found.name === "slow"
                ? Effect.andThen(Deferred.await(gate), fake.find(what, found))
                : fake.find(what, found),
          }),
        });

        keptByRuntime(host, "gone");
        keptByRuntime(host, "slow");

        const gone = ref("gone", {
          handle: Handle.make("held-gone"),
          endpoint: { port: relayPorts + 1 },
        });

        const slow = ref("slow", { endpoint: { port: relayPorts + 2 } });

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
