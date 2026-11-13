import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { Scope } from "effect";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import {
  identify,
  prepare,
  prepareBase,
  runCommand,
  runSetup,
} from "../../src/guest.ts";
import { BoatSettings, image, make } from "../../src/platform/boat/boat.ts";
import { types } from "../../src/platform/boat/traits.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Interface, RuntimeError, Target } from "../../src/runtime.ts";
import { fakeBoat } from "../fake-boat.ts";
import type { FakeBoat, FakeBoatOptions } from "../fake-boat.ts";
import { runtimeContract } from "../runtime-contract.ts";

const services = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerNodeHttp
);

const onFakeBoatWith = (options: Omit<FakeBoatOptions, "dir">) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const boat = yield* fakeBoat({ ...options, dir });
    const context = yield* Layer.build(Layer.provide(boat.layer, services));

    return { boat, dir, runtime: Context.get(context, Runtime) };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const onFakeBoat = onFakeBoatWith({});

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

const instanceOf = (seed: string) =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

const made = (runtime: Interface, name: string) =>
  Effect.gen(function* () {
    const machine = { name, instance: instanceOf(name), ...types.small };

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
    readonly dir: string;
    readonly runtime: Interface;
  }) => Effect.Effect<A, E, Scope.Scope>,
  options: Omit<FakeBoatOptions, "dir"> = {}
) => Effect.scoped(Effect.flatMap(onFakeBoatWith(options), body));

const ownedBy = (runtime: Interface) =>
  runtime.owned === undefined
    ? Effect.die("the boat runtime lists the machines it owns")
    : runtime.owned.machines;

const keyOf = (instance: string) => `cbx-boat-${instance}`;

