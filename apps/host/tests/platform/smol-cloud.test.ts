import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { Duration } from "effect";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { hostLayer } from "../../src/composition/host.ts";
import { Operations } from "../../src/operations.ts";
import { Unanswered } from "../../src/platform/provider-http.ts";
import * as Api from "../../src/platform/smol-cloud/api.ts";
import * as SmolCloud from "../../src/platform/smol-cloud/smol-cloud.ts";
import { Handle, Runtime } from "../../src/runtime.ts";
import type { Interface, Target } from "../../src/runtime.ts";
import { Tailnet } from "../../src/tailnet.ts";
import { fakeSmolCloud } from "../fake-smol-cloud.ts";
import type { FakeSmolCloud } from "../fake-smol-cloud.ts";
import {
  cutAndLeftRunning,
  gone,
  leftInTheBackground,
  holdsPid,
} from "../guest-processes.ts";
import { runtimeContract } from "../runtime-contract.ts";
import { stallingHttp } from "../stalling-http.ts";
import {
  hostConfig,
  loopbackServer,
  suitePorts,
  writeTailscaleStubs,
} from "../support.ts";

const key = "fake-key";

const image = "docker.io/library/ubuntu:24.04";

const hostId = "fake-cloud";

const provided = Effect.provide(NodeServices.layer);

const provider = Effect.gen(function* () {
  const dir = yield* scratch;
  const fake = yield* fakeSmolCloud({ dir: path.join(dir, "provider"), key });
  const keyFile = path.join(dir, "key");

  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });

  return {
    dir,
    fake,
    settings: { apiKeyFile: keyFile, api: fake.url },
  };
});

const Made = Schema.Struct({ id: Schema.String });

const posted = async (url: string, body?: unknown) => {
  const answer = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  return Schema.decodeUnknownSync(Made)(await answer.json());
};

const unmarkedIn = (fake: FakeSmolCloud) =>
  Effect.promise(async () => {
    const { id } = await posted(`${fake.url}/v1/machines`, {
      name: `cbx-${hostId}-someone-else`,
      source: { type: "image", reference: image },
      resources: { cpus: 1, memoryMb: 1024, diskGb: 10 },
    });

    await posted(`${fake.url}/v1/machines/${id}/start`);
    await posted(`${fake.url}/v1/machines/${id}/checkpoints?wait=true`);
  });

runtimeContract({
  name: "smol cloud",
  image,
  sizes: { cpu: 1, ramMib: 1024, diskGib: 10 },
  fixture: Effect.gen(function* () {
    const { dir, fake, settings } = yield* provider;
    const http = stallingHttp();

    const context = yield* Layer.build(
      SmolCloud.layer(
        settings,
        hostConfig(path.join(dir, "state"), undefined, hostId)
      ).pipe(Layer.provide(http.layer), Layer.provide(NodeServices.layer))
    );

    return {
      runtime: Context.get(context, Runtime),
      faults: { ...fake.faults, stall: http.stall },
      unmarked: unmarkedIn(fake),
    };
  }).pipe(provided, Effect.orDie),
});

const onHost = (
  tailnet: Layer.Layer<Tailnet> | Layer.Layer<never> = Layer.empty
) =>
  Effect.gen(function* () {
    const { dir, fake, settings } = yield* provider;

    writeTailscaleStubs(path.join(dir, "provider", "bin"));

    const config = hostConfig(
      path.join(dir, "state"),
      suitePorts.smolCloud,
      hostId
    );

    const context = yield* Layer.build(
      hostLayer(
        config,
        SmolCloud.layer(settings, config),
        loopbackServer()
      ).pipe(
        Layer.provide(tailnet),
        Layer.provide(NodeHttpClient.layerNodeHttp),
        Layer.provide(NodeServices.layer)
      )
    );

    return {
      fake,
      runtime: Context.get(context, Runtime),
      operations: Context.get(context, Operations),
    };
  }).pipe(provided, Effect.orDie);

const sizes = { cpu: 1, ramMib: 1024, diskGib: 10 };

const machineOf = (name: string) => ({
  name,
  instance: Buffer.from(name).toString("hex").padEnd(32, "0"),
  ...sizes,
});

const made = (runtime: Interface, name: string): Effect.Effect<Target> =>
  Effect.gen(function* () {
    const machine = machineOf(name);

    const { handle } = yield* runtime.make(
      machine,
      { _tag: "image", image },
      { _tag: "none" }
    );

    return { name, instance: machine.instance, handle };
  }).pipe(Effect.orDie);

const checkpointOf = (handle: Handle): Target => ({
  name: handle,
  instance: handle,
  handle,
});

const capturing = (lines: string[]) =>
  Logger.make(({ message }) => {
    lines.push(String(message));
  });

const flaky = Effect.gen(function* () {
  const { dir, fake } = yield* provider;
  const api = yield* Api.make(fake.url, Redacted.make(key));
  const failing = { deletes: 0 };

  const runtime = yield* SmolCloud.make(
    { apiKeyFile: "/unused" },
    hostConfig(path.join(dir, "state"), undefined, hostId),
    {
      ...api,
      deleteCheckpoint: (id) =>
        Effect.suspend(() => {
          if (failing.deletes > 0) {
            failing.deletes -= 1;

            return Effect.fail(new Unanswered({ message: "connection reset" }));
          }

          return api.deleteCheckpoint(id);
        }),
    },
    () => {
      throw new Error("no tunnel in this test");
    }
  );

  return { fake, runtime, failing };
}).pipe(Effect.provide(NodeHttpClient.layerNodeHttp), provided);

const answered = (
  runtime: Interface,
  machine: Target,
  argv: readonly string[],
  stdin: string
) =>
  Effect.scoped(
    Effect.flatMap(
      runtime.exec(machine, { argv, stdin }),
      ({ output, exitCode }) =>
        Effect.all([Stream.mkString(Stream.decodeText(output)), exitCode])
    )
  );

const stagedIn = (fake: FakeSmolCloud, machine: Target) => {
  const root = fake.machines.get(machine.handle)?.root ?? "";

  return readdirSync(path.join(root, "dev", "shm"));
};

const untilStaged = (fake: FakeSmolCloud, machine: Target) =>
  Effect.repeat(
    Effect.sync(() => stagedIn(fake, machine).length),
    { until: (count) => count > 0, schedule: Schedule.spaced("5 millis") }
  );

const minting = Layer.succeed(Tailnet, {
  mint: Effect.succeed(Redacted.make("tskey-auth-fake")),
  mintBuild: Effect.succeed(Redacted.make("tskey-auth-fake")),
});

