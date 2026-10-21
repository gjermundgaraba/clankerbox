import { createServer } from "node:http";
import { hostLayer } from "@clankerbox/host";
import { loadConfig } from "@clankerbox/host/config";
import { runtimeLayer } from "@clankerbox/host/runtimes";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import { failText } from "./command.ts";

const run = (file: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(file);

    return yield* Layer.launch(
      hostLayer(
        config,
        runtimeLayer(config),
        NodeHttpServer.layer(createServer, {
          host: config.listen.address,
          port: config.listen.port,
        }),
      ),
    );
  });

export const host = Command.make(
  "host",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription("The host config file: its ID, kind, address, state dir and bases."),
    ),
  },
  ({ config }) => run(config).pipe(Effect.catch(failText)),
).pipe(Command.withDescription("Run a clankerbox host, until it is stopped."));
