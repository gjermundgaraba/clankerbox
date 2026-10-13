/**
 * `clankerbox host`: the host role, run in the same binary as the CLI. Its composition root: the
 * config's runtime, and Node's HTTP server on the config's address.
 */
import { createServer } from "node:http";
import { hostLayer } from "@clankerbox/host";
import { loadConfig } from "@clankerbox/host/config";
import { runtimeLayer } from "@clankerbox/host/runtimes";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import { fail } from "./command.ts";

/** Runs the host from the config file at `file` until the process is stopped. */
const run = (file: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(file);

    return yield* Layer.launch(
      hostLayer(
        config,
        (recordNative) => runtimeLayer(config, recordNative),
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
      Flag.withDescription("The host config file: its ID, runtime, address, state dir and bases."),
    ),
  },
  ({ config }) => run(config).pipe(Effect.catch(fail(false))),
).pipe(Command.withDescription("Run a clankerbox host, until it is stopped."));