const posts = (boat: FakeBoat, route: string) =>
  boat.calls.filter((line) => line.startsWith(`POST ${route} `));

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
    "a make whose answer was lost finds its sandbox by its labels, sends the create once, and spends one start",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.faults.dropAnswer("make");

          const machine = yield* made(runtime, "dev");

          expect(
            boat.requests.flatMap(({ method, path: at, idempotencyKey }) =>
              method === "POST" && at === "/sandboxes" ? [idempotencyKey] : []
            )
          ).toStrictEqual([keyOf(machine.instance)]);
          expect([...boat.sandboxes.keys()]).toStrictEqual([machine.handle]);
          expect(startsSince(boat, 0)).toBe(1);
        })
      ),
    30_000
  );

  it.live(
    "a make whose request was lost sends it again under the same key, and spends one start",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.loseRequest("make");

          const machine = yield* made(runtime, "dev");

          expect(posts(boat, "/sandboxes")).toStrictEqual([
            "POST /sandboxes lost",
            "POST /sandboxes 202 start",
          ]);
          expect([...boat.sandboxes.keys()]).toStrictEqual([machine.handle]);
          expect(startsSince(boat, 0)).toBe(1);
        })
      ),
    30_000
  );

  it.live(
    "a make whose resend boat holds in progress waits for its sandbox to be listed, and sends no third",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.faults.dropAnswer("make");
          yield* boat.listsLag(1);

          const machine = yield* made(runtime, "dev");

          expect(posts(boat, "/sandboxes")).toStrictEqual([
            "POST /sandboxes 202 start dropped",
            "POST /sandboxes 409 start",
          ]);
          expect([...boat.sandboxes.keys()]).toStrictEqual([machine.handle]);
        })
      ),
    30_000
  );

  it.live(
    "two hosts that make one instance make a sandbox each, under keys of their own",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const other = Context.get(
            yield* Layer.build(
              Layer.provide(boat.layerOf("other-host"), services)
            ),
            Runtime
          );

          const ours = yield* made(runtime, "dev");
          const theirs = yield* made(other, "dev");

          expect(theirs.handle).not.toBe(ours.handle);
          expect(
            boat.requests.flatMap(({ method, path: at, idempotencyKey }) =>
              method === "POST" && at === "/sandboxes" ? [idempotencyKey] : []
            )
          ).toStrictEqual([
            keyOf(ours.instance),
            `cbx-other-host-${ours.instance}`,
          ]);
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

          const late = { name: "late", instance: instanceOf("late") };

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
            instance: instanceOf("snap"),
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
            instance: instanceOf("snap"),
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
            instance: instanceOf("snap"),
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
            instance: instanceOf("snap"),
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
            instance: instanceOf("snap"),
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

            const machine = {
              name,
              instance: instanceOf(name),
              ...types.small,
            };

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

  it.live(
    "a resize whose answer was lost finishes from what boat holds, and leaves the machine stopped at its new type",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);
          yield* boat.dropAnswer("resume");
          yield* runtime.resize(machine, types.default, false);

          expect(boat.sandboxes.get(machine.handle)).toMatchObject({
            type: "default",
            running: false,
          });
          expect(yield* runtime.sizes(machine)).toStrictEqual(types.default);
        })
      ),
    30_000
  );

  it.live(
    "a resize whose request was lost sends it again at boat's next poll, not at once",
    () => {
      const resumes: Array<readonly [string, number]> = [];

      return onBoat(
        ({ boat, runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            yield* runtime.stop(machine);
            yield* boat.loseRequest("resume");
            yield* runtime.resize(machine, types.default, false);

            expect(resumes.map(([line]) => line)).toStrictEqual([
              `POST /sandboxes/${machine.handle}/resume lost`,
              `POST /sandboxes/${machine.handle}/resume 202 start`,
            ]);
            expect(
              (resumes[1]?.[1] ?? 0) - (resumes[0]?.[1] ?? 0)
            ).toBeGreaterThanOrEqual(450);
            expect(boat.sandboxes.get(machine.handle)?.type).toBe("default");
          }),
        {
          onCall: (line) => {
            if (line.includes("/resume")) {
              resumes.push([line, Date.now()]);
            }
          },
        }
      );
    },
    30_000
  );

  it.live(
    "a save that lands while its sandbox is deleted is deleted with it",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);
          yield* boat.landSaveDuringDelete;
          yield* Effect.flip(
            runtime.capture(machine, {
              name: "snap",
              instance: instanceOf("snap"),
            })
          );

          expect(boat.snapshots.size).toBe(0);

          yield* runtime.delete(machine, new Set());

          expect(boat.sandboxes.has(machine.handle)).toBe(false);
          expect([...boat.snapshots.keys()]).toStrictEqual([]);
        })
      ),
    30_000
  );

  it.live(
    "a delete whose last prune is refused fails, and the next delete clears the snapshot",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);
          yield* boat.landSaveDuringDelete;
          yield* Effect.flip(
            runtime.capture(machine, {
              name: "snap",
              instance: instanceOf("snap"),
            })
          );
          yield* boat.refuseOnce("unsave");
          yield* Effect.flip(runtime.delete(machine, new Set()));

          expect(boat.sandboxes.has(machine.handle)).toBe(false);
          expect(boat.snapshots.size).toBe(1);

          yield* runtime.delete(machine, new Set());

          expect(boat.snapshots.size).toBe(0);
        })
      ),
    30_000
  );

  it.live(
    "takes a gateway's 502 for a lost answer, and finishes the delete it cut",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* boat.gatewayOnce("delete");
          yield* runtime.delete(machine, new Set());

          expect(boat.sandboxes.has(machine.handle)).toBe(false);
          expect(
            boat.calls.filter((line) => line.startsWith("DELETE /sandboxes/"))
          ).toStrictEqual([
            `DELETE /sandboxes/${machine.handle} 502 gateway`,
            `DELETE /sandboxes/${machine.handle} 202`,
          ]);
        })
      ),
    30_000
  );

  it.live(
    "fails a make at once when boat puts its sandbox in error",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.failNextSandbox;

          const failed = yield* Effect.flip(made(runtime, "dev"));

          expect(failed).toMatchObject({ _tag: "Internal" });
          expect(failed.message).toContain("in error");
        })
      ),
    30_000
  );

  it.live(
    "lists every page of the sandboxes this host marked",
    () =>
      onBoat(
        ({ runtime }) =>
          Effect.gen(function* () {
            const machines = yield* Effect.forEach(["a", "b", "c"], (name) =>
              made(runtime, name)
            );

            const owned = yield* ownedBy(runtime);

            expect(owned.map(({ handle }) => handle).toSorted()).toStrictEqual(
              machines.map(({ handle }) => handle).toSorted()
            );
          }),
        { pageSize: 1 }
      ),
    30_000
  );

  it.live(
    "spares a snapshot named cbx- by hand, and asks for saved snapshots by name prefix alone",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);
          yield* boat.saveAs(machine.handle, "cbx-before-upgrade");
          yield* runtime.delete(machine, new Set());

          expect([...boat.snapshots.keys()]).toStrictEqual([
            "cbx-before-upgrade",
          ]);
          expect(
            new Set(
              boat.requests.flatMap(({ method, path: at }) =>
                method === "GET" && at.startsWith("/saved-snapshots?")
                  ? [at]
                  : []
              )
            )
          ).toStrictEqual(new Set(["/saved-snapshots?namePrefix=cbx-"]));
        })
      ),
    30_000
  );

  it.live(
    "a saved snapshot it can't read fails a list only when its name carries the mark",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* boat.malformedSnapshot("cbx-by-hand");
          expect(yield* ownedBy(runtime)).toHaveLength(1);

          yield* boat.malformedSnapshot(`cbx-${instanceOf("broken")}`);

          const failed = yield* Effect.flip(ownedBy(runtime));

          expect(failed.message).toContain(`cbx-${instanceOf("broken")}`);
          expect(boat.sandboxes.has(machine.handle)).toBe(true);
        })
      ),
    30_000
  );
});