describe("the smol cloud runtime on its host", () => {
  it.live(
    "makes a machine from a base, prepares it, and joins it to the tailnet",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { operations, fake } = yield* onHost(minting);
          const dev = machineOf("dev");

          yield* operations.run({
            id: "make",
            boot: operations.boot,
            scope: { resource: "machine", name: "dev" },
            sequence: 1,
            step: {
              _tag: "make",
              machine: dev,
              source: { _tag: "base", base: "ubuntu" },
              taken: [],
              machines: [],
            },
          });

          const making = yield* operations.wait("make");

          expect(making.status, making.error?.message).toBe("done");

          yield* operations.run({
            id: "join",
            boot: operations.boot,
            scope: { resource: "machine", name: "dev" },
            sequence: 2,
            step: { _tag: "join", machine: dev, hostname: "linux-dev" },
          });

          const joined = yield* operations.wait("join");

          expect(joined.status, joined.error?.message).toBe("done");
          expect(joined.outcome.tailnet?.state).toBe("joined");
          expect(fake.calls.some((call) => call.includes("tskey"))).toBe(false);
        })
      )
  );

  it.live("names each machine for its host and instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, fake } = yield* onHost();
        const dev = yield* made(runtime, "dev");

        expect(fake.machines.get(dev.handle)?.name).toBe(
          `cbx-${hostId}-${dev.instance}`
        );
      })
    )
  );

  it.live("relays bytes both ways through the tunnel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime } = yield* onHost();
        const dev = yield* made(runtime, "dev");

        if (runtime.reach._tag !== "relayed") {
          return yield* Effect.die("smol cloud relays");
        }

        const sent = new TextEncoder().encode("SSH-2.0-client\r\n");

        const back = yield* runtime.reach
          .dial(dev)(Stream.make(sent))
          .pipe(Stream.take(1), Stream.runCollect);

        expect(new TextDecoder().decode(back[0])).toBe("SSH-2.0-client\r\n");
      })
    )
  );

  it.live(
    "a capture whose answer is dropped leaves a checkpoint the machine's next start prunes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, fake } = yield* onHost();
          const dev = yield* made(runtime, "dev");

          yield* fake.faults.dropAnswer("capture");

          const exit = yield* Effect.exit(
            runtime.capture(dev, { name: "snap", instance: "snap-1" })
          );

          expect(Exit.isFailure(exit)).toBe(true);
          expect(fake.checkpoints.size).toBe(1);

          yield* runtime.stop(dev);
          yield* runtime.start(dev, new Set());

          expect(fake.checkpoints.size).toBe(0);
          expect(fake.machines.get(dev.handle)?.state).toBe("started");
        })
      )
  );

  it.live(
    "a sweep deletes a retired machine and spares the rest, the checkpoints it held included",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, operations, fake } = yield* onHost();
          const dev = yield* made(runtime, "dev");
          const kept = yield* made(runtime, "kept");

          const snap = yield* runtime.capture(dev, {
            name: "snap",
            instance: "snap-1",
          });

          const held = yield* runtime.capture(kept, {
            name: "held",
            instance: "held-1",
          });

          yield* operations.sweep({
            machines: [dev.instance],
            checkpoints: [],
          });

          expect([...fake.machines.keys()]).toStrictEqual([kept.handle]);
          expect(new Set(fake.checkpoints.keys())).toStrictEqual(
            new Set([snap, held])
          );
        })
      )
  );

  it.live(
    "a machine restored from a template's copy is found and swept by its name",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, operations, fake } = yield* onHost();
          const builder = yield* made(runtime, "builder");

          const copy = yield* runtime.capture(builder, {
            name: "web-1",
            instance: "web-1",
          });

          const fast = machineOf("fast");

          yield* runtime.make(
            fast,
            {
              _tag: "checkpoint",
              checkpoint: { ...checkpointOf(copy), ...sizes },
            },
            { _tag: "none" }
          );

          const found = yield* runtime.find("machine", fast);

          expect(found).toBeDefined();

          yield* operations.sweep({
            machines: [fast.instance],
            checkpoints: [],
          });

          expect([...fake.machines.keys()]).toStrictEqual([builder.handle]);
          expect(fake.checkpoints.has(copy)).toBe(true);
        })
      )
  );

  it.live(
    "a checkpoint a living restore holds is kept until the restore is deleted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, fake } = yield* onHost();
          const dev = yield* made(runtime, "dev");

          const snap = yield* runtime.capture(dev, {
            name: "snap",
            instance: "snap-1",
          });

          const copy = machineOf("copy");

          const { handle } = yield* runtime.make(
            copy,
            {
              _tag: "checkpoint",
              checkpoint: { ...checkpointOf(snap), ...sizes },
            },
            { _tag: "none" }
          );

          const refused = yield* Effect.flip(
            runtime.deleteCheckpoint(checkpointOf(snap))
          );

          expect(refused._tag).toBe("Conflict");
          expect(fake.checkpoints.has(snap)).toBe(true);

          yield* runtime.delete(
            { name: "copy", instance: copy.instance, handle },
            new Set([snap])
          );
          yield* runtime.deleteCheckpoint(checkpointOf(snap));

          expect(fake.checkpoints.has(snap)).toBe(false);
        })
      )
  );

  it.live(
    "a remove cut short after the machine's delete finishes the checkpoints when sent again",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, fake } = yield* onHost();
          const dev = yield* made(runtime, "dev");

          const kept = yield* runtime.capture(dev, {
            name: "kept",
            instance: "kept-1",
          });

          yield* runtime.pause(dev);
          yield* runtime.start(dev, new Set([kept]));

          expect(
            [...fake.checkpoints.keys()],
            "the pause's own pruned"
          ).toStrictEqual([kept]);

          yield* runtime.capture(dev, { name: "lost", instance: "lost-1" });

          yield* fake.faults.dropAnswer("delete");
          yield* runtime.delete(dev, new Set([kept]));
          yield* runtime.delete(dev, new Set([kept]));

          expect(fake.machines.has(dev.handle)).toBe(false);
          expect([...fake.checkpoints.keys()]).toStrictEqual([kept]);
        })
      )
  );

  it.live(
    "starts a paused machine by resuming it, and stops it the same way",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, fake } = yield* onHost();
          const dev = yield* made(runtime, "dev");

          yield* runtime.pause(dev);
          expect(fake.machines.get(dev.handle)?.state).toBe("paused");

          yield* runtime.stop(dev);
          expect(fake.machines.get(dev.handle)?.state).toBe("stopped");

          yield* runtime.start(dev, new Set());
          yield* runtime.pause(dev);
          yield* runtime.start(dev, new Set());
          expect(fake.machines.get(dev.handle)?.state).toBe("started");
          expect(
            fake.calls.filter((call) => call.endsWith("/resume 200"))
          ).toHaveLength(2);
        })
      )
  );

  it.live(
    "logs a start's prune that fails and leaves the start done, and fails a remove's, which finishes when sent again",
    () => {
      const logged: string[] = [];

      return Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime, failing } = yield* flaky;
          const dev = yield* made(runtime, "dev");

          yield* runtime.pause(dev);

          const [own = ""] = fake.checkpoints.keys();

          failing.deletes = 1;
          yield* runtime.start(dev, new Set());

          expect(fake.machines.get(dev.handle)?.state).toBe("started");
          expect(fake.checkpoints.has(own)).toBe(true);
          expect(logged.join("\n")).toContain(own);

          yield* runtime.start(dev, new Set());
          expect(fake.checkpoints.has(own), "the next start prunes it").toBe(
            false
          );

          const snap = yield* runtime.capture(dev, {
            name: "snap",
            instance: "snap-1",
          });

          failing.deletes = 1;

          const removed = yield* Effect.exit(runtime.delete(dev, new Set()));

          expect(Exit.isFailure(removed), "the remove fails").toBe(true);
          expect(fake.machines.has(dev.handle)).toBe(false);
          expect(fake.checkpoints.has(snap)).toBe(true);

          yield* runtime.delete(dev, new Set());
          expect(fake.checkpoints.has(snap), "sent again, it finishes").toBe(
            false
          );
        })
      ).pipe(Effect.provide(Logger.layer([capturing(logged)])));
    }
  );

  it.live("stages stdin past a MiB on the guest's tmpfs and removes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, fake } = yield* onHost();
        const dev = yield* made(runtime, "dev");
        const stdin = "x".repeat(2 * 1024 * 1024);

        expect(
          yield* answered(runtime, dev, ["wc", "-c"], stdin)
        ).toStrictEqual([`${stdin.length}\n`, 0]);
        expect(
          fake.calls.filter((call) => call.endsWith("/exec/stream 200")).length
        ).toBeGreaterThan(2);
        expect(stagedIn(fake, dev)).toStrictEqual([]);
      })
    )
  );

  it.live(
    "removes staged stdin when its exec is cut short or a chunk fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, fake } = yield* onHost();
          const dev = yield* made(runtime, "dev");
          const stdin = "x".repeat(8 * 1024 * 1024);

          const running = () =>
            Effect.forkChild(
              Effect.scoped(
                Effect.flatMap(
                  runtime.exec(dev, { argv: ["wc", "-c"], stdin }),
                  ({ exitCode }) => exitCode
                )
              )
            );

          const cut = yield* running();

          yield* untilStaged(fake, dev);
          yield* Fiber.interrupt(cut);
          expect(stagedIn(fake, dev), "after an interrupt").toStrictEqual([]);

          const failing = yield* running();

          yield* untilStaged(fake, dev);
          yield* fake.faults.dropAnswer("exec");
          expect(Exit.isFailure(yield* Fiber.await(failing))).toBe(true);
          expect(stagedIn(fake, dev), "after a chunk fails").toStrictEqual([]);
        })
      )
  );

  it.live("counts stdin in bytes, and stages it in whole characters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime } = yield* onHost();
        const dev = yield* made(runtime, "dev");
        const wide = "€".repeat(400_000);
        const astral = `a${"😀".repeat(300_000)}`;

        expect(yield* answered(runtime, dev, ["wc", "-c"], wide)).toStrictEqual(
          [`${Buffer.byteLength(wide)}\n`, 0]
        );
        expect(
          yield* answered(runtime, dev, ["sha256sum"], astral)
        ).toStrictEqual([
          `${createHash("sha256").update(astral).digest("hex")}  -\n`,
          0,
        ]);
      })
    )
  );
});

