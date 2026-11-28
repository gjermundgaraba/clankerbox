import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, Option, Schedule, Stream } from "effect";
import { expect } from "vite-plus/test";

import { runCommand } from "../../src/exec.ts";
import {
  addMissingKeys,
  checkTailnet,
  identify,
  prepare,
  prepareBase,
} from "../../src/guest.ts";
import { Handle } from "../../src/runtime.ts";
import {
  base,
  dir,
  fixture,
  ghost,
  hex,
  hosted,
  keyed,
  probedFromOutside,
  probeImage,
  sizes,
  sshed,
} from "./hosted.ts";

describe.runIf(dir !== "")("agent-sandbox, on kind", () => {
  it.live(
    "reads one machine by its name, and lists the host's Sandboxes only for several",
    () =>
      Effect.gen(function* () {
        const { runtime, requests } = yield* hosted;

        const [a, b] = [ghost("a"), ghost("b")];
        const before = requests.length;
        const one = yield* runtime.observe([a]);
        const single = requests.slice(before);
        const middle = requests.length;
        const both = yield* runtime.observe([a, b]);

        expect(Object.fromEntries(one)).toStrictEqual({
          a: { state: "missing" },
        });
        expect(Object.fromEntries(both)).toStrictEqual({
          a: { state: "missing" },
          b: { state: "missing" },
        });
        expect(single).toHaveLength(1);
        expect(single[0]).toMatch(
          new RegExp(`^GET .*/sandboxes/${a.handle}$`, "u")
        );
        expect(requests.slice(middle)).toHaveLength(1);
        expect(requests[middle]).toMatch(/^GET .*\/sandboxes$/u);
      }),
    60_000
  );

  it.live(
    "prepares a base a client then reaches over SSH, again after a stop and start, and gives a fork its own host key",
    () =>
      Effect.gen(function* () {
        const { cluster, runtime } = yield* hosted;
        const { reach } = runtime;

        if (reach._tag !== "relayed") {
          return yield* Effect.die("agent-sandbox's reach is relayed");
        }

        const { identity, publicKey } = yield* keyed;
        const machine = { name: "dev", instance: hex(16), ...sizes };

        const { handle } = yield* runtime.make(
          machine,
          { _tag: "image", image: base },
          0
        );

        const dev = { ...machine, handle };

        yield* prepareBase(runtime, dev, false);
        yield* identify(runtime, dev);

        const hostKey = yield* prepare(runtime, dev);

        yield* addMissingKeys(runtime, dev, publicKey);
        yield* runCommand(runtime, {
          machine: dev,
          argv: ["/bin/sh", "-c", "echo kept >/home/admin/kept"],
          user: "admin",
        });

        expect(hostKey).toMatch(/^ssh-ed25519 /u);
        expect(
          yield* sshed(reach.dial(dev), hostKey ?? "", identity, "id -un")
        ).toBe("admin\n");

        const abandoned = yield* Stream.runDrain(
          reach.dial(dev)(Stream.empty)
        ).pipe(Effect.timeoutOption("20 seconds"));

        expect(Option.isSome(abandoned)).toBe(true);

        const outbound = yield* runCommand(runtime, {
          machine: dev,
          argv: [
            "/bin/bash",
            "-c",
            'for to in "$KUBERNETES_SERVICE_HOST" 1.1.1.1; do timeout 5 bash -c "</dev/tcp/$to/443" 2>/dev/null && echo "$to reached" || echo "$to blocked"; done',
          ],
        });

        const address = (yield* cluster.addresses.get(handle))?.status?.podIP;

        if (address === undefined) {
          return yield* Effect.die("the running guest has no pod IP");
        }

        const inbound = yield* probedFromOutside(
          cluster,
          `nc -z -w 5 "$KUBERNETES_SERVICE_HOST" 443 || exit 2; nc -z -w 5 ${address} 22 && exit 1; exit 0`
        );

        expect([outbound.output, inbound]).toStrictEqual([
          expect.stringMatching(/^\S+ blocked\n1\.1\.1\.1 reached\n$/u),
          0,
        ]);

        yield* runtime.stop(dev);
        yield* runtime.start(dev, new Set());

        expect(
          yield* sshed(
            reach.dial(dev),
            hostKey ?? "",
            identity,
            "cat kept; touch /outside 2>&1 || true"
          )
        ).toMatch(/^kept\n.*Read-only file system/su);

        yield* runtime.stop(dev);

        const fork = { name: "fork", instance: hex(16), ...sizes };

        const forked = yield* runtime.make(
          fork,
          { _tag: "machine", machine: dev },
          0
        );

        const copy = { ...fork, handle: forked.handle };

        yield* identify(runtime, copy);

        const forkKey = yield* prepare(runtime, copy);

        expect(forkKey).not.toBe(hostKey);
        expect(
          yield* sshed(reach.dial(copy), forkKey ?? "", identity, "cat kept")
        ).toBe("kept\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "lets a machine that requests the tailnet run tailscaled on a TUN device, again after a resize",
    () =>
      Effect.gen(function* () {
        const { runtime } = yield* fixture;
        const machine = { name: "joiner", instance: hex(16), ...sizes };

        const { handle } = yield* runtime.make(
          machine,
          { _tag: "image", image: base },
          0,
          true
        );

        const joiner = { ...machine, handle };

        yield* prepareBase(runtime, joiner, true);

        const fresh = yield* checkTailnet(runtime, joiner, "joiner");

        yield* runtime.stop(joiner);
        yield* runtime.resize(joiner, { cpu: 2 }, false);
        yield* runtime.start(joiner, new Set());

        const resized = yield* checkTailnet(runtime, joiner, "joiner");

        expect([fresh, resized]).toStrictEqual([
          { state: "reported", backend: "NeedsLogin", name: undefined },
          { state: "reported", backend: "NeedsLogin", name: undefined },
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "starts no machine whose disk was replaced while it was stopped",
    () =>
      Effect.gen(function* () {
        const { cluster, runtime } = yield* hosted;
        const machine = { name: "swapped", instance: hex(16), ...sizes };

        const { handle } = yield* runtime.make(
          machine,
          { _tag: "image", image: base },
          0
        );

        const target = { ...machine, handle };
        const disk = `${handle}-disk`;

        yield* runtime.stop(target);
        yield* cluster.claims.remove(disk);
        yield* Effect.repeat(cluster.claims.get(disk), {
          until: (found) => found === undefined,
          schedule: Schedule.spaced("500 millis"),
        }).pipe(Effect.timeout("2 minutes"));
        yield* cluster.claims.create({
          metadata: { name: disk },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: "1Gi" } },
          },
        });
        yield* Effect.addFinalizer(() =>
          Effect.ignore(cluster.claims.remove(disk))
        );

        const started = yield* Effect.exit(runtime.start(target, new Set()));

        const mode = (yield* cluster.sandboxes.get(handle))?.spec.operatingMode;

        expect([
          Exit.isFailure(started)
            ? Option.getOrUndefined(Exit.findErrorOption(started))?._tag
            : "started",
          mode,
        ]).toStrictEqual(["Missing", "Suspended"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "neither finds, starts, resizes, copies nor deletes namesakes it didn't make where its own would be",
    () =>
      Effect.gen(function* () {
        const { cluster, id, runtime } = yield* hosted;
        const machine = { name: "namesake", instance: hex(16), ...sizes };
        const handle = Handle.make(`cbx-${id}-${machine.instance}`);
        const disk = `${handle}-disk`;
        const checkpoint = { name: "kept", instance: hex(16), ...sizes };

        const checkpointHandle = Handle.make(
          `cbx-${id}-${checkpoint.instance}-checkpoint`
        );

        for (const [name, annotations] of [
          [disk, {}],
          [checkpointHandle, { "clankerbox.dev/filled": "true" }],
        ] as const) {
          yield* cluster.claims.create({
            metadata: { name, annotations },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: "1Gi" } },
            },
          });
          yield* Effect.addFinalizer(() =>
            Effect.ignore(cluster.claims.remove(name))
          );
        }

        yield* cluster.sandboxes.create({
          apiVersion: "agents.x-k8s.io/v1beta1",
          kind: "Sandbox",
          metadata: { name: handle },
          spec: {
            operatingMode: "Suspended",
            podTemplate: {
              spec: {
                containers: [
                  {
                    name: "guest",
                    image: base,
                    command: ["sleep", "infinity"],
                  },
                ],
              },
            },
          },
        });
        yield* Effect.addFinalizer(() =>
          Effect.ignore(cluster.sandboxes.remove(handle))
        );

        const found = yield* runtime.find(machine);
        const target = { ...machine, handle };

        const tried = yield* Effect.all([
          Effect.exit(runtime.start(target, new Set())),
          Effect.exit(runtime.resize(target, { diskGib: 2, cpu: 2 }, false)),
          Effect.exit(
            runtime.make(
              { name: "copy", instance: hex(16), ...sizes },
              {
                _tag: "checkpoint",
                checkpoint: { ...checkpoint, handle: checkpointHandle },
              },
              0
            )
          ),
        ]);

        yield* runtime.delete(target, new Set());
        yield* runtime.deleteCheckpoint({
          ...checkpoint,
          handle: checkpointHandle,
        });

        const left = yield* Effect.all([
          cluster.sandboxes.get(handle),
          cluster.claims.get(disk),
          cluster.claims.get(checkpointHandle),
        ]);

        expect({
          found,
          tried: tried.map(
            (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
              Exit.isFailure(exit)
                ? Option.getOrUndefined(Exit.findErrorOption(exit))?._tag
                : "done"
          ),
          mode: left[0]?.spec.operatingMode,
          asked: left[1]?.spec.resources?.requests?.["storage"],
          deleting: left.map((each) => each?.metadata.deletionTimestamp),
        }).toStrictEqual({
          found: undefined,
          tried: ["Missing", "Internal", "Missing"],
          mode: "Suspended",
          asked: "1Gi",
          deleting: [undefined, undefined, undefined],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "refuses a base that isn't usr-merged Invalid, saying why, and leaves no pod of it",
    () =>
      Effect.gen(function* () {
        const { cluster, id, runtime } = yield* hosted;
        const machine = { name: "unmerged", instance: hex(16), ...sizes };

        const made = yield* Effect.exit(
          runtime.make(machine, { _tag: "image", image: probeImage }, 0)
        );

        const refused = Exit.isFailure(made)
          ? Option.getOrUndefined(Exit.findErrorOption(made))
          : undefined;

        const left = yield* cluster.pods.get(
          `cbx-${id}-${machine.instance}-fill`
        );

        yield* runtime.delete(
          {
            ...machine,
            handle: Handle.make(`cbx-${id}-${machine.instance}`),
          },
          new Set()
        );

        expect({
          tag: refused?._tag,
          says: refused?.message.includes("is a directory, not a link"),
          left,
        }).toStrictEqual({ tag: "Invalid", says: true, left: undefined });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
