import { once } from "node:events";
import { connect, createServer } from "node:net";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";

import { listen } from "../src/relay.ts";
import { cleanUp, cleanups, scratch } from "./support.ts";

const agentEndingFirst = async () => {
  const socket = path.join(await scratch(), "agent.sock");
  const heard = Promise.withResolvers<string>();

  const agent = createServer({ allowHalfOpen: true }, (connection) => {
    let got = "";

    connection.setEncoding("utf-8");
    connection.on("data", (chunk: string) => {
      got += chunk;
    });
    connection.once("end", () => {
      heard.resolve(got);
      connection.destroy();
    });
    connection.end("hello");
  });

  agent.listen(socket);
  await once(agent, "listening");
  cleanups.push(async () => {
    agent.close();
  });

  return { socket, heard: heard.promise };
};

const answering = async (port: number) => {
  const got = Promise.withResolvers<string>();
  const client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let said = "";

  client.setEncoding("utf-8");
  client.on("data", (chunk: string) => {
    said += chunk;
  });
  client.once("end", () => {
    got.resolve(said);
    client.end("late");
  });
  client.once("error", got.reject);

  return await got.promise;
};

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  afterEach(cleanUp);

  it.effect(
    "an agent that ends its side of a connection first still hears what its client sends after",
    () =>
      Effect.gen(function* () {
        const { socket, heard } = yield* Effect.promise(agentEndingFirst);
        const { port } = yield* listen("kept", () => socket);

        const greeted = yield* Effect.promise(
          async () => await answering(port)
        );

        expect({
          greeted,
          heard: yield* Effect.promise(async () => await heard),
        }).toStrictEqual({ greeted: "hello", heard: "late" });
      }).pipe(Effect.scoped)
  );
});
