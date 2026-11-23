import { Agent, request } from "node:http";
import { Readable } from "node:stream";

import { Option, Schema } from "effect";

import { quoted } from "./tunnel.ts";

const bodiless = new Set([204, 205, 304]);

const onAcpConnection = (pathname: string) => pathname.startsWith("/v1/acp/");

const AcpRequest = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Finite]),
  method: Schema.String,
});

const decodeAcpRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(AcpRequest)
);

const sent = async (
  agent: Agent,
  asked: Request,
  body: Uint8Array | undefined,
  signal: AbortSignal
) => {
  const replied = Promise.withResolvers<Response>();

  const outgoing = request(
    asked.url,
    {
      agent,
      method: asked.method,
      headers: Object.fromEntries(asked.headers),
      signal,
    },
    (reply) => {
      const status = reply.statusCode;

      // A reply a client reads always has a status, which the types leave optional for a request a
      // server reads: https://nodejs.org/api/http.html#messagestatuscode
      if (status === undefined) {
        replied.reject(new TypeError("a reply came with no status"));

        return;
      }

      const headers = new Headers();

      for (const [name, value] of Object.entries(reply.headers)) {
        for (const each of [value ?? []].flat()) {
          headers.append(name, each);
        }
      }

      const dropped = bodiless.has(status) || asked.method === "HEAD";

      if (dropped) {
        reply.resume();
      }

      replied.resolve(
        new Response(dropped ? null : Readable.toWeb(reply), {
          status,
          statusText: reply.statusMessage ?? "",
          headers,
        })
      );
    }
  );

  outgoing.once("error", replied.reject);
  outgoing.end(body);

  return await replied.promise;
};

const accepted = () => new Response(null, { status: 202 });

const agent = new Agent({ keepAlive: true });

export const agentFetch = (
  sandbox: string,
  held: () => string | undefined
): typeof globalThis.fetch => {
  const connections = new Map<string, AbortController>();

  const send = async (
    asked: Request,
    body: Uint8Array | undefined,
    signal: AbortSignal
  ) => {
    const { origin } = new URL(asked.url);

    if (origin !== held()) {
      throw new Error(
        `the provider holds no port for sandbox ${sandbox} at ${origin}`
      );
    }

    return await sent(agent, asked, body, signal);
  };

  const closed = (pathname: string) => {
    connections.get(pathname)?.abort();
    connections.delete(pathname);
  };

  const open = (pathname: string) => {
    const connection = connections.get(pathname) ?? new AbortController();

    connections.set(pathname, connection);

    return connection.signal;
  };

  const lost = (body: Uint8Array | undefined, because: string) => {
    const failure = `sandbox ${sandbox}'s agent: ${because}`;

    return Option.match(decodeAcpRequest(new TextDecoder().decode(body)), {
      onNone: () => {
        console.error(`ACP write error: ${failure}`);

        return accepted();
      },
      onSome: ({ id }) =>
        Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32_603, message: failure },
        }),
    });
  };

  const posted = async (
    asked: Request,
    body: Uint8Array | undefined,
    connection: AbortSignal
  ) => {
    try {
      const reply = await send(
        asked,
        body,
        AbortSignal.any([asked.signal, connection])
      );

      const text = await reply.text();

      return reply.ok
        ? new Response(text === "" ? null : text, {
            status: reply.status,
            statusText: reply.statusText,
            headers: reply.headers,
          })
        : lost(body, `${reply.status} ${text.slice(0, quoted)}`);
    } catch (error) {
      return connection.aborted
        ? accepted()
        : lost(body, error instanceof Error ? error.message : String(error));
    }
  };

  return async (input, init) => {
    const asked = new Request(input, init);
    const { pathname } = new URL(asked.url);
    const onConnection = onAcpConnection(pathname);

    if (onConnection && asked.method === "DELETE") {
      closed(pathname);
    }

    const connection =
      onConnection && asked.method === "POST" ? open(pathname) : undefined;

    const body = asked.body === null ? undefined : await asked.bytes();

    return connection === undefined
      ? await send(asked, body, asked.signal)
      : await posted(asked, body, connection);
  };
};
