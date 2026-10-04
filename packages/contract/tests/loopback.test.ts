import { createServer, type Server, type ServerResponse } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterEach, expect, test } from "vite-plus/test";
import { Client, type MachineSpec } from "../src/index.ts";
import { type StubHost, stubHost } from "./stub-host.ts";

const stubs: Array<StubHost> = [];

const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.dispose()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

/** A loopback server that answers every request with `reply`, and returns its URL. */
const answering = async (reply: (response: ServerResponse) => void): Promise<string> => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      reply(response);
    });
  });

  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
    { onExcessProperty: "ignore" },
  );

  return `http://127.0.0.1:${port}`;
};

/** Sends the reply's status and the start of its body, then drops the connection. */
const cutOff = (response: ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
  response.write('{"id":"linux_dev",');
  setTimeout(() => response.socket?.destroy(), 20);
};

const onLinux = <A, E>(url: string, use: (client: Client.Interface) => Effect.Effect<A, E>) =>
  Effect.flatMap(Client.Client, use).pipe(
    Effect.provide(Client.layer([{ id: "linux", url }])),
    Effect.runPromise,
  );

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

test("a mutation whose connection drops partway through the reply is a lost reply", async () => {
  const url = await answering(cutOff);
  const error = await onLinux(url, (client) => Effect.flip(client.start("linux_dev")));

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("may have run: read linux_dev");
});

test("a read whose connection drops partway through the reply is Unavailable and retryable", async () => {
  const url = await answering(cutOff);
  const error = await onLinux(url, (client) => Effect.flip(client.machine("linux_dev")));

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(true);
});

test("a reply that parses but isn't the action's success is Internal", async () => {
  const url = await answering((response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"id":"linux_dev"}');
  });

  const error = await onLinux(url, (client) => Effect.flip(client.start("linux_dev")));

  expect(error._tag).toBe("Internal");
  expect(error.message).toContain("host linux's reply didn't decode");
});

test("a reply that arrives whole and doesn't parse is Internal", async () => {
  const url = await answering((response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"id":"linux_dev",');
  });

  const error = await onLinux(url, (client) => Effect.flip(client.start("linux_dev")));

  expect(error._tag).toBe("Internal");
});
