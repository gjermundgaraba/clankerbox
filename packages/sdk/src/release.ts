import { Effect, Option, Schema } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import packageJson from "../package.json" with { type: "json" };
import { Invalid } from "./errors.ts";

/** Also the version of the clankerbox CLI released with it. */
export const version: string = packageJson.version;

/** major.minor: releases that share it speak the same API. */
export const release = (of: string): string =>
  of.split(".").slice(0, 2).join(".");

/** The control plane and a host refuse a request whose `release` differs from their own, or that has none. */
export const versionHeader = "clankerbox-version";

const refusal = (
  server: string,
  own: string,
  sent: Option.Option<string>
): Option.Option<Invalid> =>
  Option.match(sent, {
    onNone: () =>
      Option.some(
        new Invalid({
          message: `the request carries no ${versionHeader} header; this ${server} runs clankerbox ${own} and serves only callers of release ${release(own)}`,
        })
      ),
    onSome: (caller) =>
      release(caller) === release(own)
        ? Option.none()
        : Option.some(
            new Invalid({
              message: `this ${server} runs clankerbox ${own} and the caller is ${caller}; their major.minor must match`,
            })
          ),
  });

const fromBrowser = (
  server: string,
  origin: Option.Option<string>
): Option.Option<Invalid> =>
  Option.map(
    origin,
    (sent) =>
      new Invalid({
        message: `this ${server} takes no request that carries Origin, as a browser's does, and this one carries ${sent}: a proxy in front of it must not add Origin`,
      })
  );

const encodeInvalid = Schema.encodeSync(Invalid);

const refused = (error: Invalid) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(encodeInvalid(error), { status: 400 })
  );

/**
 * Refuses a caller of another release than `own`, this package's by default, for a server of either
 * contract, before it reads anything, so a mutation it sends is never run under a contract it
 * doesn't share.
 *
 * It refuses a request that carries `Origin` too. A browser sends `Origin` with every POST, which
 * every action is, and no caller of ours does, so a page whose name was rebound to the server's
 * address can't act on it, whatever name it was reached by. That page is same-origin to its
 * browser, so its `Origin` names the `Host` it sent: refusing only an `Origin` that differs from
 * `Host` would leave it open. `Host` is left unchecked: a server is reached by its IP, by a
 * MagicDNS name or through a proxy, so an allowlist of names would need config, and refusing
 * `Origin` already refuses the rebound page.
 *
 * Both refusals are `Invalid` at 400, which a client reads with its message. A 403 is each action's
 * built-in `Forbidden`, which a client reads only as an answer it didn't expect.
 */
export const versionCheck = (server: string, own: string = version) =>
  HttpRouter.middleware((handle) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Option.match(
        fromBrowser(server, Headers.get(request.headers, "origin")),
        {
          onSome: refused,
          onNone: () =>
            Option.match(
              refusal(server, own, Headers.get(request.headers, versionHeader)),
              { onNone: () => handle, onSome: refused }
            ),
        }
      )
    )
  );
