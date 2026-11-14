import { once } from "node:events";
import http, { createServer } from "node:http";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { Schema } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import { agentFetch } from "../src/fetch.ts";
import { until } from "./support.ts";

const opened: Array<() => Promise<void>> = [];
const asked: Array<Promise<Response>> = [];

const prompt = { jsonrpc: "2.0", id: 7, method: "session/prompt" };

const served = async (server: Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  opened.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });

  const { port } = Schema.decodeUnknownSync(
    Schema.Struct({ port: Schema.Finite })
  )(server.address(), { onExcessProperty: "ignore" });

  return `http://127.0.0.1:${port}`;
};

const longRefusal = `bad gateway ${"x".repeat(10_000)} the end`;

const servedAgent = async () => {
  const ended: string[] = [];

  const server = createServer((request, reply) => {
    if (request.method === "DELETE") {
      reply.writeHead(204).end();

      return;
    }

    switch (request.url ?? "") {
      case "/answered":
      case "/v1/acp/answered": {
        setTimeout(() => {
          reply.writeHead(200, { "content-type": "application/json" });
          reply.end(`{"method":"${request.method}"}`);
        }, 50);

        return;
      }

      case "/v1/acp/held": {
        setTimeout(() => {
          reply.writeHead(200, { "content-type": "application/json" });
          reply.end(`{"method":"${request.method}"}`);
        }, 6000);

        return;
      }

      case "/v1/acp/cut": {
        request.resume();
        request.once("end", () => {
          reply.destroy();
        });

        return;
      }

      case "/v1/acp/refused": {
        reply.writeHead(500, { "content-type": "text/plain" });
        reply.end("no agent");

        return;
      }

      case "/v1/acp/refused-at-length": {
        reply.writeHead(502, { "content-type": "text/plain" });
        reply.end(longRefusal);

        return;
      }

      default: {
        reply.once("close", () => {
          ended.push(`${String(request.headers["x-sandbox"])} ${request.url}`);
        });
      }
    }
  });

  let connected = 0;

  server.on("connection", () => {
    connected += 1;
  });

  const url = await served(server);
  const fetches = new Map<string, typeof globalThis.fetch>();

  const send = async (
    sandbox: string,
    path: string,
    {
      method = "POST",
      message = prompt,
    }: { readonly method?: string; readonly message?: unknown } = {}
  ) => {
    const fetch =
      fetches.get(sandbox) ?? agentFetch(sandbox, () => new URL(url).origin);

    fetches.set(sandbox, fetch);

    const reply = fetch(`${url}${path}`, {
      method,
      headers: { "x-sandbox": sandbox },
      ...(method === "POST" ? { body: JSON.stringify(message) } : {}),
    });

    asked.push(reply);

    return await reply;
  };

  return { send, ended, connections: () => connected };
};

const settled = async (reply: Promise<Response>, within = 200) =>
  await Promise.race([
    reply.then(
      async (response) => ({
        status: response.status,
        body: await response.text(),
      }),
      () => "failed" as const
    ),
    sleep(within, "waiting" as const),
  ]);

const failedPrompt = (because: string) => ({
  status: 200,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32_603, message: `sandbox kept's agent: ${because}` },
  }),
});

