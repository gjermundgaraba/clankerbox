#!/usr/bin/env node
import { createServer } from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";

import { loadConfig } from "./composition/config.ts";
import { serverLayer } from "./composition/server.ts";

const run = (file: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(file);

    return yield* Layer.launch(
      serverLayer(
        config,
        NodeHttpServer.layer(createServer, {
          host: config.listen.address,
          port: config.listen.port,
        })
      )
    );
  });

const server = Command.make(
  "clankerbox-server",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription(
        "The control plane's config file: its address, state dir and hosts."
      )
    ),
  },
  ({ config }) =>
    run(config).pipe(Effect.catch((error) => Effect.die(error.message)))
).pipe(
  Command.withDescription(
    "Run the clankerbox control plane, until it is stopped."
  )
);

NodeRuntime.runMain(
  Command.run(server, { version }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)
    )
  )
);
