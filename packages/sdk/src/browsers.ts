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
 * anything. Nothing authenticates a caller, so this is what keeps a web page off the server: a
 * page whose name was rebound to the server's address is same-origin to its browser, and could
 * otherwise act on every machine. A browser sends `Origin` with every POST, which every action is,
 * and no caller of ours does.
 *
 * That page's `Origin` names the `Host` it sent, so refusing only an `Origin` that differs from
 * `Host` would leave it open. `Host` is left unchecked: a server is reached by its IP, by a MagicDNS
 * name or through a proxy, so an allowlist of names would need config, and refusing `Origin`
 * already refuses the rebound page.
 *
 * It answers `Invalid` at 400, which a client reads with its message. A 403 is each action's
 * built-in `Forbidden`, which a client reads only as an answer it didn't expect.
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
