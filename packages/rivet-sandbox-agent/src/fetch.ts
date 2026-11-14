import { Agent, request } from "node:http";
import { Readable } from "node:stream";

import { Option, Schema } from "effect";

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

/**
 * The SDK's fetch to one sandbox's agent through its tunnel, over `node:http`, which bounds no wait
 * for a reply: the agent's server answers a prompt's POST only once its turn ends, and Node's own
 * fetch gives up on a reply's headers after 5 minutes.
 *
 * The ACP client under the SDK ends the process when a POST on its open connection fails. So a
 * request posted there that is cut or refused, as when its sandbox ends under it, is answered as
 * that request's JSON-RPC error, which rejects its caller's promise. No caller ever got the
 * client's own `AcpHttpError` for a refused POST, which it only logged before it failed its
 * connection. Any other message is answered as accepted, and its loss logged as the client logged
 * it. The client stops reading a connection before its DELETE closes it, so nothing answered there
 * after that reaches a caller, and a request still waiting there never settles; the DELETE lets go
 * of the POSTs still waiting on the connection, so their sockets don't keep the process alive.
 *
 * Every sandbox's fetch sends through one agent of the provider's own, so how its consumer set up
 * Node's global agent, a cap on its sockets or a proxy taken from the environment, never reaches
 * the tunnel. Its pools are by address, and each tunnel has its own port, so an SDK started again
 * on a sandbox takes up the connections the last one left, which the agent's server keeps open as
 * long as they last. Nothing ends that agent: a socket it keeps between requests holds no process
 * alive, and ends with its tunnel.
 *
 * It sends only to `held()`, the origin of the port the provider holds for the sandbox now, and
 * fails a request to any other as one sent while the tunnel is down: once the provider lets a port
 * go, any program may listen there.
 */
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
        : lost(body, `${reply.status} ${text}`);
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
