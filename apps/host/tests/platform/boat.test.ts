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
import { WrongState } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { Scope, Duration } from "effect";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Redacted,
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
import * as BoatApi from "../../src/platform/boat/api.ts";
import {
  BoatSettings,
  endpointOf,
  image,
  make,
} from "../../src/platform/boat/boat.ts";
import { types } from "../../src/platform/boat/traits.ts";
import { Handle, Runtime } from "../../src/runtime.ts";
import type { Interface, RuntimeError, Target } from "../../src/runtime.ts";
import { fakeBoat } from "../fake-boat.ts";
import type { FakeBoat, FakeBoatOptions } from "../fake-boat.ts";
import {
  cutAndLeftRunning,
  gone,
  leftInTheBackground,
  holdsPid,
} from "../guest-processes.ts";
import { runtimeContract } from "../runtime-contract.ts";
import { stallingHttp } from "../stalling-http.ts";

const services = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerNodeHttp
);

const onFakeBoatOver = (
  options: Omit<FakeBoatOptions, "dir">,
  http: Layer.Layer<HttpClient.HttpClient>
) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const boat = yield* fakeBoat({ ...options, dir });

    const context = yield* Layer.build(
      Layer.provide(boat.layer, Layer.mergeAll(NodeServices.layer, http))
    );

    return { boat, dir, runtime: Context.get(context, Runtime) };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const onFakeBoatWith = (options: Omit<FakeBoatOptions, "dir">) =>
  onFakeBoatOver(options, NodeHttpClient.layerNodeHttp);

runtimeContract({
  name: "boat",
  image,
  sizes: types.small,
  fixture: Effect.suspend(() => {
    const http = stallingHttp();

    return Effect.map(onFakeBoatOver({}, http.layer), ({ boat, runtime }) => ({
      runtime,
      faults: { ...boat.faults, stall: http.stall },
      unmarked: boat.unmarked,
    }));
  }),
});

const instanceOf = (seed: string) =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