const ownedBy = (runtime: Interface) =>
  runtime.owned === undefined
    ? Effect.die("the smol cloud runtime lists the machines it owns")
    : runtime.owned.machines;

const onCloud = Effect.gen(function* () {
  const { dir, fake, settings } = yield* provider;

  const context = yield* Layer.build(
    SmolCloud.layer(
      settings,
      hostConfig(path.join(dir, "state"), undefined, hostId)
    ).pipe(
      Layer.provide(NodeHttpClient.layerNodeHttp),
      Layer.provide(NodeServices.layer)
    )
  );

  return { fake, runtime: Context.get(context, Runtime) };
}).pipe(provided, Effect.orDie);

describe("the smol cloud runtime over an account without a card", () => {
  it.live(
    "moves a make past the account's per-machine sizes on as Capacity, and refuses such a resize as unsizable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime } = yield* onCloud;
          const big = { ...machineOf("big"), cpu: 5 };

          yield* runtime.sizable(big, sizes, big, false);

          const refused = yield* Effect.flip(
            runtime.make(big, { _tag: "image", image }, { _tag: "none" })
          );

          expect(refused).toMatchObject({ _tag: "Capacity" });
          expect(refused.message).toContain("up to 4 vCPU");

          const dev = yield* made(runtime, "dev");

          expect(
            yield* Effect.flip(
              runtime.resize(
                { ...dev, ...sizes },
                { cpu: 1, ramMib: 17 * 1024, diskGib: 10 },
                true
              )
            )
          ).toMatchObject({ _tag: "Unsizable" });
        })
      )
  );

  it.live(
    "reads its capacity as running machines and machines kept against the account's limits, and CPUs and RAM in use",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime } = yield* onCloud;

          yield* made(runtime, "dev");

          expect(yield* runtime.capacity([])).toStrictEqual([
            { resource: "runningMachines", used: 1, limit: 4 },
            { resource: "machines", used: 1, limit: 20 },
            { resource: "cpu", used: 1 },
            { resource: "ramMib", used: 1024 },
          ]);
        })
      )
  );

  it.live(
    "skips a machine record it can't read unless its name carries this host's mark, and logs it once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const lines: string[] = [];
          const dev = yield* made(runtime, "dev");

          yield* fake.malformedMachine("someone-elses");

          const listed = yield* Effect.andThen(
            ownedBy(runtime),
            ownedBy(runtime)
          ).pipe(Effect.provide(Logger.layer([capturing(lines)])));

          expect(listed.map(({ handle }) => handle)).toStrictEqual([
            dev.handle,
          ]);
          expect(
            lines.filter((line) =>
              line.includes("couldn't be read and isn't this host's")
            )
          ).toHaveLength(1);

          yield* fake.malformedMachine(`cbx-${hostId}-${"ab".repeat(16)}`);

          expect((yield* Effect.flip(ownedBy(runtime))).message).toContain(
            `cbx-${hostId}-${"ab".repeat(16)}`
          );
        })
      )
  );

  it.live(
    "fails a search when its own machine's record has an id it can't read, says whose, and asks no list again",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = machineOf("dev");

          yield* fake.malformedMachine(`cbx-${hostId}-${dev.instance}`, 7);

          const failed = yield* Effect.flip(runtime.find("machine", dev));

          expect(failed.message).toContain(`cbx-${hostId}-${dev.instance}`);
          expect(
            fake.calls.filter((call) => call === "GET /v1/machines 200")
          ).toHaveLength(1);
        })
      )
  );

  it.live(
    "an exec its caller cuts short leaves its command running, as smol cloud does, until a stop ends it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");
          const root = fake.machines.get(dev.handle)?.root ?? "";

          expect(
            yield* cutAndLeftRunning(runtime, dev, root, runtime.stop(dev))
          ).toBe("0");
        })
      ),
    20_000
  );

  for (const [ending, end] of [
    ["stop", (runtime: Interface, dev: Target) => runtime.stop(dev)],
    [
      "delete",
      (runtime: Interface, dev: Target) => runtime.delete(dev, new Set()),
    ],
  ] as const) {
    it.live(
      `a ${ending} ends what an exec left running in the background once it ended`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { fake, runtime } = yield* onCloud;
            const dev = yield* made(runtime, "dev");
            const root = fake.machines.get(dev.handle)?.root ?? "";
            const pid = yield* leftInTheBackground(runtime, dev, root);

            yield* end(runtime, dev);
            yield* gone(pid);

            expect(holdsPid(pid)).toBe(false);
          })
        ),
      20_000
    );
  }

  it.live(
    "the fake's end ends what an exec left running in the background",
    () =>
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const { fake, runtime } = yield* onCloud;
            const dev = yield* made(runtime, "dev");

            return yield* leftInTheBackground(
              runtime,
              dev,
              fake.machines.get(dev.handle)?.root ?? ""
            );
          })
        );

        yield* gone(pid);

        expect(holdsPid(pid)).toBe(false);
      }),
    20_000
  );

  it.live(
    "a delete of a machine whose fork lives stops it, fails naming the fork with one DELETE a try and one warning, and is done once the fork is gone",
    () => {
      const logged: string[] = [];

      return Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");

          yield* runtime.start(dev, new Set());

          const twin = machineOf("twin");

          const { handle } = yield* runtime.make(
            twin,
            { _tag: "machine", machine: { ...dev, ...sizes } },
            { _tag: "none" }
          );

          const deletes = () =>
            fake.calls.filter((call) =>
              call.startsWith(`DELETE /v1/machines/${dev.handle} `)
            ).length;

          const refused = yield* Effect.flip(runtime.delete(dev, new Set()));

          expect(refused.message).toContain("while a fork of it lives: twin.");
          expect(refused.message).not.toContain(`cbx-${hostId}-`);
          expect(fake.machines.get(dev.handle)?.state).toBe("stopped");
          expect(fake.machines.get(handle)?.state).toBe("started");
          expect(deletes()).toBe(1);

          yield* Effect.flip(runtime.delete(dev, new Set()));

          expect(deletes()).toBe(2);
          expect(
            logged.filter((line) => line.includes("a fork of it lives: twin."))
          ).toHaveLength(1);

          yield* runtime.delete(
            { name: "twin", instance: twin.instance, handle },
            new Set()
          );
          yield* runtime.delete(dev, new Set());

          expect([...fake.machines.keys()]).toStrictEqual([]);
        })
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ message, logLevel }) => {
              if (logLevel === "Warn") {
                logged.push(String(message));
              }
            }),
          ])
        )
      );
    }
  );

  it.live(
    "a delete whose machine went but whose unkept checkpoint smol cloud keeps fails, and is done once nothing holds it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");

          yield* runtime.start(dev, new Set());

          const { id } = yield* Effect.promise(
            async () =>
              await posted(
                `${fake.url}/v1/machines/${dev.handle}/checkpoints?wait=true`
              )
          );

          yield* Effect.repeat(
            Effect.sync(() => fake.checkpoints.get(id)?.status),
            {
              until: (status) => status === "available",
              schedule: Schedule.spaced("20 millis"),
            }
          );

          const restored = yield* Effect.promise(
            async () =>
              await posted(`${fake.url}/v1/checkpoints/${id}/restore`, {
                name: "someone-elses-restore",
              })
          );

          const refused = yield* Effect.flip(runtime.delete(dev, new Set()));

          expect(fake.machines.has(dev.handle)).toBe(false);
          expect(fake.checkpoints.has(id)).toBe(true);
          expect(refused.message).toContain(id);

          yield* Effect.promise(
            async () =>
              await fetch(`${fake.url}/v1/machines/${restored.id}`, {
                method: "DELETE",
                headers: { authorization: `Bearer ${key}` },
              })
          );
          yield* runtime.delete(dev, new Set());

          expect(fake.checkpoints.has(id)).toBe(false);
        })
      )
  );

  it.live(
    "a resize whose request was lost sends it again until smol cloud holds the sizes asked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");

          yield* fake.faults.loseResize(2);
          yield* runtime.resize(
            { ...dev, ...sizes },
            { cpu: 1, ramMib: 2048, diskGib: 10 },
            true
          );

          expect(fake.machines.get(dev.handle)?.memoryMb).toBe(2048);
        })
      )
  );

  it.live(
    "a resize whose every request is lost fails after three, and says the sizes smol cloud holds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");

          yield* fake.faults.loseResize(3);

          const failed = yield* Effect.flip(
            runtime.resize(
              { ...dev, ...sizes },
              { cpu: 1, ramMib: 2048, diskGib: 10 },
              true
            )
          );

          expect(failed._tag).toBe("Internal");
          expect(failed.message).toContain("answered none of 3 resizes");
          expect(fake.machines.get(dev.handle)?.memoryMb).not.toBe(2048);
        })
      )
  );

  it.live(
    "a resize whose request was lost while the machine starts reads it until it rests, and only then sends it again",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");

          yield* runtime.stop(dev);

          const settle = yield* fake.faults.holdStarts;

          yield* fake.faults.loseResize(1);

          const creating = Effect.repeat(
            Effect.sync(() => fake.machines.get(dev.handle)?.state),
            {
              until: (state) => state === "creating",
              schedule: Schedule.spaced("20 millis"),
            }
          );

          const resizeLost = Effect.repeat(
            Effect.sync(() =>
              fake.calls.some((call) =>
                call.startsWith(`POST /v1/machines/${dev.handle}/resize`)
              )
            ),
            { until: (sent) => sent, schedule: Schedule.spaced("20 millis") }
          );

          yield* Effect.all(
            [
              runtime.start(dev, new Set()),
              Effect.andThen(
                creating,
                Effect.all(
                  [
                    runtime.resize(
                      { ...dev, ...sizes },
                      { cpu: 1, ramMib: 2048, diskGib: 10 },
                      true
                    ),
                    Effect.andThen(resizeLost, settle),
                  ],
                  { concurrency: 2 }
                )
              ),
            ],
            { concurrency: 2 }
          );

          expect([
            fake.machines.get(dev.handle)?.state,
            fake.machines.get(dev.handle)?.memoryMb,
          ]).toStrictEqual(["started", 2048]);
        })
      )
  );

  it.live(
    "a resize whose answer was lost reads the machine, and ends done when it holds the sizes asked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");

          yield* fake.faults.dropAnswer("resize");
          yield* runtime.resize(
            { ...dev, ...sizes },
            { cpu: 1, ramMib: 2048, diskGib: 10 },
            true
          );

          expect(fake.machines.get(dev.handle)?.memoryMb).toBe(2048);
        })
      )
  );

  it.live(
    "keeps each exec's request body within the provider's MiB, counted as JSON encodes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime } = yield* onCloud;
          const dev = yield* made(runtime, "dev");

          for (const stdin of [
            "\u0001".repeat(200 * 1024),
            '"'.repeat(600 * 1024),
          ]) {
            expect(
              yield* answered(runtime, dev, ["wc", "-c"], stdin)
            ).toStrictEqual([`${Buffer.byteLength(stdin)}\n`, 0]);
          }
        })
      )
  );
});

