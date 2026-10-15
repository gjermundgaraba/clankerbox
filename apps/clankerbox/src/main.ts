import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { isSea } from "node:sea";
import { Effect, Layer, Option } from "effect";
import { main } from "./clankerbox.ts";
import { Dial } from "./ssh.ts";
import { Executable } from "./ssh-config.ts";

main.pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerNodeHttp,
      Layer.succeed(Dial, (host, port) =>
        NodeSocket.makeNet({ host, port, openTimeout: "10 seconds" }),
      ),
      Layer.succeed(Executable, isSea() ? Option.some(process.execPath) : Option.none()),
    ),
  ),
  NodeRuntime.runMain,
);