const made = (runtime: Interface, name: string) =>
  Effect.gen(function* () {
    const machine = { name, instance: instanceOf(name), ...types.small };

    const { handle } = yield* runtime.make(
      machine,
      { _tag: "image", image },
      10_022
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
    "a make whose answer is lost before boat lists its sandbox waits for the listing, and sends the create once",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          yield* boat.faults.dropAnswer("make");
          yield* boat.listsLag(2);

          const machine = yield* made(runtime, "dev");

          expect(posts(boat, "/sandboxes")).toStrictEqual([
            "POST /sandboxes 202 start dropped",
          ]);
          expect([...boat.sandboxes.keys()]).toStrictEqual([machine.handle]);
          expect(boat.starts()).toBe(1);
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
          yield* boat.listsLag(14);

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
    "an exec its caller cuts short leaves its command running, as boat does, its writes to stdout dying of SIGPIPE, until a stop ends it",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          expect(
            yield* cutAndLeftRunning(
              runtime,
              machine,
              rootOf(boat, machine.handle),
              runtime.stop(machine)
            )
          ).toBe("141");
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
        onBoat(({ boat, runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            const pid = yield* leftInTheBackground(
              runtime,
              machine,
              rootOf(boat, machine.handle)
            );

            yield* end(runtime, machine);
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
        const pid = yield* onBoat(({ boat, runtime }) =>
          Effect.flatMap(made(runtime, "dev"), (machine) =>
            leftInTheBackground(runtime, machine, rootOf(boat, machine.handle))
          )
        );

        yield* gone(pid);

        expect(holdsPid(pid)).toBe(false);
      }),
    20_000
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
          const land = yield* boat.faults.landLate;

          const late = { name: "late", instance: instanceOf("late") };

          expect((yield* Effect.flip(made(runtime, "late")))._tag).toBe(
            "Capacity"
          );
          expect(yield* runtime.find(late)).toBeUndefined();
          yield* land;
          expect(yield* runtime.find(late)).toBeDefined();

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
    "a capture whose name boat is still saving waits that save out, refused while it saves, and saves again over the ready name, which stays ready",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");
          const checkpoint = { name: "snap", instance: instanceOf("snap") };
          const name = `cbx-${checkpoint.instance}`;

          yield* runtime.stop(machine);
          yield* boat.saveAs(machine.handle, name, "2 seconds");

          const handle = yield* runtime.capture(machine, checkpoint);

          expect(boat.snapshots.get(handle)?.status).toBe("ready");
          expect(posts(boat, "/saved-snapshots")).toStrictEqual([
            "POST /saved-snapshots 409",
            "POST /saved-snapshots 409",
            "POST /saved-snapshots 202",
          ]);

          yield* boat.saveAs(machine.handle, name);

          expect(boat.snapshots.get(name)?.status).toBe("ready");
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

            const copy = yield* runtime.make(machine, origin, 10_022);

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
    "a resize boat takes but resumes at the old type fails naming both, at one start",
    () => {
      let revert: (() => void) | undefined;

      return onBoat(
        ({ boat, runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            yield* runtime.stop(machine);
            revert = () => {
              const sandbox = boat.sandboxes.get(machine.handle);

              if (sandbox !== undefined) {
                sandbox.type = "small";
              }
            };

            const from = boat.starts();

            const failed = yield* Effect.flip(
              runtime.resize(machine, types.default, false)
            );

            expect(failed).toMatchObject({ _tag: "Internal" });
            expect(failed.message).toContain("to default");
            expect(failed.message).toContain("at small");
            expect(boat.starts() - from).toBe(1);
          }),
        {
          onCall: (line) => {
            if (line.includes("/resume")) {
              revert?.();
            }
          },
        }
      );
    },
    30_000
  );

  it.live(
    "a resize whose every request is lost fails after three, at no start",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);
          yield* boat.loseRequest("resume", 10);

          const from = boat.starts();

          const failed = yield* Effect.flip(
            runtime.resize(machine, types.default, false)
          );

          expect(failed.message).toContain("none of 3 resizes");
          expect(
            boat.calls.filter((line) => line.includes("/resume"))
          ).toHaveLength(3);
          expect(boat.starts() - from).toBe(0);
        })
      ),
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
    "reads of a saved snapshot only its name and source, and fails a list on one it can't read only when the mark claims it",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");
          const elsewhere = `cbx-${instanceOf("elsewhere")}`;
          const broken = `cbx-${instanceOf("broken")}`;

          yield* boat.malformedSnapshot(elsewhere, "bx_other");
          yield* boat.malformedSnapshot("cbx-by-hand", 7);
          expect(yield* ownedBy(runtime)).toHaveLength(1);

          yield* boat.malformedSnapshot(broken, 7);

          const failed = yield* Effect.flip(ownedBy(runtime));

          expect(failed.message).toContain(broken);
          expect(boat.sandboxes.has(machine.handle)).toBe(true);
        })
      ),
    30_000
  );

  it.live(
    "deletes its machine beside another host's marked snapshot whose status it can't read",
    () =>
      onBoat(({ boat, runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* boat.malformedSnapshot(`cbx-${instanceOf("elsewhere")}`);
          yield* runtime.delete(machine, new Set());

          expect(boat.sandboxes.has(machine.handle)).toBe(false);
        })
      ),
    30_000
  );
});

type Held =
  | "running"
  | "archiving"
  | "stopped"
  | "expired"
  | "error"
  | "cancelled"
  | "gone";

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

    case "archiving": {
      return boat.archiveSlowly(machine.handle, 4);
    }

    case "stopped": {
      return runtime.stop(machine);
    }

    case "expired": {
      return boat.expire(machine.handle);
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
    onFailure: (error) =>
      error instanceof WrongState ? `${error._tag} ${error.state}` : error._tag,
    onSuccess: () => "done",
  });