type Held = "running" | "stopped" | "error" | "cancelled" | "gone";

const holding = (
  boat: FakeBoat,
  runtime: Interface,
  machine: Target,
  held: Held
): Effect.Effect<void, RuntimeError> => {
  switch (held) {
    case "running": {
      return Effect.void;
    }

    case "stopped": {
      return runtime.stop(machine);
    }

    case "error": {
      return boat.fail(machine.handle);
    }

    case "cancelled": {
      return boat.cancel(machine.handle);
    }

    case "gone": {
      return boat.vanish(machine.handle);
    }
  }
};

const outcome = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
) =>
  Effect.match(effect.pipe(Effect.timeout("20 seconds")), {
    onFailure: (error) => error._tag,
    onSuccess: () => "done",
  });

const everyHeld: readonly Held[] = [
  "running",
  "stopped",
  "error",
  "cancelled",
  "gone",
];

describe("each boat goal from each state boat holds", () => {
  it.live(
    "ends where the state allows, and names what stops it",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const found = yield* Effect.forEach(
            everyHeld,
            (held) =>
              Effect.gen(function* () {
                const holdingFor = (goal: string) =>
                  Effect.tap(made(runtime, `${held}-${goal}`), (machine) =>
                    holding(boat, runtime, machine, held)
                  );

                const read = yield* holdingFor("read");
                const start = yield* holdingFor("start");
                const stop = yield* holdingFor("stop");
                const pause = yield* holdingFor("pause");
                const remove = yield* holdingFor("delete");

                return [
                  held,
                  {
                    observe: (yield* runtime.observe([read])).get(read.name),
                    find:
                      (yield* runtime.find("machine", read)) === read.handle
                        ? "found"
                        : "none",
                    capture: yield* outcome(
                      runtime.capture(read, {
                        name: "snap",
                        instance: instanceOf(`${held}-snap`),
                      })
                    ),
                    start: yield* outcome(runtime.start(start, new Set())),
                    stop: yield* outcome(runtime.stop(stop)),
                    pause: yield* outcome(runtime.pause(pause)),
                    delete: yield* outcome(runtime.delete(remove, new Set())),
                  },
                ] as const;
              }),
            { concurrency: "unbounded" }
          );

          expect(Object.fromEntries(found)).toStrictEqual({
            running: {
              observe: "running",
              find: "found",
              capture: "WrongState",
              start: "done",
              stop: "done",
              pause: "done",
              delete: "done",
            },
            stopped: {
              observe: "stopped",
              find: "found",
              capture: "done",
              start: "done",
              stop: "done",
              pause: "done",
              delete: "done",
            },
            error: {
              observe: "stopped",
              find: "found",
              capture: "WrongState",
              start: "Internal",
              stop: "done",
              pause: "done",
              delete: "done",
            },
            cancelled: {
              observe: "missing",
              find: "none",
              capture: "Missing",
              start: "Missing",
              stop: "done",
              pause: "done",
              delete: "done",
            },
            gone: {
              observe: "missing",
              find: "none",
              capture: "Missing",
              start: "Missing",
              stop: "done",
              pause: "done",
              delete: "done",
            },
          });
        })
      ),
    120_000
  );

  it.live(
    "a start whose sandbox goes once boat took its resume answers Missing",
    () => {
      let vanish: (() => void) | undefined;

      return onBoat(
        ({ boat, runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            yield* runtime.stop(machine);
            vanish = () => {
              boat.vanishNow(machine.handle);
            };

            expect(
              yield* Effect.flip(runtime.start(machine, new Set()))
            ).toMatchObject({ _tag: "Missing", machine: "dev" });
          }),
        {
          keepsStoppedFor: "0 millis",
          onCall: (line) => {
            if (line.includes("/resume")) {
              vanish?.();
              vanish = undefined;
            }
          },
        }
      );
    },
    30_000
  );

  it.live(
    "a make whose sandbox boat cancels for want of a machine answers Capacity",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.cancelNextSandbox;

          expect(yield* Effect.flip(made(runtime, "dev"))).toMatchObject({
            _tag: "Capacity",
          });
        })
      ),
    30_000
  );
});

