import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
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
import { runtimeContract } from "../runtime-contract.ts";
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

    const context = yield* Layer.build(
      SmolCloud.layer(
        settings,
        hostConfig(path.join(dir, "state"), undefined, hostId)
      ).pipe(
        Layer.provide(NodeHttpClient.layerNodeHttp),
        Layer.provide(NodeServices.layer)
      )
    );

    return {
      runtime: Context.get(context, Runtime),
      faults: fake.faults,
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

  it.live(
    "logs by its handle a checkpoint the provider keeps for a living restore",
    () => {
      const logged: string[] = [];

      return Effect.scoped(
        Effect.gen(function* () {
          const { fake, runtime } = yield* flaky;
          const dev = yield* made(runtime, "dev");

          const snap = yield* runtime.capture(dev, {
            name: "snap",
            instance: "snap-1",
          });

          yield* runtime.make(
            machineOf("copy"),
            {
              _tag: "checkpoint",
              checkpoint: { ...checkpointOf(snap), ...sizes },
            },
            { _tag: "none" }
          );
          yield* runtime.delete(dev, new Set());

          expect(fake.checkpoints.has(snap)).toBe(true);
          expect(logged.join("\n")).toContain(snap);
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
  readonly account?: { times: number; readonly answer: "gateway" | "refused" };
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
            (failing?.account?.times ?? 0) > 0
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
                });
          }

          if (route === "GET /v1/account") {
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
            });
          }

          if (route === "POST /v1/machines") {
            if (creates.busy > 0) {
              creates.busy -= 1;

              return reply(
                503,
                { code: "insufficient_capacity", detail: "", retryable: true },
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
        expect(
          yield* refusedCreate(concurrency, {
            inUse: { machines: 4, started: 4 },
            account: { times: 2, answer: "refused" },
          })
        ).toMatchObject({ _tag: "Internal" });
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