const everyHeld: readonly Held[] = [
  "running",
  "archiving",
  "stopped",
  "expired",
  "error",
  "cancelled",
  "gone",
];

describe("each boat goal from each state boat holds", () => {
  it.live(
    "ends where the state allows, reading the sandbox as its refusals do",
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
                      (yield* runtime.find(read)) === read.handle
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
              capture: "WrongState running",
              start: "done",
              stop: "done",
              pause: "done",
              delete: "done",
            },
            archiving: {
              observe: "stopped",
              find: "found",
              capture: "done",
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
            expired: {
              observe: "missing",
              find: "found",
              capture: "Missing",
              start: "Missing",
              stop: "done",
              pause: "done",
              delete: "done",
            },
            error: {
              observe: "stopped",
              find: "found",
              capture: "WrongState error",
              start: "done",
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

const pagesAtMost = 20;

const paging = (cursors: ReadonlyArray<string | null>) => {
  let page = 0;

  return {
    pages: () => page,
    client: HttpClient.make((request) =>
      Effect.suspend(() => {
        const nextCursor = cursors[Math.min(page, cursors.length - 1)];

        page += 1;

        return page > pagesAtMost
          ? Effect.die(`the list asked for page ${page}`)
          : Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ sandboxes: [], pageInfo: { nextCursor } })
              )
            );
      })
    ),
  };
};

const listedBy = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const api = yield* BoatApi.make(
      "https://boat.test/api/v1",
      Redacted.make("fake")
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));

    return yield* Effect.exit(api.sandboxes({ "cbx-host": "boat" }));
  });

describe("boat's sandbox list", () => {
  it.effect(
    "fails as unanswered on a cursor boat answered before, and asks no page again",
    () =>
      Effect.gen(function* () {
        for (const [cursors, asked] of [
          [["same"], 2],
          [["a", "b", "a"], 3],
        ] as const) {
          const { client, pages } = paging(cursors);
          const listed = yield* listedBy(client);

          expect(
            Exit.isFailure(listed) && Cause.squash(listed.cause)
          ).toMatchObject({ _tag: "Unanswered" });
          expect(pages(), cursors.join(" ")).toBe(asked);
        }
      })
  );

  it.effect("ends on a null or an empty cursor", () =>
    Effect.gen(function* () {
      for (const cursors of [
        ["a", null],
        ["a", ""],
      ]) {
        const { client, pages } = paging(cursors);

        expect(Exit.isSuccess(yield* listedBy(client))).toBe(true);
        expect(pages()).toBe(2);
      }
    })
  );
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

interface Scripted {
  readonly runtime: Interface;
  readonly asked: readonly string[];
}

const boatLimits = {
  activeSandboxes: 0,
  maxActiveSandboxes: 4,
  machineTypes: [
    { type: "small", available: true },
    { type: "default", available: true },
  ],
};

const scriptedBoat = (
  answer: (route: string) => Response | undefined
): Effect.Effect<Scripted, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const apiKeyFile = path.join(dir, "key");
    const asked: string[] = [];

    writeFileSync(apiKeyFile, "fake\n", { mode: 0o600 });

    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const route = `${request.method} ${url.pathname.replace(/^\/api\/v1/u, "")}`;

        asked.push(route);

        return HttpClientResponse.fromWeb(
          request,
          answer(route) ??
            (route === "GET /limits"
              ? Response.json(boatLimits)
              : Response.json(
                  { error: { code: "not_found", message: "no route" } },
                  { status: 404 }
                ))
        );
      })
    );

    const runtime = yield* make(
      { apiKeyFile, api: "https://boat.test/api/v1" },
      { id: "boat", stateDir: dir, listen: { address: "127.0.0.1", port: 0 } }
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));

    return { runtime, asked };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const sandboxIn = (state: string, type = "small") =>
  Response.json({ sandbox: { id: "bx1", state, type } });

