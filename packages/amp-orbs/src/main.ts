#!/usr/bin/env node
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { main } from "./provider.ts";

NodeRuntime.runMain(
  main.pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)
    )
  )
);
