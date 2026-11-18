import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Hex } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect, vi } from "vite-plus/test";

import { runCommand } from "../../src/exec.ts";
import {
  addMissingKeys,
  checkTailnet,
  identify,
  prepare,
  prepareBase,
} from "../../src/guest.ts";
import * as AgentSandbox from "../../src/platform/agent-sandbox/agent-sandbox.ts";
import * as Api from "../../src/platform/agent-sandbox/api.ts";
import * as Relay from "../../src/platform/relay.ts";
import { SweepEvery } from "../../src/platform/tombstones.ts";
import type { Dial } from "../../src/runtime.ts";
import { Handle, Runtime } from "../../src/runtime.ts";
import { runtimeContract } from "../runtime-contract.ts";
import type { Faults, Fixture } from "../runtime-contract.ts";
import { faultyHttp } from "./faulty-http.ts";

const dir = process.env["CLANKERBOX_KIND"] ?? "";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const base =
  "debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2";

const probeImage =
  "busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";

const hex = (bytes: number) =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

const fromCluster = (file: string) =>
  readFileSync(path.join(dir, file), "utf8").trim();

const settingsOf = () => ({
  namespace: fromCluster("namespace"),
  api: fromCluster("api"),
  tokenFile: path.join(dir, "host-token"),
  caFile: path.join(dir, "ca.crt"),
});

const tester = Effect.gen(function* () {
  const settings = settingsOf();

  const http = yield* Layer.build(AgentSandbox.httpLayer(settings));

  const api = yield* Api.make(
    settings.api,
    Effect.succeed(Redacted.make(fromCluster("tester-token")))
  ).pipe(Effect.provide(http));

  const paths = Api.paths(settings.namespace);

  return {
    sandboxes: api.resource(paths.sandboxes, Api.Sandbox),
    claims: api.resource(paths.claims, Api.Claim),
    pods: api.resource(paths.pods, Api.Pod),
    quotas: api.resource(paths.quotas, Api.Quota),
    addresses: api.resource(
      paths.pods,
      Schema.Struct({
        status: Schema.optionalKey(
          Schema.Struct({ podIP: Schema.optionalKey(Schema.String) })
        ),
      })
    ),
  };
});

type Tester = Effect.Success<typeof tester>;

const sweptAfter = (cluster: Tester, id: string) =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const selector = { "cbx-host": id };

      for (const kind of [cluster.sandboxes, cluster.pods, cluster.claims]) {
        const found = yield* kind.list(selector);

        yield* Effect.forEach(
          found,
          ({ metadata }) => kind.remove(metadata.name),
          {
            discard: true,
          }
        );
      }
    }).pipe(Effect.ignore)
  );