interface Failing {
  readonly account?: {
    answeredFirst?: number;
    times: number;
    readonly answer: "gateway" | "refused";
  };
  readonly create?: string;
  readonly inUse?: { readonly machines: number; readonly started: number };
}

const scripted = (
  creates: { busy: number },
  state: string,
  stalls?: string,
  failing?: Failing
) =>
  HttpClient.make((request, url) =>
    `${request.method} ${url.pathname}` === stalls
      ? Effect.never
      : Effect.sync(() => {
          const route = `${request.method} ${url.pathname}`;

          const reply = (status: number, body: unknown, retryAfter?: string) =>
            HttpClientResponse.fromWeb(
              request,
              Response.json(body, {
                status,
                headers:
                  retryAfter === undefined ? {} : { "retry-after": retryAfter },
              })
            );

          const record = {
            id: "mach-1",
            name: `cbx-${hostId}-${machineOf("dev").instance}`,
            state,
            resources: { cpus: 1, memoryMb: 1024 },
            createdAt: "2026-11-13T00:00:00Z",
          };

          if (
            route === "GET /v1/account" &&
            (failing?.account?.times ?? 0) > 0 &&
            (failing?.account?.answeredFirst ?? 0) === 0
          ) {
            if (failing?.account !== undefined) {
              failing.account.times -= 1;
            }

            return failing?.account?.answer === "gateway"
              ? HttpClientResponse.fromWeb(
                  request,
                  new Response("<html>bad gateway</html>", { status: 502 })
                )
              : reply(500, {
                  code: "internal",
                  detail: "the account store failed",
                  retryable: false,
                  status: 500,
                });
          }

          if (route === "GET /v1/account") {
            if (failing?.account?.answeredFirst !== undefined) {
              failing.account.answeredFirst = Math.max(
                0,
                failing.account.answeredFirst - 1
              );
            }

            return reply(200, {
              plan: { allowAlwaysOn: false },
              effectiveMaxMachines: 20,
              effectiveMaxConcurrentMachines: 4,
              effectiveMaxCpus: 4,
              effectiveMaxMemoryMb: 16_384,
              effectiveMaxDiskGb: 200,
            });
          }

          if (route === "POST /v1/machines" && failing?.create !== undefined) {
            return reply(422, {
              code: "unprocessable",
              detail: failing.create,
              retryable: false,
              status: 422,
            });
          }

          if (route === "POST /v1/machines") {
            if (creates.busy > 0) {
              creates.busy -= 1;

              return reply(
                503,
                {
                  code: "insufficient_capacity",
                  detail: "",
                  retryable: true,
                  status: 503,
                },
                "86400"
              );
            }

            return reply(201, record);
          }

          if (route === "GET /v1/machines") {
            return reply(200, []);
          }

          if (route === "GET /v1/checkpoints") {
            return reply(200, []);
          }

          if (route === "GET /v1/capacity") {
            return reply(200, {
              machines: failing?.inUse?.machines ?? 0,
              startedMachines: failing?.inUse?.started ?? 0,
              startedMemoryMb: 0,
            });
          }

          return reply(200, record);
        })
  );

const scriptedRuntime = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const api = yield* Api.make("https://smol.test", Redacted.make(key)).pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    );

    return yield* SmolCloud.make(
      { apiKeyFile: "/unused" },
      hostConfig("/unused", undefined, hostId),
      api,
      () => {
        throw new Error("no tunnel in a scripted provider");
      }
    );
  });

const scriptedMake = (busy: number, state = "starting") =>
  Effect.gen(function* () {
    const runtime = yield* scriptedRuntime(scripted({ busy }, state));

    return yield* Effect.forkChild(
      runtime.make(machineOf("dev"), { _tag: "image", image }, { _tag: "none" })
    );
  });