const stalled = (stalls: string) =>
  HttpClient.make((request, url) => {
    const route = `${request.method} ${url.pathname}`;

    const reply = (body: unknown) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(body, { status: 200 })
        )
      );

    if (route === stalls) {
      return Effect.never;
    }

    if (route === "GET /api/v1/limits") {
      return reply({
        activeSandboxes: 0,
        maxActiveSandboxes: 4,
        machineTypes: [{ type: "small", available: true }],
      });
    }

    return reply({ sandboxes: [], pageInfo: { nextCursor: null } });
  });

describe("a boat request's bound", () => {
  it.effect(
    "ends a make whose create boat never answers, inside its step, failed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratch;
          const apiKeyFile = path.join(dir, "key");

          writeFileSync(apiKeyFile, "fake\n", { mode: 0o600 });

          const runtime = yield* make(
            { apiKeyFile, api: "https://boat.test/api/v1" },
            {
              id: "boat",
              stateDir: dir,
              listen: { address: "127.0.0.1", port: 0 },
            }
          ).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              stalled("POST /api/v1/sandboxes")
            )
          );

          const making = yield* Effect.forkChild(made(runtime, "dev"));

          yield* TestClock.adjust("10 minutes");

          const ended = making.pollUnsafe();

          expect(ended, "ended within 10 minutes").toBeDefined();
          expect(
            ended !== undefined &&
              Exit.isFailure(ended) &&
              Cause.squash(ended.cause)
          ).toMatchObject({ _tag: "Internal" });
        }).pipe(Effect.provide(NodeServices.layer))
      )
  );
});

describe("the host's boat key", () => {
  it.live(
    "is made readable by its owner alone, in a directory only its owner can enter",
    () =>
      onBoat(({ dir }) =>
        Effect.sync(() => {
          const keys = path.join(dir, "state", "boat");

          expect(statSync(keys).mode & 0o777).toBe(0o700);
          expect(statSync(path.join(keys, "id_ed25519")).mode & 0o777).toBe(
            0o600
          );
        })
      ),
    30_000
  );

  it.live(
    "found readable by others, stops the host from starting and says how to mend it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratch;
          const boat = yield* fakeBoat({ dir });
          const keys = path.join(dir, "state", "boat");

          mkdirSync(keys, { recursive: true, mode: 0o700 });
          execFileSync("ssh-keygen", [
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            path.join(keys, "id_ed25519"),
          ]);
          chmodSync(path.join(keys, "id_ed25519"), 0o644);

          const refused = yield* Effect.flip(
            Layer.build(Layer.provide(boat.layer, services))
          );

          expect(refused).toMatchObject({ _tag: "CannotStart" });
          expect(refused.message).toContain("mode 644");
          expect(refused.message).toContain("chmod 600");
        }).pipe(Effect.provide(NodeServices.layer))
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
