/**
 * The host role as main.ts runs it, with the teardown main.ts gives `clankerbox host`, over the
 * fake runtime: smolvm needs root on Linux. The signal tests run it as its own process. Its
 * arguments are a scratch directory and the loopback port to listen on.
 */
import { join } from "node:path";
import { hostLayer } from "@clankerbox/host";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { fakeRuntime } from "../../../packages/host/tests/fake-runtime.ts";
import { loopbackServer } from "../../../packages/host/tests/support.ts";
import { asHost, type Role, teardown } from "../src/roles.ts";

const [dir = "", port = ""] = process.argv.slice(2);

const config = {
  id: "linux",
  runtime: "smolvm",
  listen: { address: "127.0.0.1", port: Number(port) },
  stateDir: join(dir, "state"),
  bases: new Map([["ubuntu", "mirror.gcr.io/library/ubuntu@sha256:f144"]]),
  machinePorts: { first: 21_000, last: 21_099 },
} as const;

const role: Role = { host: false };

asHost(
  role,
  Layer.launch(
    hostLayer(config, () => fakeRuntime({ dir }).layer, loopbackServer(config.listen.port)),
  ),
).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain({ teardown: teardown(role) }));
