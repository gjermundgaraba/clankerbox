import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { main, type Role, teardown } from "./roles.ts";

const role: Role = { host: false };

main(role).pipe(
  Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  NodeRuntime.runMain({ teardown: teardown(role) }),
);