describe("a smol cloud make's read of the account", () => {
  it.effect(
    "reads the account again after a gateway's 502, and makes the machine",
    () =>
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime(
          scripted({ busy: 0 }, "started", undefined, {
            account: { times: 1, answer: "gateway" },
          })
        );

        const making = yield* Effect.forkChild(
          runtime.make(
            machineOf("dev"),
            { _tag: "image", image },
            { _tag: "none" }
          )
        );

        yield* TestClock.adjust("1 minute");

        const ended = making.pollUnsafe();

        expect(
          ended !== undefined && Exit.isSuccess(ended),
          "made within a minute"
        ).toBe(true);
      })
  );

  it.effect(
    "keeps no failed read, so a make after a refused one reads it afresh",
    () =>
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime(
          scripted({ busy: 0 }, "started", undefined, {
            account: { times: 1, answer: "refused" },
          })
        );

        const make = runtime.make(
          machineOf("dev"),
          { _tag: "image", image },
          { _tag: "none" }
        );

        expect(Exit.isFailure(yield* Effect.exit(make))).toBe(true);

        const again = yield* Effect.forkChild(make);

        yield* TestClock.adjust("1 minute");

        const ended = again.pollUnsafe();

        expect(
          ended !== undefined && Exit.isSuccess(ended),
          "the second made within a minute"
        ).toBe(true);
      })
  );
});

const refusedCreate = (detail: string, failing: Omit<Failing, "create"> = {}) =>
  Effect.flatMap(
    scriptedRuntime(
      scripted({ busy: 0 }, "started", undefined, {
        ...failing,
        create: detail,
      })
    ),
    (runtime) =>
      Effect.flip(
        runtime.make(
          machineOf("dev"),
          { _tag: "image", image },
          { _tag: "none" }
        )
      )
  );

const concurrency =
  "concurrency limit reached: an account without a card can run 4 machines at once; add a card at https://smolmachines.com/console/usage to run up to your plan's limit";

describe("a smol cloud create the provider refuses 422", () => {
  it.effect(
    "is Capacity when the account holds what its limits allow, whatever the words",
    () =>
      Effect.gen(function* () {
        expect(
          yield* refusedCreate(concurrency, {
            inUse: { machines: 4, started: 4 },
          })
        ).toMatchObject({ _tag: "Capacity" });
        expect(
          yield* refusedCreate(
            "machine count exceeds what an account without a card can keep: 20",
            { inUse: { machines: 20, started: 0 } }
          )
        ).toMatchObject({ _tag: "Capacity" });
      })
  );

  it.effect(
    "is Internal when the account is within its limits, or its limits can't be read",
    () =>
      Effect.gen(function* () {
        expect(
          yield* refusedCreate(concurrency, {
            inUse: { machines: 1, started: 1 },
          })
        ).toMatchObject({ _tag: "Internal" });
        expect(
          yield* refusedCreate("ttlSeconds exceeds the maximum of 86400")
        ).toMatchObject({ _tag: "Internal" });

        const unread = yield* refusedCreate(
          "resources.cpus: expected integer",
          {
            inUse: { machines: 4, started: 4 },
            account: { answeredFirst: 1, times: 5, answer: "refused" },
          }
        );

        expect(unread).toMatchObject({ _tag: "Internal" });
        expect(unread.message).toContain("expected integer");
      })
  );
});

describe("a smol cloud delete", () => {
  it.effect("ends on a record the provider reads as deleted", () =>
    Effect.gen(function* () {
      const runtime = yield* scriptedRuntime(scripted({ busy: 0 }, "deleted"));

      const deleting = yield* Effect.forkChild(
        runtime.delete(
          {
            name: "dev",
            instance: machineOf("dev").instance,
            handle: Handle.make("mach-1"),
          },
          new Set()
        )
      );

      yield* TestClock.adjust("1 minute");

      const ended = deleting.pollUnsafe();

      expect(
        ended !== undefined && Exit.isSuccess(ended),
        "deleted within a minute"
      ).toBe(true);
    })
  );
});

const recordIn = (state: string | undefined) => ({
  id: "mach-1",
  name: `cbx-${hostId}-${machineOf("dev").instance}`,
  state,
  resources: { cpus: 1, memoryMb: 1024 },
});

const acting = (machine: { state: string | undefined; refusals: number }) =>
  HttpClient.make((request, url) =>
    Effect.sync(() => {
      const route = `${request.method} ${url.pathname}`;

      const reply = (status: number, body: unknown) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));

      if (route === "POST /v1/machines/mach-1/start") {
        if (machine.refusals > 0) {
          machine.refusals -= 1;

          return reply(409, {
            code: "conflict",
            detail: "machine is locked by an operation",
            retryable: false,
            status: 409,
          });
        }

        machine.state = "started";

        return reply(200, recordIn(machine.state));
      }

      if (route === "GET /v1/machines/mach-1") {
        return machine.state === undefined
          ? reply(404, {
              code: "not_found",
              detail: "no machine",
              retryable: false,
              status: 404,
            })
          : reply(200, recordIn(machine.state));
      }

      return reply(200, []);
    })
  );

const started = (machine: { state: string | undefined; refusals: number }) =>
  Effect.gen(function* () {
    const runtime = yield* scriptedRuntime(acting(machine));

    const starting = yield* Effect.forkChild(
      runtime.start(
        {
          name: "dev",
          instance: machineOf("dev").instance,
          handle: Handle.make("mach-1"),
        },
        new Set()
      )
    );

    yield* TestClock.adjust("1 minute");

    return starting.pollUnsafe();
  });

describe("a smol cloud start", () => {
  it.effect(
    "refused 409 while the machine stays where it was fails within a minute with the provider's reason",
    () =>
      Effect.gen(function* () {
        const ended = yield* started({
          state: "stopped",
          refusals: Number.POSITIVE_INFINITY,
        });

        const failed =
          ended !== undefined && Exit.isFailure(ended)
            ? Cause.squash(ended.cause)
            : undefined;

        expect(failed, "ended within a minute").toMatchObject({
          _tag: "WrongState",
        });
        expect(String(failed)).toContain("locked by an operation");
      })
  );

  it.effect("refused 409 twice, then taken, runs the machine", () =>
    Effect.gen(function* () {
      const ended = yield* started({ state: "stopped", refusals: 2 });

      expect(ended !== undefined && Exit.isSuccess(ended)).toBe(true);
    })
  );

  it.effect("of a machine the provider answers 404 is Missing", () =>
    Effect.gen(function* () {
      const ended = yield* started({ state: undefined, refusals: 0 });

      expect(
        ended !== undefined &&
          Exit.isFailure(ended) &&
          Cause.squash(ended.cause)
      ).toMatchObject({ _tag: "Missing", machine: "dev" });
    })
  );
});

const smolAccount = {
  plan: { allowAlwaysOn: false },
  effectiveMaxMachines: 20,
  effectiveMaxConcurrentMachines: 4,
  effectiveMaxCpus: 4,
  effectiveMaxMemoryMb: 16_384,
  effectiveMaxDiskGb: 200,
};

const answering = (answer: (route: string) => Response | undefined) => {
  const asked: string[] = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const route = `${request.method} ${url.pathname}`;

      asked.push(route);

      return HttpClientResponse.fromWeb(
        request,
        answer(route) ??
          (route === "GET /v1/account"
            ? Response.json(smolAccount)
            : Response.json(
                {
                  code: "not_found",
                  detail: "no route",
                  retryable: false,
                  status: 404,
                },
                { status: 404 }
              ))
      );
    })
  );

  return { asked, client };
};

const asks = (asked: readonly string[], route: string) =>
  asked.filter((each) => each === route).length;

const dev1 = {
  name: "dev",
  instance: machineOf("dev").instance,
  handle: Handle.make("mach-1"),
};

const endedWithin = <A, E>(
  effect: Effect.Effect<A, E>,
  within: Duration.Input
) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkChild(effect);

    yield* TestClock.adjust(within);

    return running.pollUnsafe();
  });

const failureOf = <A, E>(ended: Exit.Exit<A, E> | undefined) =>
  ended !== undefined && Exit.isFailure(ended)
    ? Cause.squash(ended.cause)
    : undefined;