const hosted = Effect.gen(function* () {
  const cluster = yield* tester;
  const settings = settingsOf();
  const id = `kind-${hex(4)}`;
  const http = faultyHttp(AgentSandbox.httpLayer(settings));

  yield* sweptAfter(cluster, id);

  const context = yield* Layer.build(
    Layer.effect(
      Runtime,
      AgentSandbox.make(settings, {
        id,
        stateDir: path.join(yield* scratch, "state"),
        listen: { address: "127.0.0.1", port: 0 },
      })
    ).pipe(
      Layer.provide(http.layer),
      Layer.provide(Layer.succeed(SweepEvery, Duration.seconds(1)))
    )
  );

  const runtime = Context.get(context, Runtime);

  const quota = `cbx-full-${id}`;

  const faults: Partial<Faults> = {
    stall: http.stall,
    dropAnswer: http.dropAnswer,
    landLate: http.landLate,
    quota: (on) =>
      (on
        ? Effect.andThen(
            cluster.quotas.create({
              metadata: { name: quota },
              spec: { hard: { persistentvolumeclaims: "0" } },
            }),
            Effect.repeat(cluster.quotas.get(quota), {
              until: (found) => found?.status?.hard !== undefined,
              schedule: Schedule.spaced("200 millis"),
            })
          )
        : Effect.andThen(
            cluster.quotas.remove(quota),
            Effect.repeat(cluster.quotas.get(quota), {
              until: (found) => found === undefined,
              schedule: Schedule.spaced("200 millis"),
            })
          )
      ).pipe(Effect.asVoid, Effect.orDie),
    drift: (instance) =>
      Effect.gen(function* () {
        const handle = yield* runtime.find({ name: "dev", instance });

        if (handle === undefined) {
          return yield* Effect.die("drift found no machine of its instance");
        }

        yield* Effect.scoped(
          Effect.flatMap(
            runtime.exec(
              { name: "dev", instance, handle },
              { argv: ["/bin/sh", "-c", "kill -KILL -1"] }
            ),
            ({ output }) => Stream.runDrain(output)
          )
        ).pipe(Effect.ignore);

        yield* Effect.repeat(cluster.sandboxes.get(handle), {
          until: (found) => AgentSandbox.heldOf(found) === "ended",
          schedule: Schedule.spaced("500 millis"),
        });
      }).pipe(Effect.orDie),
  };

  const scope = yield* Effect.scope;

  const theirs = {
    instance: hex(16),
    name: `cbx-theirs-${hex(4)}`,
  };

  const theirClaim = `${theirs.name}-checkpoint`;

  const stillTheirs = Effect.map(
    Effect.all([
      cluster.sandboxes.get(theirs.name),
      cluster.claims.get(theirClaim),
    ]),
    (found) =>
      found.every(
        (each) =>
          each !== undefined && each.metadata.deletionTimestamp === undefined
      )
  ).pipe(Effect.orDie);

  const unmarked = Effect.gen(function* () {
    yield* cluster.claims.create({
      metadata: {
        name: theirClaim,
        labels: { "cbx-kind": "checkpoint", "cbx-source": theirs.instance },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1Gi" } },
      },
    });
    yield* cluster.sandboxes.create({
      apiVersion: "agents.x-k8s.io/v1beta1",
      kind: "Sandbox",
      metadata: {
        name: theirs.name,
        labels: { "cbx-instance": theirs.instance },
      },
      spec: {
        operatingMode: "Suspended",
        podTemplate: {
          spec: {
            containers: [
              { name: "guest", image: base, command: ["sleep", "infinity"] },
            ],
          },
        },
      },
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.ignore(
        Effect.andThen(
          cluster.sandboxes.remove(theirs.name),
          cluster.claims.remove(theirClaim)
        )
      )
    );
  }).pipe(Effect.as(stillTheirs), Effect.orDie);

  return { cluster, id, runtime, faults, unmarked, requests: http.requests };
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const fixture = Effect.map(
  hosted,
  ({ runtime, faults, unmarked }): Fixture => ({ runtime, faults, unmarked })
);

const sizes = { cpu: 1, ramMib: 512, diskGib: 2 };

const probedFromOutside = (cluster: Tester, script: string) =>
  Effect.gen(function* () {
    const name = `cbx-probe-${hex(4)}`;

    yield* cluster.pods.create({
      metadata: { name },
      spec: {
        restartPolicy: "Never",
        containers: [
          { name: "probe", image: probeImage, command: ["sh", "-c", script] },
        ],
      },
    });
    yield* Effect.addFinalizer(() => Effect.ignore(cluster.pods.remove(name)));

    const pod = yield* Effect.repeat(cluster.pods.get(name), {
      until: (found) =>
        found?.status?.containerStatuses?.[0]?.state?.terminated !== undefined,
      schedule: Schedule.spaced("500 millis"),
    });

    return pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
  }).pipe(Effect.timeout("2 minutes"));

const sshed = (
  dial: Dial,
  hostKey: string,
  identity: string,
  command: string
) =>
  Effect.gen(function* () {
    const relays = yield* Relay.make;
    let port = 23_500;
    let bound = yield* relays.bind("127.0.0.1", port);

    while (Option.isNone(bound)) {
      port += 1;
      bound = yield* relays.bind("127.0.0.1", port);
    }

    const listener = bound.value;
    const known = path.join(path.dirname(identity), "known_hosts");

    yield* listener.relay(dial);
    writeFileSync(known, `[127.0.0.1]:${port} ${hostKey}\n`);

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* spawner.string(
      ChildProcess.make("ssh", [
        "-F",
        "/dev/null",
        "-i",
        identity,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${known}`,
        "-p",
        String(port),
        "admin@127.0.0.1",
        command,
      ])
    );
  });

const keyed = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const identity = path.join(yield* scratch, "id_ed25519");

  yield* spawner.exitCode(
    ChildProcess.make("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      identity,
    ])
  );

  return {
    identity,
    publicKey: readFileSync(`${identity}.pub`, "utf8").trim(),
  };
});

const ghost = (name: string) => {
  const instance = hex(16);

  return { name, instance, handle: Handle.make(`cbx-m-${instance}`) };
};

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

        expect(Object.fromEntries(one)).toStrictEqual({ a: "missing" });
        expect(Object.fromEntries(both)).toStrictEqual({
          a: "missing",
          b: "missing",
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

  runtimeContract({
    name: "agent-sandbox adapter's",
    image: base,
    sizes: { cpu: 1, ramMib: 512, diskGib: 1 },
    stallTimeout: 600_000,
    fixture,
  });
});
