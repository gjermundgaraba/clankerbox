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

/** major.minor: releases that share it speak the same API, the runtime traits' values included. */
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

const encodeInvalid = Schema.encodeSync(Invalid);

/**
 * Refuses a caller of another release than `own`, this package's by default, for a server of either
 * contract, before it reads anything, so a client never meets a trait value its release doesn't
 * know and a mutation it sends is never run.
 */
export const versionCheck = (server: string, own: string = version) =>
  HttpRouter.middleware((handle) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Option.match(
        refusal(server, own, Headers.get(request.headers, versionHeader)),
        {
          onNone: () => handle,
          onSome: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(encodeInvalid(error), {
                status: 400,
              })
            ),
        }
      )
    )
  );