describe("a smol cloud delete of a machine on its way", () => {
  it.effect("waits while the machine moves, and deletes it once it rests", () =>
    Effect.gen(function* () {
      let reads = 0;
      let deleted = false;

      const { asked, client } = answering((route) => {
        if (route === "GET /v1/machines/mach-1") {
          reads += 1;

          return deleted
            ? Response.json(
                { code: "not_found", detail: "no machine", status: 404 },
                { status: 404 }
              )
            : Response.json(recordIn(reads < 6 ? "stopping" : "stopped"));
        }

        if (route === "DELETE /v1/machines/mach-1") {
          if (reads < 6) {
            return Response.json(
              { code: "conflict", detail: "machine is stopping", status: 409 },
              { status: 409 }
            );
          }

          deleted = true;

          return new Response(null, { status: 204 });
        }

        return route === "GET /v1/checkpoints" ? Response.json([]) : undefined;
      });

      const runtime = yield* scriptedRuntime(client);

      const ended = yield* endedWithin(
        runtime.delete(dev1, new Set()),
        "1 minute"
      );

      expect(
        ended !== undefined && Exit.isSuccess(ended),
        String(failureOf(ended))
      ).toBe(true);
      expect(
        asked.filter((route) => route === "DELETE /v1/machines/mach-1")
      ).toHaveLength(1);
    })
  );
});

describe("a smol cloud answer a gateway gives", () => {
  it.effect(
    "is a 5xx whose JSON body is no problem of the provider's, or one of another status, a lost answer, so the create is looked for by its name",
    () =>
      Effect.gen(function* () {
        const gateways = [
          [502, { message: "Internal server error" }],
          [500, { message: "Internal server error" }],
          [
            502,
            {
              code: "invalid_request",
              detail: "an upstream's",
              retryable: false,
              status: 400,
            },
          ],
        ] as const;

        for (const [status, body] of gateways) {
          let landed = false;

          const { asked, client } = answering((route) => {
            if (route === "POST /v1/machines") {
              landed = true;

              return Response.json(body, { status });
            }

            if (route === "GET /v1/machines") {
              return Response.json(landed ? [recordIn("stopped")] : []);
            }

            if (route === "POST /v1/machines/mach-1/start") {
              return Response.json(recordIn("started"));
            }

            return route === "GET /v1/machines/mach-1"
              ? Response.json(recordIn("started"))
              : undefined;
          });

          const runtime = yield* scriptedRuntime(client);

          const ended = yield* endedWithin(
            runtime.make(
              machineOf("dev"),
              { _tag: "image", image },
              { _tag: "none" }
            ),
            "1 minute"
          );

          const answer = `${status} ${JSON.stringify(body)}`;

          expect(
            ended !== undefined && Exit.isSuccess(ended),
            `${answer}: ${String(failureOf(ended))}`
          ).toBe(true);
          expect(asks(asked, "POST /v1/machines"), answer).toBe(1);
        }
      })
  );
});

describe("a smol cloud create whose every answer is lost", () => {
  it.effect(
    "is sent five times in all, each looked for by its name a poll after, then fails",
    () =>
      Effect.gen(function* () {
        const { asked, client } = answering((route) => {
          if (route === "POST /v1/machines") {
            return new Response("bad gateway", { status: 502 });
          }

          return route === "GET /v1/machines" ? Response.json([]) : undefined;
        });

        const runtime = yield* scriptedRuntime(client);

        const making = yield* Effect.forkChild(
          runtime.make(
            machineOf("dev"),
            { _tag: "image", image },
            { _tag: "none" }
          )
        );

        yield* TestClock.adjust("900 millis");

        const early = [
          asks(asked, "POST /v1/machines"),
          asks(asked, "GET /v1/machines"),
        ];

        yield* TestClock.adjust("5 minutes");

        const ended = making.pollUnsafe();

        expect(failureOf(ended), "ended within 5 minutes").toMatchObject({
          _tag: "Internal",
        });
        expect([
          early,
          asks(asked, "POST /v1/machines"),
          asks(asked, "GET /v1/machines"),
        ]).toStrictEqual([[1, 0], 5, 5]);
      })
  );
});

describe("a smol cloud refusal while the machine moves between states", () => {
  it.effect(
    "counts toward its standing only while the machine stays in one, so a start refused four times across changes runs the machine",
    () =>
      Effect.gen(function* () {
        let refusals = 4;
        let state = "stopped";

        const { asked, client } = answering((route) => {
          if (route === "POST /v1/machines/mach-1/start") {
            if (refusals > 0) {
              refusals -= 1;
              state = state === "stopped" ? "created" : "stopped";

              return Response.json(
                {
                  code: "conflict",
                  detail: "machine is locked by an operation",
                  retryable: false,
                  status: 409,
                },
                { status: 409 }
              );
            }

            state = "started";

            return Response.json(recordIn(state));
          }

          if (route === "GET /v1/machines/mach-1") {
            return Response.json(recordIn(state));
          }

          return route === "GET /v1/checkpoints"
            ? Response.json([])
            : undefined;
        });

        const runtime = yield* scriptedRuntime(client);

        const ended = yield* endedWithin(
          runtime.start(dev1, new Set()),
          "5 minutes"
        );

        expect(
          ended !== undefined && Exit.isSuccess(ended),
          String(failureOf(ended))
        ).toBe(true);
        expect(
          asked.filter((route) => route === "POST /v1/machines/mach-1/start")
        ).toHaveLength(5);
      })
  );
});

describe("a smol cloud 429", () => {
  it.effect("is waited as its Retry-After asks, and the call sent again", () =>
    Effect.gen(function* () {
      let throttled = 1;
      let state = "stopped";

      const { asked, client } = answering((route) => {
        if (route === "POST /v1/machines/mach-1/start") {
          if (throttled > 0) {
            throttled -= 1;

            return new Response("slow down", {
              status: 429,
              headers: { "retry-after": "2" },
            });
          }

          state = "started";

          return Response.json(recordIn(state));
        }

        if (route === "GET /v1/checkpoints") {
          return Response.json([]);
        }

        return route === "GET /v1/machines/mach-1"
          ? Response.json(recordIn(state))
          : undefined;
      });

      const runtime = yield* scriptedRuntime(client);
      const starting = yield* Effect.forkChild(runtime.start(dev1, new Set()));

      const starts = () =>
        asked.filter((route) => route === "POST /v1/machines/mach-1/start");

      yield* TestClock.adjust("1 second");
      expect(starts()).toHaveLength(1);

      yield* TestClock.adjust("1 minute");

      const ended = starting.pollUnsafe();

      expect(
        ended !== undefined && Exit.isSuccess(ended),
        String(failureOf(ended))
      ).toBe(true);
      expect(starts()).toHaveLength(2);
    })
  );
});

describe("a smol cloud step's deadline", () => {
  it.effect(
    "ends a read of the account the provider never answers, failed Internal",
    () =>
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime(
          scripted({ busy: 0 }, "started", "GET /v1/account")
        );

        const reading = yield* Effect.forkChild(runtime.capacity([]));

        yield* TestClock.adjust("10 minutes");

        const ended = reading.pollUnsafe();

        expect(ended, "ended within 10 minutes").toBeDefined();
        expect(
          ended !== undefined &&
            Exit.isFailure(ended) &&
            Cause.squash(ended.cause)
        ).toMatchObject({ _tag: "Internal" });
      })
  );

  it.effect(
    "waits at most 30 seconds when the provider asks to retry a day later",
    () =>
      Effect.gen(function* () {
        const making = yield* scriptedMake(1, "started");

        yield* TestClock.adjust("1 minute");

        const ended = making.pollUnsafe();

        expect(
          ended !== undefined && Exit.isSuccess(ended),
          "made within a minute"
        ).toBe(true);
      })
  );

  it.effect(
    "bounds a make the provider keeps asking to retry a day later",
    () =>
      Effect.gen(function* () {
        const making = yield* scriptedMake(Number.POSITIVE_INFINITY);

        yield* TestClock.adjust("10 minutes");
        expect(making.pollUnsafe(), "ended within 10 minutes").toBeDefined();
      })
  );

  it.effect(
    "ends a make whose retries ran and whose machine never starts in 10 minutes, failed Internal",
    () =>
      Effect.gen(function* () {
        const making = yield* scriptedMake(3);

        yield* TestClock.adjust("10 minutes");

        const ended = making.pollUnsafe();

        expect(ended, "ended within 10 minutes").toBeDefined();
        expect(
          ended !== undefined &&
            Exit.isFailure(ended) &&
            Cause.squash(ended.cause)
        ).toMatchObject({ _tag: "Internal" });
      })
  );
});