const bx1 = {
  name: "dev",
  instance: "a".repeat(32),
  handle: Handle.make("bx1"),
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

describe("a boat make of sizes no type gives", () => {
  it.effect("is Unsizable, naming the types and the sizes asked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, asked } = yield* scriptedBoat(() => undefined);

        const refused = yield* Effect.flip(
          runtime.make(
            {
              name: "dev",
              instance: bx1.instance,
              cpu: 1,
              ramMib: 4096,
              diskGib: 80,
            },
            { _tag: "image", image: "ubuntu-24.04" },
            10_022
          )
        );

        expect(refused).toMatchObject({ _tag: "Unsizable" });
        expect(refused.message).toContain(
          "and dev was asked 1 vCPU, 4G of RAM and 80G of disk"
        );
        expect(
          asked.filter((route) => route === "POST /sandboxes")
        ).toHaveLength(0);
      })
    )
  );
});

describe("a boat make of a type the account's plan no longer offers", () => {
  it.effect("is Capacity, which moves the create to the next host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, asked } = yield* scriptedBoat((route) =>
          route === "POST /sandboxes"
            ? Response.json(
                {
                  error: {
                    code: "machine_class_plan_required",
                    message: "this machine type needs a higher plan",
                  },
                },
                { status: 403 }
              )
            : undefined
        );

        const refused = yield* Effect.flip(
          runtime.make(
            { name: "dev", instance: bx1.instance, ...types.small },
            { _tag: "image", image: "ubuntu-24.04" },
            10_022
          )
        );

        expect(refused).toMatchObject({ _tag: "Capacity" });
        expect(
          asked.filter((route) => route === "POST /sandboxes")
        ).toHaveLength(1);
      })
    )
  );
});

describe("a boat step's bound", () => {
  it.effect(
    "ends a start whose every resume is lost while boat moves the sandbox for minutes, within 10 minutes, failed Internal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let movingFor = 0;

          const { runtime } = yield* scriptedBoat((route) => {
            if (route === "POST /sandboxes/bx1/resume") {
              movingFor = 1100;

              return new Response("<html>bad gateway</html>", { status: 502 });
            }

            if (route === "GET /sandboxes/bx1") {
              movingFor = Math.max(0, movingFor - 1);

              return sandboxIn(movingFor > 0 ? "provisioning" : "archived");
            }

            return undefined;
          });

          const ended = yield* endedWithin(
            runtime.start(bx1, new Set()),
            "10 minutes"
          );

          expect(ended, "ended within 10 minutes").toBeDefined();
          expect(failureOf(ended)).toMatchObject({ _tag: "Internal" });
        })
      )
  );
});

describe("a boat refusal that asks to be waited out", () => {
  it.effect(
    "is a bare 429, waited as its Retry-After asks, and the call sent again once that wait ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let throttled = 1;
          let state = "archived";

          const { runtime, asked } = yield* scriptedBoat((route) => {
            if (route === "POST /sandboxes/bx1/resume") {
              if (throttled > 0) {
                throttled -= 1;

                return new Response(null, {
                  status: 429,
                  headers: { "retry-after": "2" },
                });
              }

              state = "ready";

              return Response.json(
                { sandbox: { id: "bx1", state } },
                { status: 202 }
              );
            }

            if (route === "GET /sandboxes/bx1") {
              return sandboxIn(state);
            }

            return route === "POST /sandboxes/bx1/sshkey"
              ? Response.json({
                  sshEndpoint: "127.0.0.1:2222",
                  hostKey: "ssh-ed25519 AAAA",
                })
              : undefined;
          });

          const starting = yield* Effect.forkChild(
            runtime.start(bx1, new Set())
          );

          const resumes = () =>
            asked.filter((route) => route === "POST /sandboxes/bx1/resume");

          yield* TestClock.adjust("1999 millis");
          expect(resumes(), "before its wait").toHaveLength(1);

          yield* TestClock.adjust("1 millis");
          expect(resumes(), "once it waited 2 seconds, no more").toHaveLength(
            2
          );

          yield* TestClock.adjust("1 minute");

          const ended = starting.pollUnsafe();

          expect(
            ended !== undefined && Exit.isSuccess(ended),
            String(failureOf(ended))
          ).toBe(true);
          expect(
            asked.filter((route) => route === "POST /sandboxes/bx1/resume")
          ).toHaveLength(2);
        })
      )
  );

  it.effect(
    "is not a 429 that says the account has no room, which is Capacity at its one send",
    () =>
      Effect.gen(function* () {
        for (const code of ["limit_reached", "rate_limited"]) {
          const { ended, asked } = yield* Effect.scoped(
            Effect.gen(function* () {
              const scripted = yield* scriptedBoat((route) =>
                route === "POST /sandboxes"
                  ? Response.json(
                      {
                        error: {
                          code,
                          message: "the concurrent-sandbox cap",
                        },
                      },
                      { status: 429, headers: { "retry-after": "30" } }
                    )
                  : undefined
              );

              return {
                ...scripted,
                ended: yield* endedWithin(
                  made(scripted.runtime, "dev"),
                  "1 minute"
                ),
              };
            })
          );

          expect(failureOf(ended), code).toMatchObject({ _tag: "Capacity" });
          expect(
            asked.filter((route) => route === "POST /sandboxes"),
            code
          ).toHaveLength(1);
        }
      })
  );
});

