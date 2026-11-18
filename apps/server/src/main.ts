#!/usr/bin/env node
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";

import { loadConfig } from "./composition/config.ts";
import { controlPlaneServer, serverLayer } from "./composition/server.ts";
import * as Tailscale from "./platform/tailscale.ts";

const run = (file: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(file);

    return yield* Layer.launch(
      serverLayer(
        config,
        controlPlaneServer(config),
        config.tailnet === undefined
          ? Layer.empty
          : Tailscale.layer(config.tailnet)
      )
    );
  });

const server = Command.make(
  "clankerbox-server",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription(
        "The control plane's config file: its address, state dir, hosts and tailnet."
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