const planted = "PLANTED-TOKEN-7f3a";

const problem = (status: number, detail: string, retryable = false) =>
  Response.json(
    {
      code: status === 409 ? "conflict" : "internal",
      detail,
      retryable,
      status,
    },
    { status }
  );

describe("a smol cloud create refused 409", () => {
  it.effect(
    "fails at its one send when no machine of its name is listed, as it took nothing",
    () =>
      Effect.gen(function* () {
        const { asked, client } = answering((route) => {
          if (route === "POST /v1/machines") {
            return problem(409, "a machine of this name is being deleted");
          }

          return route === "GET /v1/machines" ? Response.json([]) : undefined;
        });

        const runtime = yield* scriptedRuntime(client);

        const ended = yield* endedWithin(
          runtime.make(
            machineOf("dev"),
            { _tag: "image", image },
            { _tag: "none" }
          ),
          "5 minutes"
        );

        expect(failureOf(ended)).toMatchObject({ _tag: "Internal" });
        expect(asks(asked, "POST /v1/machines")).toBe(1);
      })
  );
});

describe("what a smol cloud answer puts in a log or an error", () => {
  it.effect(
    "names a listed record the host can't read by its name or ID, or as one with neither, and quotes nothing of its body",
    () =>
      Effect.gen(function* () {
        const logged: string[] = [];

        const { client } = answering((route) =>
          route === "GET /v1/machines"
            ? Response.json([
                recordIn("started"),
                { secretEnv: { API_TOKEN: planted } },
                { id: 7, state: 3, secret: planted },
                { name: "someone-else", state: null, secret: planted },
              ])
            : undefined
        );

        const runtime = yield* scriptedRuntime(client);

        yield* runtime
          .observe([
            dev1,
            { ...dev1, name: "other", handle: Handle.make("mach-2") },
          ])
          .pipe(Effect.provide(Logger.layer([capturing(logged)])));

        expect(logged.filter((line) => line.includes(planted))).toStrictEqual(
          []
        );
        expect(logged.map((line) => line.split(", which")[0])).toStrictEqual([
          "GET /v1/machines answered machine a record with no name or ID",
          "GET /v1/machines answered machine someone-else",
        ]);
      })
  );

  it.effect("fails an exec whose exit it can't read without quoting it", () =>
    Effect.gen(function* () {
      const { client } = answering((route) =>
        route === "POST /v1/machines/mach-1/exec/stream"
          ? new Response(`event: exit\ndata: ${planted}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : undefined
      );

      const runtime = yield* scriptedRuntime(client);

      const failed = yield* Effect.flip(
        Effect.scoped(
          Effect.flatMap(runtime.exec(dev1, { argv: ["true"] }), (execution) =>
            Effect.andThen(
              Stream.runDrain(execution.output),
              execution.exitCode
            )
          )
        )
      );

      expect(failed).toMatchObject({ _tag: "Internal" });
      expect(failed.message).not.toContain(planted);
    })
  );
});

describe("a smol cloud act or delete whose every answer is lost", () => {
  it.effect(
    "is sent three times in all, the machine read between, then fails naming what smol cloud holds",
    () =>
      Effect.gen(function* () {
        const steps = [
          [
            "start",
            "stopped",
            (runtime: Interface) => runtime.start(dev1, new Set()),
          ],
          ["stop", "started", (runtime: Interface) => runtime.stop(dev1)],
          ["pause", "started", (runtime: Interface) => runtime.pause(dev1)],
          [
            "delete",
            "stopped",
            (runtime: Interface) => runtime.delete(dev1, new Set()),
          ],
        ] as const;

        for (const [verb, state, step] of steps) {
          const sent =
            verb === "delete"
              ? "DELETE /v1/machines/mach-1"
              : `POST /v1/machines/mach-1/${verb}`;

          const { asked, client } = answering((route) => {
            if (route === sent) {
              return new Response("<html>bad gateway</html>", { status: 502 });
            }

            if (route === "GET /v1/machines/mach-1") {
              return Response.json(recordIn(state));
            }

            return route === "GET /v1/checkpoints" ||
              route === "GET /v1/machines"
              ? Response.json([])
              : undefined;
          });

          const runtime = yield* scriptedRuntime(client);
          const ended = yield* endedWithin(step(runtime), "10 minutes");

          expect(failureOf(ended), verb).toMatchObject({ _tag: "Internal" });
          expect(String(failureOf(ended)), verb).toContain(
            `none of 3 ${verb}s`
          );
          expect(asks(asked, sent), verb).toBe(3);
        }
      })
  );
});

const forkOf = (state: string) => ({
  id: "mach-2",
  name: `cbx-${hostId}-${machineOf("twin").instance}`,
  state,
  parentMachineId: "mach-1",
  resources: { cpus: 1, memoryMb: 1024 },
});

describe("a smol cloud delete a live fork holds", () => {
  it.effect(
    "stands at the first refusal and stops the source, whether or not the refusal says it may be retried",
    () =>
      Effect.gen(function* () {
        for (const [retryable, source] of [
          [false, "started"],
          [true, "running"],
        ] as const) {
          let state: string = source;

          const { asked, client } = answering((route) => {
            if (route === "DELETE /v1/machines/mach-1") {
              return problem(
                409,
                "checkpoint has 1 live branch; delete its branches before deleting it",
                retryable
              );
            }

            if (route === "POST /v1/machines/mach-1/stop") {
              state = "stopped";

              return Response.json(recordIn(state));
            }

            if (route === "GET /v1/machines/mach-1") {
              return Response.json(recordIn(state));
            }

            return route === "GET /v1/machines"
              ? Response.json([recordIn(state), forkOf("started")])
              : undefined;
          });

          const runtime = yield* scriptedRuntime(client);

          const ended = yield* endedWithin(
            runtime.delete(dev1, new Set()),
            "1 minute"
          );

          expect(
            failureOf(ended),
            `${source}, retryable ${retryable}`
          ).toMatchObject({
            _tag: "Internal",
          });
          expect([
            asks(asked, "DELETE /v1/machines/mach-1"),
            asks(asked, "POST /v1/machines/mach-1/stop"),
            state,
          ]).toStrictEqual([1, 1, "stopped"]);

          const checked = asked.length;

          yield* endedWithin(runtime.delete(dev1, new Set()), "1 minute");

          expect(asked.slice(checked)).toStrictEqual([
            "GET /v1/machines/mach-1",
            "DELETE /v1/machines/mach-1",
            "GET /v1/machines",
            "GET /v1/machines/mach-1",
          ]);
        }
      })
  );

  it.effect(
    "names a fork as clankerbox does once the host was handed it, by smol cloud's name before, and a branch made by hand by its own",
    () =>
      Effect.gen(function* () {
        const twin = machineOf("twin");

        const byHand = {
          id: "mach-3",
          name: "by-hand",
          state: "started",
          parentMachineId: "mach-1",
          resources: { cpus: 1, memoryMb: 1024 },
        };

        const { client } = answering((route) => {
          if (route === "DELETE /v1/machines/mach-1") {
            return problem(
              409,
              "checkpoint has 1 live branch; delete its branches before deleting it"
            );
          }

          if (route === "GET /v1/machines/mach-1") {
            return Response.json(recordIn("stopped"));
          }

          if (route === "GET /v1/machines/mach-2") {
            return Response.json(forkOf("started"));
          }

          return route === "GET /v1/machines"
            ? Response.json([recordIn("stopped"), forkOf("started"), byHand])
            : undefined;
        });

        const runtime = yield* scriptedRuntime(client);

        const refusal = Effect.map(
          endedWithin(runtime.delete(dev1, new Set()), "1 minute"),
          (ended) => String(failureOf(ended))
        );

        const untold = yield* refusal;

        yield* runtime.observe([
          {
            name: "twin",
            instance: twin.instance,
            handle: Handle.make("mach-2"),
          },
        ]);

        const told = yield* refusal;

        expect(untold).toContain(
          `while a fork of it lives: cbx-${hostId}-${twin.instance}, smol cloud's name for a machine of this host's that the host hasn't read since it started; by-hand at smol cloud, which this host didn't make.`
        );
        expect(told).toContain(
          "while a fork of it lives: twin; by-hand at smol cloud, which this host didn't make."
        );
      })
  );
});

describe("a smol cloud delete refused while a fork it lists is deleted", () => {
  it.effect(
    "takes the fork as gone, stops nothing, and goes through once smol cloud takes it",
    () =>
      Effect.gen(function* () {
        let refusals = 1;
        let state: string | undefined = "stopped";

        const { asked, client } = answering((route) => {
          if (route === "DELETE /v1/machines/mach-1") {
            if (refusals > 0) {
              refusals -= 1;

              return problem(409, "machine is locked by an operation");
            }

            state = undefined;

            return new Response(null, { status: 204 });
          }

          if (route === "GET /v1/machines/mach-1" && state !== undefined) {
            return Response.json(recordIn(state));
          }

          if (route === "GET /v1/checkpoints") {
            return Response.json([]);
          }

          return route === "GET /v1/machines"
            ? Response.json([
                ...(state === undefined ? [] : [recordIn(state)]),
                forkOf("deleted"),
              ])
            : undefined;
        });

        const runtime = yield* scriptedRuntime(client);

        const ended = yield* endedWithin(
          runtime.delete(dev1, new Set()),
          "1 minute"
        );

        expect(
          ended !== undefined && Exit.isSuccess(ended),
          String(failureOf(ended))
        ).toBe(true);
        expect([
          asks(asked, "DELETE /v1/machines/mach-1"),
          asks(asked, "POST /v1/machines/mach-1/stop"),
        ]).toStrictEqual([2, 0]);
      })
  );
});

const throttled = (retryAfter: string, times = 1) => {
  let left = times;
  let state = "stopped";

  return answering((route) => {
    if (route === "POST /v1/machines/mach-1/start") {
      if (left > 0) {
        left -= 1;

        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": retryAfter },
        });
      }

      state = "started";

      return Response.json(recordIn(state));
    }

    if (route === "GET /v1/checkpoints") {
      return Response.json([]);
    }

    return route === "GET /v1/machines/mach-1"
      ? Response.json(recordIn(state))
      : undefined;
  });
};

const startsBy = (
  { asked, client }: ReturnType<typeof answering>,
  at: readonly Duration.Input[]
) =>
  Effect.gen(function* () {
    const runtime = yield* scriptedRuntime(client);
    const starting = yield* Effect.forkChild(runtime.start(dev1, new Set()));
    const counts: number[] = [];

    for (const step of at) {
      yield* TestClock.adjust(step);
      counts.push(asks(asked, "POST /v1/machines/mach-1/start"));
    }

    return { counts, ended: starting.pollUnsafe() };
  });

describe("a smol cloud 429's wait", () => {
  it.effect("is as long as an HTTP-date Retry-After names", () =>
    Effect.gen(function* () {
      const { counts, ended } = yield* startsBy(
        throttled(new Date(20_000).toUTCString()),
        ["10 seconds", "1 minute"]
      );

      expect(counts).toStrictEqual([1, 2]);
      expect(ended !== undefined && Exit.isSuccess(ended)).toBe(true);
    })
  );

  it.effect("is a second at least, whatever less Retry-After asks", () =>
    Effect.gen(function* () {
      const { counts } = yield* startsBy(throttled("0.001"), [
        "900 millis",
        "1 minute",
      ]);

      expect(counts).toStrictEqual([1, 2]);
    })
  );

  it.effect(
    "is not counted in a request's bound, so a read throttled each time is sent six times in all, and fails saying it was throttled",
    () =>
      Effect.gen(function* () {
        const { asked, client } = answering((route) =>
          route === "GET /v1/machines/mach-1"
            ? new Response("slow down", {
                status: 429,
                headers: { "retry-after": "30" },
              })
            : undefined
        );

        const runtime = yield* scriptedRuntime(client);
        const ended = yield* endedWithin(runtime.sizes(dev1), "10 minutes");

        expect(asks(asked, "GET /v1/machines/mach-1")).toBe(6);
        expect(failureOf(ended)).toMatchObject({ _tag: "Internal" });
        expect(String(failureOf(ended))).toContain("429");
        expect(String(failureOf(ended))).not.toContain("no answer");
      })
  );

  it.effect(
    "of a create throttled at every send ends after six sends, saying it was throttled",
    () =>
      Effect.gen(function* () {
        const { asked, client } = answering((route) => {
          if (route === "POST /v1/machines") {
            return new Response("slow down", {
              status: 429,
              headers: { "retry-after": "30" },
            });
          }

          return route === "GET /v1/machines" ? Response.json([]) : undefined;
        });

        const runtime = yield* scriptedRuntime(client);

        const ended = yield* endedWithin(
          runtime.make(
            machineOf("dev"),
            { _tag: "image", image },
            { _tag: "none" }
          ),
          "10 minutes"
        );

        expect(asks(asked, "POST /v1/machines")).toBe(6);
        expect(String(failureOf(ended))).toContain("429");
        expect(String(failureOf(ended))).not.toContain("no answer");
      })
  );
});

describe("a smol cloud start refused in a way it sends again", () => {
  it.effect(
    "waits the refusal out, a second at least, before it sends the start again",
    () =>
      Effect.gen(function* () {
        const refusals = [
          () => problem(409, "machine is locked by an operation"),
          () => problem(503, "try again", true),
        ];

        for (const refused of refusals) {
          let left = 1;
          let state = "stopped";

          const script = answering((route) => {
            if (route === "POST /v1/machines/mach-1/start") {
              if (left > 0) {
                left -= 1;

                return refused();
              }

              state = "started";

              return Response.json(recordIn(state));
            }

            if (route === "GET /v1/checkpoints") {
              return Response.json([]);
            }

            return route === "GET /v1/machines/mach-1"
              ? Response.json(recordIn(state))
              : undefined;
          });

          const { counts, ended } = yield* startsBy(script, [
            "900 millis",
            "1 minute",
          ]);

          expect(counts).toStrictEqual([1, 2]);
          expect(ended !== undefined && Exit.isSuccess(ended)).toBe(true);
        }
      })
  );
});

describe("a smol cloud checkpoint delete whose every answer is lost", () => {
  it.effect("is sent six times in all, then fails", () =>
    Effect.gen(function* () {
      const { asked, client } = answering((route) =>
        route === "DELETE /v1/checkpoints/ckpt-1"
          ? new Response("<html>bad gateway</html>", { status: 502 })
          : undefined
      );

      const runtime = yield* scriptedRuntime(client);

      const ended = yield* endedWithin(
        runtime.deleteCheckpoint({
          name: "snap",
          instance: machineOf("snap").instance,
          handle: Handle.make("ckpt-1"),
        }),
        "10 minutes"
      );

      expect(failureOf(ended)).toMatchObject({ _tag: "Internal" });
      expect(asks(asked, "DELETE /v1/checkpoints/ckpt-1")).toBe(6);
    })
  );
});

const accepts = (api: string) =>
  Exit.isSuccess(
    Schema.decodeExit(SmolCloud.SmolCloudSettings)({
      apiKeyFile: "/etc/clankerbox/smol-cloud.key",
      api,
    })
  );

describe("the smol cloud settings", () => {
  it("take an https API, and plain http only to a loopback address", () => {
    for (const api of [
      "https://api.smolmachines.com",
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://[::1]:8080",
    ]) {
      expect(accepts(api), api).toBe(true);
    }

    for (const api of [
      "http://api.smolmachines.com",
      "http://127.0.0.1.example.com",
      "http://127.0.0.1@example.com",
      "ws://127.0.0.1:8080",
      "api.smolmachines.com",
    ]) {
      expect(accepts(api), api).toBe(false);
    }
  });
});
