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
import { hostLayer, listening } from "./composition/host.ts";
import { runtimeLayer } from "./composition/runtimes.ts";

const run = (file: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(file);

    return yield* Layer.launch(
      hostLayer(
        config,
        runtimeLayer(config.runtime, config),
        NodeHttpServer.layer(createServer, listening(config))
      )
    );
  });

const host = Command.make(
  "clankerbox-host",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription(
        "The host config file: its ID, runtime, address, state dir and bases."
      )
    ),
  },
  ({ config }) =>
    run(config).pipe(Effect.catch((error) => Effect.die(error.message)))
).pipe(Command.withDescription("Run a clankerbox host, until it is stopped."));

NodeRuntime.runMain(
  Command.run(host, { version }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)
    )
  )
);