describe("agentFetch", () => {
  const logged = vi.spyOn(console, "error");

  beforeEach(() => {
    logged.mockReset().mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const close of opened.splice(0)) {
      await close();
    }

    await Promise.allSettled(asked.splice(0));
  });

  it.each(["/answered", "/v1/acp/answered"])(
    "passes on the reply an agent's server sends to %s",
    async (path) => {
      const { send } = await servedAgent();

      const reply = await send("kept", path);

      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toBe("application/json");
      await expect(reply.json()).resolves.toStrictEqual({ method: "POST" });
    }
  );

  it.each(["localhost", "[::1]"])(
    "refuses a request to %s at the port it holds, which is held on 127.0.0.1 alone",
    async (host) => {
      const heard: string[] = [];

      const url = await served(
        createServer((request, reply) => {
          heard.push(request.url ?? "");
          reply.end();
        })
      );

      const { port } = new URL(url);
      const sent = agentFetch("kept", () => url);

      await expect(sent(`${url}/answered`)).resolves.toHaveProperty(
        "status",
        200
      );
      await expect(sent(`http://${host}:${port}/answered`)).rejects.toThrow(
        `the provider holds no port for sandbox kept at http://${host}:${port}`
      );
      expect(heard).toStrictEqual(["/answered"]);
    }
  );

  it("waits for a reply as long as the agent's server holds it", async () => {
    const { send } = await servedAgent();

    const reply = await send("kept", "/v1/acp/held");

    await expect(reply.json()).resolves.toStrictEqual({ method: "POST" });
  }, 15_000);

  it("answers a permission request while a prompt and the event stream hold sockets, whatever cap a consumer put on Node's global agent", async () => {
    const { send } = await servedAgent();
    const { maxSockets } = http.globalAgent;

    http.globalAgent.maxSockets = 2;
    onTestFinished(() => {
      http.globalAgent.maxSockets = maxSockets;
    });

    void send("kept", "/v1/acp/events", { method: "GET" }).catch(() => {});
    void send("kept", "/v1/acp/held");

    await expect(
      settled(
        send("kept", "/v1/acp/answered", {
          message: { jsonrpc: "2.0", id: 9, result: { outcome: "allow" } },
        }),
        2000
      )
    ).resolves.toStrictEqual({ status: 200, body: '{"method":"POST"}' });
  });

  it("reaches an agent's server directly while Node's global agent sends through a proxy", async () => {
    const proxied: string[] = [];

    const proxy = await served(
      createServer((request, reply) => {
        proxied.push(`${request.method} ${request.url}`);
        reply.writeHead(502).end("the proxy");
      })
    );

    const { send } = await servedAgent();

    onTestFinished(http.setGlobalProxyFromEnv({ HTTP_PROXY: proxy }));

    await expect(
      settled(send("kept", "/v1/acp/answered"), 2000)
    ).resolves.toStrictEqual({ status: 200, body: '{"method":"POST"}' });
    expect(proxied).toStrictEqual([]);
  });

  it("sends again on one connection after a reply with no body", async () => {
    const { send, connections } = await servedAgent();

    await expect(
      send("kept", "/v1/acp/one", { method: "DELETE" })
    ).resolves.toMatchObject({ status: 204, body: null });
    await expect(
      send("kept", "/v1/acp/two", { method: "DELETE" })
    ).resolves.toMatchObject({ status: 204, body: null });
    await expect(
      send("kept", "/answered", { method: "HEAD" })
    ).resolves.toMatchObject({ status: 200, body: null });

    expect(connections()).toBe(1);
  });

  it("an SDK started again and again on one sandbox, each with its own fetch, reuses the connections the last one left", async () => {
    const { send, connections } = await servedAgent();

    for (const started of Array.from({ length: 10 }, (_, at) => `kept-${at}`)) {
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          const reply = await send(started, "/answered");

          await reply.text();
        })
      );
    }

    expect(connections()).toBe(3);
  });

  it("answers a request on a connection whose reply is cut as that request's error", async () => {
    const { send } = await servedAgent();

    await expect(settled(send("kept", "/v1/acp/cut"))).resolves.toStrictEqual(
      failedPrompt("socket hang up")
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers a request a connection's server refuses as that request's error", async () => {
    const { send } = await servedAgent();

    await expect(
      settled(send("kept", "/v1/acp/refused"))
    ).resolves.toStrictEqual(failedPrompt("500 no agent"));
    expect(logged).not.toHaveBeenCalled();
  });

  it("quotes the first 600 characters of a refusal's body, in a request's error and in a lost notification's log", async () => {
    const { send } = await servedAgent();
    const because = `502 ${longRefusal.slice(0, 600)}`;

    await expect(
      settled(send("kept", "/v1/acp/refused-at-length"))
    ).resolves.toStrictEqual(failedPrompt(because));
    await expect(
      settled(
        send("kept", "/v1/acp/refused-at-length", {
          message: { jsonrpc: "2.0", method: "session/cancel" },
        })
      )
    ).resolves.toStrictEqual({ status: 202, body: "" });
    expect(logged.mock.calls).toStrictEqual([
      [`ACP write error: sandbox kept's agent: ${because}`],
    ]);
  });

  it.each([
    { path: "/v1/acp/cut", because: "socket hang up" },
    { path: "/v1/acp/refused", because: "500 no agent" },
  ])(
    "takes a notification or an answer posted to $path as accepted, and logs its loss",
    async ({ path, because }) => {
      const { send } = await servedAgent();

      for (const message of [
        { jsonrpc: "2.0", method: "session/cancel" },
        { jsonrpc: "2.0", id: 3, result: {} },
      ]) {
        await expect(
          settled(send("kept", path, { message }))
        ).resolves.toStrictEqual({ status: 202, body: "" });
      }

      expect(logged.mock.calls).toStrictEqual([
        [`ACP write error: sandbox kept's agent: ${because}`],
        [`ACP write error: sandbox kept's agent: ${because}`],
      ]);
    }
  );

  it("lets go of what waits on an agent's connection once the client closes it", async () => {
    const { send, ended } = await servedAgent();

    const closed = send("kept", "/v1/acp/one");
    const open = send("kept", "/v1/acp/two");
    const otherSandbox = send("other", "/v1/acp/one");

    await sleep(50);
    await send("kept", "/v1/acp/one", { method: "DELETE" });

    await until(
      "the closed connection's request to end",
      async () => ended.length > 0
    );
    await sleep(50);

    expect(ended).toStrictEqual(["kept /v1/acp/one"]);
    await expect(settled(closed)).resolves.toStrictEqual({
      status: 202,
      body: "",
    });
    await expect(settled(open)).resolves.toBe("waiting");
    await expect(settled(otherSandbox)).resolves.toBe("waiting");
    expect(logged).not.toHaveBeenCalled();
  });
});
