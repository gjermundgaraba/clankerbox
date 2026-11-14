#!/usr/bin/env node
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Effect, Layer } from "effect";

import { main } from "./clankerbox.ts";
import { Environment, environmentOf } from "./machines/commands.ts";
import { Dial } from "./ssh.ts";

NodeRuntime.runMain(
  main.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeHttpClient.layerNodeHttp,
        Layer.sync(Environment, () => environmentOf()),
        Layer.succeed(Dial, (host, port) =>
          NodeSocket.makeNet({ host, port, openTimeout: "10 seconds" })
        )
      )
    )
  )
);
