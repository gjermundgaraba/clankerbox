import { existsSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { Schema } from "effect";

const Rpc = Schema.Struct({
  id: Schema.optionalKey(Schema.Finite),
  method: Schema.String,
});

const decodeRpc = Schema.decodeUnknownSync(Schema.fromJsonString(Rpc));

const resultOf = (method: string) => {
  switch (method) {
    case "initialize": {
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
    }

    case "session/new": {
      return { sessionId: "agent-session" };
    }

    default: {
      return null;
    }
  }
};

const body = async (request: IncomingMessage): Promise<string> => {
  let text = "";

  for await (const chunk of request) {
    text += String(chunk);
  }

  return text;
};

const json = (reply: ServerResponse, status: number, value: unknown) => {
  reply.writeHead(status, { "content-type": "application/json" });
  reply.end(JSON.stringify(value));
};

/**
 * A stand-in Sandbox Agent server: its health check and one agent's ACP endpoint. A file in `dir`
 * sets how it answers: `unhealthy` fails the health check, `hold-replies` sends each answer on the
 * event stream and never on its POST, `cut-prompts` cuts a prompt's POST, and `hold-prompts` never
 * answers a prompt, writing `prompted` once one comes.
 */
export const fakeAgent = (dir: string) => {
  const flagged = (flag: string) => existsSync(path.join(dir, flag));
  const streams = new Set<ServerResponse>();
  const unsent: string[] = [];

  const send = (event: string) => {
    if (streams.size === 0) {
      unsent.push(event);
    }

    for (const stream of streams) {
      stream.write(event);
    }
  };

  const acp = async (request: IncomingMessage, reply: ServerResponse) => {
    if (request.method === "GET") {
      reply.writeHead(200, { "content-type": "text/event-stream" });
      reply.flushHeaders();
      streams.add(reply);

      for (const event of unsent.splice(0)) {
        reply.write(event);
      }

      reply.on("close", () => {
        streams.delete(reply);
      });

      return;
    }

    if (request.method === "DELETE") {
      for (const stream of streams) {
        stream.end();
      }

      reply.writeHead(204).end();

      return;
    }

    const rpc = decodeRpc(await body(request));

    if (rpc.method === "session/prompt" && flagged("cut-prompts")) {
      reply.destroy();

      return;
    }

    if (rpc.method === "session/prompt" && flagged("hold-prompts")) {
      writeFileSync(path.join(dir, "prompted"), "");

      return;
    }

    if (rpc.id === undefined) {
      reply.writeHead(202).end();

      return;
    }

    const answer = {
      jsonrpc: "2.0",
      id: rpc.id,
      result: resultOf(rpc.method),
    };

    if (flagged("hold-replies")) {
      send(`data: ${JSON.stringify(answer)}\n\n`);

      return;
    }

    json(reply, 200, answer);
  };

  return (request: IncomingMessage, reply: ServerResponse) => {
    if (request.url?.startsWith("/v1/acp/") === true) {
      void acp(request, reply);

      return;
    }

    const healthy = !flagged("unhealthy");

    json(reply, healthy ? 200 : 503, { status: healthy ? "ok" : "down" });
  };
};
