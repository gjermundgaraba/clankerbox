import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { afterEach, describe, expect } from "vite-plus/test";

import { Client, retryable } from "../src/index.ts";
import type { MachineSpec } from "../src/index.ts";
import * as NodeClient from "../src/node.ts";
import { stubServer } from "./stub-server.ts";
import type { StubServer } from "./stub-server.ts";

const stubs: StubServer[] = [];

const answering = (reply: (response: ServerResponse) => void) =>
  Effect.gen(function* () {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        reply(response);
      });
    });

    yield* Effect.acquireRelease(
      Effect.callback((resume) => {
        server.listen(0, "127.0.0.1", () => {
          resume(Effect.void);
        });
      }),
      () =>
        Effect.callback((resume) => {
          server.close(() => {
            resume(Effect.void);
          });
        })
    );

    const { port } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ port: Schema.Finite })
    )(server.address(), { onExcessProperty: "ignore" });

    return `http://127.0.0.1:${port}`;
  });

const cutOff = (response: ServerResponse) => {
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": "1000",
  });
  response.write('{"id":"dev",');
  setTimeout(() => {
    response.socket?.destroy();
  }, 20);
};

const calling = <A, E>(
  url: string,
  use: (client: Client.Interface) => Effect.Effect<A, E>
) =>
  Effect.flatMap(Client.Client, use).pipe(
    Effect.provide(NodeClient.layer(url))
  );

const spec: MachineSpec = {
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
};

const serve = (stub: StubServer) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      HttpRouter.serve(stub.routes, { disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
        )
      )
    );

    const server = yield* Effect.provide(HttpServer.HttpServer, context);

    return HttpServer.formatAddress(server.address);
  });

describe("loopback", () => {
  afterEach(async () => {
    await Promise.all(
      stubs.splice(0).map(async (stub) => {
        await stub.dispose();
      })
    );
  });

  it.effect("the client's Node transport calls a real loopback server", () =>
    Effect.gen(function* () {
      const stub = stubServer();

      stubs.push(stub);

      const made = yield* Effect.gen(function* () {
        const url = yield* serve(stub);

        return yield* calling(url, (client) => client.create("dev", spec));
      }).pipe(Effect.scoped);

      expect(made).toMatchObject({ id: "dev", phase: "settled" });
      expect(stub.creates).toHaveLength(1);
    })
  );

  it.effect(
    "a refused connection is Unavailable through the Node transport",
    () =>
      Effect.gen(function* () {
        const error = yield* calling("http://127.0.0.1:1", (client) =>
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        expect(error._tag).toBe("Unavailable");
        expect(retryable(error)).toBe(false);
        expect(error.message).toContain("ECONNREFUSED");
      })
  );

  it.effect(
    "a mutation whose connection drops partway through the reply is a lost reply",
    () =>
      Effect.gen(function* () {
        const url = yield* answering(cutOff);

        const error = yield* calling(url, (client) =>
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        expect(error._tag).toBe("Unavailable");
        expect(retryable(error)).toBe(false);
        expect(error.message).toContain("may have run: read dev");
      })
  );

  it.effect(
    "a read whose connection drops partway through the reply is Unavailable and retryable",
    () =>
      Effect.gen(function* () {
        const url = yield* answering(cutOff);

        const error = yield* calling(url, (client) =>
          Effect.flip(client.getMachine({ id: "dev" }))
        );

        expect(error._tag).toBe("Unavailable");
        expect(retryable(error)).toBe(true);
      })
  );

  it.effect(
    "a reply that parses but isn't the action's success is Internal",
    () =>
      Effect.gen(function* () {
        const url = yield* answering((response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"id":"dev"}');
        });

        const error = yield* calling(url, (client) =>
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain(
          "the control plane's reply didn't decode"
        );
      })
  );

  it.effect(
    "a proxy's page at a status the action declares is Internal, or at 503 a control plane that didn't answer, through the Node transport",
    () =>
      Effect.gen(function* () {
        for (const status of [400, 404, 500, 503] as const) {
          const url = yield* answering((response) => {
            response.writeHead(status, { "content-type": "text/html" });
            response.end(`<html><body>${status}</body></html>`);
          });

          const error = yield* calling(url, (client) =>
            Effect.flip(client.pauseMachine({ id: "dev" }))
          );

          expect(error, `${status}`).toMatchObject(
            status === 503
              ? { _tag: "Unavailable", readOnly: false }
              : { _tag: "Internal" }
          );
          expect(error.message, `${status}`).toBe(
            status === 503
              ? "no reply from the control plane to pauseMachine dev (HTTP 503); the action may have run: read dev to see"
              : `the control plane answered pauseMachine dev unexpectedly: Decode error (${status} POST ${url}/api/pauseMachine)`
          );
        }
      }).pipe(Effect.scoped)
  );

  it.effect("a reply that arrives whole and doesn't parse is Internal", () =>
    Effect.gen(function* () {
      const url = yield* answering((response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"id":"dev",');
      });

      const error = yield* calling(url, (client) =>
        Effect.flip(client.startMachine({ id: "dev" }))
      );

      expect(error._tag).toBe("Internal");
    })
  );
});
