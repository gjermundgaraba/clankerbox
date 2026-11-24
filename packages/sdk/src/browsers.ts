import { Effect, Option, Schema } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { Invalid } from "./errors.ts";

const encodeInvalid = Schema.encodeSync(Invalid);

/**
 * Refuses a request that carries `Origin`, for a server of either contract, before it reads
 * anything. A page whose name was rebound to the server's address is same-origin to its browser,
 * and could otherwise act on every machine. A browser sends `Origin` with every POST, which every
 * action is, and no caller of ours does.
 *
 * It holds whether or not the server authenticates its callers. With `tokens` on the control plane
 * or `callers` on a host, `requireToken` refuses, after this, a request without a token it takes,
 * and a page can't send a caller's token unless it holds one. Without them nothing authenticates a
 * caller, so this refusal is all that keeps such a page off the server.
 *
 * That page's `Origin` names the `Host` it sent, so refusing only an `Origin` that differs from
 * `Host` would leave it open.
 *
 * It answers `Invalid` at 400, which a client reads with its message.
 */
export const refuseBrowsers = (server: string) =>
  HttpRouter.middleware((handle) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Option.match(Headers.get(request.headers, "origin"), {
        onNone: () => handle,
        onSome: (sent) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              encodeInvalid(
                new Invalid({
                  message: `this ${server} takes no request that carries Origin, as a browser's does, and this one carries ${sent}: a proxy in front of it must not add Origin`,
                })
              ),
              { status: 400 }
            )
          ),
      })
    )
  );