describe("a boat saved-snapshot list holding a record the host can't read", () => {
  it.effect(
    "names it by its name, or as one with none, and quotes nothing of its body",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const planted = "PLANTED-TOKEN-7f3a";
          const logged: string[] = [];

          const { runtime } = yield* scriptedBoat((route) => {
            if (route === "GET /saved-snapshots") {
              return Response.json({
                snapshots: [
                  { secretEnv: { API_TOKEN: planted } },
                  { name: 7, secret: planted },
                ],
              });
            }

            return route === "GET /sandboxes"
              ? Response.json({ sandboxes: [] })
              : undefined;
          });

          yield* (runtime.owned?.machines ?? Effect.void).pipe(
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  logged.push(String(message));
                }),
              ])
            )
          );

          expect(logged.filter((line) => line.includes(planted))).toStrictEqual(
            []
          );
          expect(logged.map((line) => line.split(", which")[0])).toStrictEqual([
            "GET /saved-snapshots answered saved snapshot a record with no name",
          ]);
        })
      )
  );
});

const resumes = (asked: readonly string[]) =>
  asked.filter((route) => route === "POST /sandboxes/bx1/resume");

const lostStart = (takes: boolean, movingReads = 0) =>
  Effect.gen(function* () {
    let state = "archived";
    let moving = 0;

    const scripted = yield* scriptedBoat((route) => {
      if (route === "POST /sandboxes/bx1/resume") {
        state = takes ? "ready" : state;
        moving = takes ? movingReads : 0;

        return new Response("<html>bad gateway</html>", { status: 502 });
      }

      if (route === "GET /sandboxes/bx1") {
        if (moving > 0) {
          moving -= 1;

          return sandboxIn("resuming");
        }

        return sandboxIn(state);
      }

      return route === "POST /sandboxes/bx1/sshkey"
        ? Response.json({
            sshEndpoint: "127.0.0.1:2222",
            hostKey: "ssh-ed25519 AAAA",
          })
        : undefined;
    });

    return {
      ...scripted,
      ended: yield* endedWithin(
        scripted.runtime.start(bx1, new Set()),
        "10 minutes"
      ),
    };
  });

describe("a boat create whose every answer is lost", () => {
  it.effect(
    "is sent three times in all, each looked for by its labels, then fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, asked } = yield* scriptedBoat((route) => {
            if (route === "POST /sandboxes") {
              return new Response("bad gateway", { status: 502 });
            }

            return route === "GET /sandboxes"
              ? Response.json({ sandboxes: [] })
              : undefined;
          });

          const ended = yield* endedWithin(made(runtime, "dev"), "5 minutes");

          expect(failureOf(ended), "ended within 5 minutes").toMatchObject({
            _tag: "Internal",
          });
          expect(
            asked.filter((route) => route === "POST /sandboxes")
          ).toHaveLength(3);
        })
      )
  );
});

