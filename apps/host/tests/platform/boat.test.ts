import { readFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";

import {
  identify,
  prepare,
  prepareBase,
  runCommand,
  runSetup,
} from "../../src/guest.ts";
import { BoatSettings, image } from "../../src/platform/boat/boat.ts";
import { types } from "../../src/platform/boat/traits.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Interface } from "../../src/runtime.ts";
import { fakeBoat } from "../fake-boat.ts";
import type { FakeBoat } from "../fake-boat.ts";
import { runtimeContract } from "../runtime-contract.ts";

const services = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerNodeHttp
);

const onFakeBoat = Effect.gen(function* () {
  const dir = yield* scratch;
  const boat = yield* fakeBoat({ dir });
  const context = yield* Layer.build(Layer.provide(boat.layer, services));

  return { boat, runtime: Context.get(context, Runtime) };
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

runtimeContract({
  name: "boat",
  image,
  sizes: types.small,
  fixture: Effect.map(onFakeBoat, ({ boat, runtime }) => ({
    runtime,
    faults: boat.faults,
    unmarked: boat.unmarked,
  })),
});

const made = (runtime: Interface, name: string) =>
  Effect.gen(function* () {
    const machine = { name, instance: `${name}-1`, ...types.small };

    const { handle } = yield* runtime.make(
      machine,
      { _tag: "image", image },
      { _tag: "none" }
    );

    return { ...machine, handle };
  });

const rootOf = (boat: FakeBoat, handle: string) =>
  boat.sandboxes.get(handle)?.root ?? "";

const hostKeyOf = (boat: FakeBoat, handle: string) =>
  readFileSync(
    path.join(rootOf(boat, handle), "etc/ssh/ssh_host_ed25519_key.pub"),
    "utf8"
  )
    .split(" ")
    .slice(0, 2)
    .join(" ");

const startsSince = (boat: FakeBoat, from: number) =>
  boat.calls.slice(from).filter((line) => line.split(" ").includes("start"))
    .length;

const onBoat = <A, E>(
  body: (fake: {
    readonly boat: FakeBoat;
    readonly runtime: Interface;
  }) => Effect.Effect<A, E>
) => Effect.scoped(Effect.flatMap(onFakeBoat, body));

describe("the boat runtime over fake boat", () => {
  it.live(
    "sends no byte of a setup script to boat's API",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");
          const token = "cbx-setup-5b1d07e3";
          const script = `#!/bin/sh\necho ${token} >"$HOME/setup-ran"\n`;

          yield* prepareBase(runtime, machine, false);
          yield* runSetup(runtime, machine, { script }, undefined);

          expect(
            readFileSync(
              path.join(rootOf(boat, machine.handle), "home/admin/setup-ran"),
              "utf8"
            )
          ).toBe(`${token}\n`);
          expect(
            boat.requests.filter(
              (request) =>
                request.body.includes(token) || request.path.includes(token)
            )
          ).toStrictEqual([]);
          expect(
            boat.calls.filter((line) => line.includes(token))
          ).toStrictEqual([]);
        })
      ),
    30_000
  );

  it.live(
    "a make whose answer was lost asks again under the same Idempotency-Key and makes one sandbox",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.faults.dropAnswer("make");

          const machine = yield* made(runtime, "dev");

          const creates = boat.requests.filter(
            ({ method, path: at }) => method === "POST" && at === "/sandboxes"
          );

          expect(
            creates.map(({ idempotencyKey }) => idempotencyKey)
          ).toStrictEqual([machine.instance, machine.instance]);
          expect([...boat.sandboxes.keys()]).toStrictEqual([machine.handle]);
          expect(startsSince(boat, 0)).toBe(1);
        })
      ),
    30_000
  );

  it.live(
    "exec goes on working after a guest command re-keys the host",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");
          const before = hostKeyOf(boat, machine.handle);

          yield* identify(runtime, machine);

          const after = hostKeyOf(boat, machine.handle);

          expect(after).not.toBe(before);
          expect(yield* prepare(runtime, machine)).toBe(after);
          expect(
            boat.calls.filter((line) => line.includes("/sshkey 200"))
          ).toHaveLength(2);
        })
      ),
    30_000
  );

  it.live(
    "a stop then start inside the warm window spends no start, a stopped resize one, and a cold start a new host key",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");
          const key = hostKeyOf(boat, machine.handle);
          const warm = boat.calls.length;

          yield* runtime.stop(machine);
          yield* runtime.start(machine, new Set());

          expect(startsSince(boat, warm)).toBe(0);
          expect(hostKeyOf(boat, machine.handle)).toBe(key);

          yield* runtime.stop(machine);

          const resized = boat.calls.length;

          yield* runtime.resize(machine, types.large, false);

          expect(startsSince(boat, resized)).toBe(1);
          expect(yield* runtime.sizes(machine)).toStrictEqual(types.large);
          expect(boat.sandboxes.get(machine.handle)?.running).toBe(false);

          yield* boat.keepStoppedFor(0);

          const cold = boat.calls.length;

          yield* runtime.start(machine, new Set());

          expect(startsSince(boat, cold)).toBe(1);
          expect(hostKeyOf(boat, machine.handle)).not.toBe(key);

          const ran = yield* runCommand(runtime, {
            machine,
            argv: ["/bin/sh", "-c", "echo cold"],
          });

          expect(ran).toMatchObject({ exitCode: 0, output: "cold\n" });
        })
      ),
    30_000
  );

  it.live(
    "the relay's dial carries bytes both ways",
    () =>
      onBoat(({ runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          if (runtime.reach._tag !== "relayed") {
            return yield* Effect.die("boat's reach is relayed");
          }

          const expected = "SSH-2.0-fake-boat\r\nping\n";
          const sent = Stream.make(new TextEncoder().encode("ping\n"));

          const answered = yield* runtime.reach
            .dial(machine)(Stream.concat(sent, Stream.never))
            .pipe(
              Stream.decodeText,
              Stream.scan(
                () => "",
                (sofar, chunk) => sofar + chunk
              ),
              Stream.takeUntil((sofar) => sofar.length >= expected.length),
              Stream.runLast,
              Effect.timeout("5 seconds")
            );

          expect(answered).toStrictEqual(Option.some(expected));
        })
      ),
    30_000
  );

  it.live(
    "the relay's dial ends when the guest closes its end",
    () =>
      onBoat(({ runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          if (runtime.reach._tag !== "relayed") {
            return yield* Effect.die("boat's reach is relayed");
          }

          const answered = yield* runtime.reach
            .dial(machine)(Stream.make(new TextEncoder().encode("ping\n")))
            .pipe(
              Stream.decodeText,
              Stream.mkString,
              Effect.timeout("5 seconds")
            );

          expect(answered).toBe("SSH-2.0-fake-boat\r\nping\n");
        })
      ),
    30_000
  );

  it.live(
    "boat's faults reach the adapter as a real account's would",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.faults.quota(true);

          const refused = yield* Effect.flip(made(runtime, "full"));

          expect(refused._tag).toBe("Capacity");

          yield* boat.faults.quota(false);
          yield* boat.faults.landLate("200 millis");

          const late = { name: "late", instance: "late-1" };

          expect((yield* Effect.flip(made(runtime, "late")))._tag).toBe(
            "Capacity"
          );
          yield* Effect.sleep("300 millis");
          expect(yield* runtime.find("machine", late)).toBeDefined();

          const machine = yield* made(runtime, "dev");

          yield* boat.faults.drift(machine.instance);
          expect((yield* runtime.observe([machine])).get(machine.name)).toBe(
            "stopped"
          );

          const checkpoint = yield* runtime.capture(machine, {
            name: "snap",
            instance: "snap-1",
          });

          expect(boat.snapshots.get(checkpoint)?.status).toBe("ready");

          yield* boat.faults.dropAnswer("delete");
          yield* runtime.delete(machine, new Set([checkpoint]));
          expect(boat.sandboxes.has(machine.handle)).toBe(false);
          expect(
            boat.calls.filter((line) => line.endsWith("dropped"))
          ).toHaveLength(1);
        })
      ),
    30_000
  );

  it.live(
    "a capture whose save answer was lost reads the snapshot by its name, sends the save once, and answers the snapshot",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);
          yield* boat.dropAnswer("save");

          const checkpoint = yield* runtime.capture(machine, {
            name: "snap",
            instance: "snap-1",
          });

          expect(boat.snapshots.get(checkpoint)?.status).toBe("ready");
          expect(
            boat.calls.filter((line) =>
              line.startsWith("POST /saved-snapshots")
            )
          ).toStrictEqual(["POST /saved-snapshots 202 dropped"]);
        })
      ),
    30_000
  );

  it.live(
    "a delete cut short leaves no snapshot that outlives its sandbox, and the next delete clears both",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);

          const checkpoint = yield* runtime.capture(machine, {
            name: "snap",
            instance: "snap-1",
          });

          yield* boat.refuseOnce("unsave");
          yield* Effect.flip(runtime.delete(machine, new Set()));

          expect(boat.sandboxes.has(machine.handle)).toBe(true);
          expect(boat.snapshots.has(checkpoint)).toBe(true);

          yield* runtime.delete(machine, new Set());

          expect(boat.sandboxes.has(machine.handle)).toBe(false);
          expect(boat.snapshots.has(checkpoint)).toBe(false);
        })
      ),
    30_000
  );

  it.live(
    "a start whose prune is refused still runs the machine, and its next start prunes",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);

          const checkpoint = yield* runtime.capture(machine, {
            name: "snap",
            instance: "snap-1",
          });

          yield* boat.refuseOnce("unsave");
          yield* runtime.start(machine, new Set());

          expect(boat.sandboxes.get(machine.handle)?.running).toBe(true);
          expect(boat.snapshots.has(checkpoint)).toBe(true);

          yield* runtime.start(machine, new Set());

          expect(boat.snapshots.has(checkpoint)).toBe(false);
        })
      ),
    30_000
  );

  it.live(
    "a restore and a fork copy their source's disk, each at one start and with a host key of its own",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const source = yield* made(runtime, "dev");

          yield* runCommand(runtime, {
            machine: source,
            argv: ["/bin/sh", "-c", 'echo kept >"$CLANKERBOX_ROOT/marker"'],
          });
          yield* runtime.stop(source);

          const refused = yield* Effect.flip(
            runCommand(runtime, { machine: source, argv: ["true"] })
          );

          expect(refused.message).toContain("Connection refused");

          const handle = yield* runtime.capture(source, {
            name: "snap",
            instance: "snap-1",
          });

          const copies = [
            {
              name: "restored",
              origin: { _tag: "checkpoint", checkpoint: { ...source, handle } },
            },
            { name: "forked", origin: { _tag: "machine", machine: source } },
          ] as const;

          for (const { name, origin } of copies) {
            const from = boat.calls.length;
            const machine = { name, instance: `${name}-1`, ...types.small };
            const copy = yield* runtime.make(machine, origin, { _tag: "none" });

            expect(startsSince(boat, from)).toBe(1);
            expect(
              readFileSync(
                path.join(rootOf(boat, copy.handle), "marker"),
                "utf8"
              )
            ).toBe("kept\n");
            expect(hostKeyOf(boat, copy.handle)).not.toBe(
              hostKeyOf(boat, source.handle)
            );
          }
        })
      ),
    30_000
  );
});

const accepts = (api: string) =>
  Exit.isSuccess(
    Schema.decodeExit(BoatSettings)({
      apiKeyFile: "/etc/clankerbox/boat.key",
      api,
    })
  );

describe("the boat settings", () => {
  it("take an https API, and plain http only to a loopback address", () => {
    for (const api of [
      "https://boat.dev/api/v1",
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://[::1]:8080",
    ]) {
      expect(accepts(api), api).toBe(true);
    }

    for (const api of [
      "http://boat.dev/api/v1",
      "http://127.0.0.1.example.com",
      "http://127.0.0.1@example.com",
      "ws://127.0.0.1:8080",
      "boat.dev/api/v1",
    ]) {
      expect(accepts(api), api).toBe(false);
    }
  });
});
