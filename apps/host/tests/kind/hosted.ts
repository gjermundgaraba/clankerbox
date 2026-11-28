import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Context,
  Duration,
  Effect,
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
import { vi } from "vite-plus/test";

import * as AgentSandbox from "../../src/platform/agent-sandbox/agent-sandbox.ts";
import * as Api from "../../src/platform/agent-sandbox/api.ts";
import * as Relay from "../../src/platform/relay.ts";
import { SweepEvery } from "../../src/platform/tombstones.ts";
import type { Dial } from "../../src/runtime.ts";
import { Handle, Runtime } from "../../src/runtime.ts";
import { faultyHttp } from "../platform/faulty-http.ts";
import type { Faults, Fixture } from "../runtime-contract.ts";

export const dir = process.env["CLANKERBOX_KIND"] ?? "";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

export const base =
  "debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2";

export const probeImage =
  "busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";

export const hex = (bytes: number) =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

const fromCluster = (file: string) =>
  readFileSync(path.join(dir, file), "utf8").trim();

const settingsOf = () => ({
  namespace: fromCluster("namespace"),
  api: fromCluster("api"),
  tokenFile: path.join(dir, "host-token"),
  caFile: path.join(dir, "ca.crt"),
  storageClass: fromCluster("storage-class"),
});

const tester = Effect.gen(function* () {
  const settings = settingsOf();

  const http = yield* Layer.build(AgentSandbox.http1Layer(settings));

  const api = yield* Api.make(
    settings.api,
    Effect.succeed(Redacted.make(fromCluster("tester-token")))
  ).pipe(Effect.provide(http));

  const paths = Api.paths(settings.namespace);

  return {
    sandboxes: api.resource(paths.sandboxes, Api.Sandbox),
    claims: api.resource(paths.claims, Api.Claim),
    pods: api.resource(paths.pods, Api.Pod),
    snapshots: api.resource(paths.snapshots, Api.Snapshot),
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

      for (const kind of [
        cluster.sandboxes,
        cluster.pods,
        cluster.snapshots,
        cluster.claims,
      ]) {
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

export const hosted = Effect.gen(function* () {
  const cluster = yield* tester;
  const settings = settingsOf();
  const id = `kind-${hex(4)}`;
  const http = faultyHttp(AgentSandbox.http1Layer(settings));

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

export const fixture = Effect.map(
  hosted,
  ({ runtime, faults, unmarked }): Fixture => ({ runtime, faults, unmarked })
);

export const sizes = { cpu: 1, ramMib: 512, diskGib: 2 };

export const probedFromOutside = (cluster: Tester, script: string) =>
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

export const sshed = (
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

export const keyed = Effect.gen(function* () {
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

export const ghost = (name: string) => {
  const instance = hex(16);

  return { name, instance, handle: Handle.make(`cbx-m-${instance}`) };
};