describe("a boat create boat says is in progress under its key", () => {
  it.effect(
    "is looked for by its labels, and fails at its one send when boat lists nothing of it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, asked } = yield* scriptedBoat((route) => {
            if (route === "POST /sandboxes") {
              return Response.json(
                {
                  error: {
                    code: "idempotency_in_progress",
                    message: "a request with this key is in progress",
                  },
                },
                { status: 409 }
              );
            }

            return route === "GET /sandboxes"
              ? Response.json({ sandboxes: [] })
              : undefined;
          });

          const ended = yield* endedWithin(made(runtime, "dev"), "5 minutes");

          expect(failureOf(ended), "ended within 5 minutes").toBeDefined();
          expect(
            asked.filter((route) => route === "POST /sandboxes")
          ).toHaveLength(1);
          expect(
            asked.filter((route) => route === "GET /sandboxes").length
          ).toBeGreaterThan(0);
        })
      )
  );
});

describe("a boat start whose answer is lost", () => {
  it.effect(
    "reads the sandbox until it rests, and sends no resume again once it runs",
    () =>
      Effect.gen(function* () {
        for (const movingReads of [0, 2]) {
          const { asked, ended } = yield* Effect.scoped(
            lostStart(true, movingReads)
          );

          expect(
            ended !== undefined && Exit.isSuccess(ended),
            `${movingReads} reads moving: ${String(failureOf(ended))}`
          ).toBe(true);
          expect(resumes(asked), `${movingReads} reads moving`).toHaveLength(1);
        }
      })
  );

  it.effect(
    "sends the resume again while the sandbox rests stopped, three sends in all",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { asked, ended } = yield* lostStart(false);

          expect(failureOf(ended)).toMatchObject({ _tag: "Internal" });
          expect(String(failureOf(ended))).toContain("none of 3 starts");
          expect(resumes(asked)).toHaveLength(3);
        })
      )
  );
});

describe("a boat resize refused as running while boat reads the sandbox archived", () => {
  it.effect(
    "waits a poll between tries, and fails after three, naming boat's refusal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, asked } = yield* scriptedBoat((route) => {
            if (route === "POST /sandboxes/bx1/resume") {
              if (resumes(asked).length > 20) {
                throw new Error("the resize sent its resume past 20 times");
              }

              return Response.json(
                {
                  error: {
                    code: "sandbox_running_stop_first",
                    message: "stop the sandbox first",
                  },
                },
                { status: 409 }
              );
            }

            return route === "GET /sandboxes/bx1"
              ? sandboxIn("archived")
              : undefined;
          });

          const resizing = yield* Effect.forkChild(
            runtime.resize(
              { ...bx1, ...types.small },
              { cpu: 4, ramMib: 8192 },
              false
            )
          );

          yield* TestClock.adjust("100 millis");
          expect(resumes(asked)).toHaveLength(1);

          yield* TestClock.adjust("1 minute");

          const failed = failureOf(resizing.pollUnsafe());

          expect(failed).toMatchObject({ _tag: "Internal" });
          expect(String(failed)).toContain("sandbox_running_stop_first");
          expect(resumes(asked)).toHaveLength(3);
        })
      )
  );
});

