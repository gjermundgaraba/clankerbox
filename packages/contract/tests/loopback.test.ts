import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterEach, expect, test } from "vite-plus/test";
import { Client, type MachineSpec } from "../src/index.ts";
import { type StubHost, stubHost } from "./stub-host.ts";

const stubs: Array<StubHost> = [];

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.dispose()));
});

const spec: MachineSpec = { base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 };

/** Serves `stub` on a loopback port for the scope and returns its URL. */
const serve = (stub: StubHost) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      HttpRouter.serve(stub.routes, { disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );

    const server = yield* Effect.provide(HttpServer.HttpServer, context);

    return HttpServer.formatAddress(server.address);
  });

test("the client's Node transport calls a real loopback host", async () => {
  const linux = stubHost({ id: "linux", bases: ["ubuntu"] });

  stubs.push(linux);

  const made = await Effect.gen(function* () {
    const url = yield* serve(linux);

    return yield* Effect.provide(
      Effect.flatMap(Client.Client, (client) => client.create("dev", spec)),
      Client.layer([
        { id: "mac", url: "http://127.0.0.1:1" },
        { id: "linux", url },
      ]),
    );
  }).pipe(Effect.scoped, Effect.runPromise);

  expect(made.id).toBe("linux_dev");
  expect(linux.creates).toHaveLength(1);
});

test("a refused connection is Unavailable through the Node transport", async () => {
  const error = await Effect.flatMap(Client.Client, (client) =>
    Effect.flip(client.start("linux_dev")),
  ).pipe(
    Effect.provide(Client.layer([{ id: "linux", url: "http://127.0.0.1:1" }])),
    Effect.runPromise,
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("ECONNREFUSED");
});