describe("a boat resize of a sandbox boat moves", () => {
  it.effect("reads it a poll apart until it rests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        const readAt: number[] = [];

        const { runtime } = yield* scriptedBoat((route) => {
          if (route !== "GET /sandboxes/bx1") {
            return undefined;
          }

          readAt.push(clock.currentTimeMillisUnsafe());

          return readAt.length > 3
            ? sandboxIn("archived", "default")
            : sandboxIn("resuming");
        });

        const ended = yield* endedWithin(
          runtime.resize(
            { ...bx1, ...types.small },
            { cpu: 4, ramMib: 8192 },
            false
          ),
          "1 minute"
        );

        expect(
          ended !== undefined && Exit.isSuccess(ended),
          String(failureOf(ended))
        ).toBe(true);
        expect(
          readAt.slice(1).map((at, index) => at - (readAt[index] ?? 0))
        ).toStrictEqual([500, 500, 500]);
      })
    )
  );
});

describe("boat's ssh endpoint", () => {
  it("reads a host and a port, an IPv6 host in brackets, and refuses one that names no port", () => {
    const hostKey = "ssh-ed25519 AAAA";

    const read = (sshEndpoint: string | null, machineIp: string | null) =>
      endpointOf({ sshEndpoint, machineIp, hostKey });

    expect(read("203.0.113.7:19033", null)).toStrictEqual({
      host: "203.0.113.7",
      port: 19_033,
    });
    expect(read("[2001:db8::1]:19033", null)).toStrictEqual({
      host: "2001:db8::1",
      port: 19_033,
    });
    expect(read(null, "2001:db8::2")).toStrictEqual({
      host: "2001:db8::2",
      port: 22,
    });

    for (const refused of [
      "2001:db8::1",
      "[2001:db8::1]",
      "203.0.113.7",
      "203.0.113.7:",
      "203.0.113.7:ssh",
      "203.0.113.7:70000",
      ":22",
    ]) {
      expect(read(refused, "2001:db8::2"), refused).toBeUndefined();
    }

    expect(read(null, null)).toBeUndefined();
  });
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
    "or its folder, found open to others, stops the host from starting and says how to mend it",
    () =>
      Effect.gen(function* () {
        for (const { folder, key, says } of [
          {
            folder: 0o700,
            key: 0o644,
            says: ["boat key /", "mode 644", "chmod 600"],
          },
          {
            folder: 0o700,
            key: 0o640,
            says: ["boat key /", "mode 640", "chmod 600"],
          },
          {
            folder: 0o755,
            key: 0o600,
            says: ["boat key folder", "mode 755", "chmod 700"],
          },
          {
            folder: 0o750,
            key: undefined,
            says: ["boat key folder", "mode 750", "chmod 700"],
          },
        ]) {
          const refused = yield* Effect.scoped(
            Effect.gen(function* () {
              const dir = yield* scratch;
              const boat = yield* fakeBoat({ dir });
              const keys = path.join(dir, "state", "boat");

              mkdirSync(keys, { recursive: true });
              chmodSync(keys, folder);

              if (key !== undefined) {
                execFileSync("ssh-keygen", [
                  "-q",
                  "-t",
                  "ed25519",
                  "-N",
                  "",
                  "-f",
                  path.join(keys, "id_ed25519"),
                ]);
                chmodSync(path.join(keys, "id_ed25519"), key);
              }

              return yield* Effect.flip(
                Layer.build(Layer.provide(boat.layer, services))
              );
            })
          );

          expect(refused).toMatchObject({ _tag: "CannotStart" });

          for (const said of says) {
            expect(refused.message).toContain(said);
          }
        }
      }).pipe(Effect.provide(NodeServices.layer)),
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

describe("a boat host whose API key file can't be read", () => {
  it.effect("refuses to start, naming the file and why", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* scratch;
        const apiKeyFile = path.join(dir, "missing.key");

        const refused = yield* Effect.flip(
          make(
            { apiKeyFile, api: "https://boat.test/api/v1" },
            {
              id: "boat",
              stateDir: dir,
              listen: { address: "127.0.0.1", port: 0 },
            }
          )
        );

        expect(refused).toMatchObject({ _tag: "CannotStart" });
        expect(refused.message).toContain(apiKeyFile);
        expect(refused.message).toContain("NotFound");
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no request is sent"))
        )
      )
    )
  );
});
