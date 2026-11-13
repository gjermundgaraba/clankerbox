import { Cause, Effect, Exit } from "effect";
import { HttpMiddleware, HttpServerRequest } from "effect/http";
import type { HttpServerResponse } from "effect/http";

const internalStatus = 500;

const answer = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Uint8Array"
    ? [new TextDecoder().decode(response.body.body)]
    : [];

/**
 * What a host's journal holds of the requests it serves, in place of Effect's response logger, as
 * the control plane's: a request that answers `Internal`, with that answer, or fails as no declared
 * error does, with its cause, logs at error. Any other answer, a refusal included, is its caller's,
 * and logs at debug, which `--log-level debug` shows.
 */
export const journal = HttpMiddleware.make(
  <E, R>(
    app: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest
    >
  ) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.onExit(app, (exit) => {
        const fields = {
          "http.method": request.method,
          "http.url": request.url,
        };

        if (Exit.isFailure(exit)) {
          return Cause.hasInterruptsOnly(exit.cause)
            ? Effect.void
            : Effect.annotateLogs(
                Effect.logError("a request failed", exit.cause),
                fields
              );
        }

        const status = { ...fields, "http.status": exit.value.status };

        return exit.value.status === internalStatus
          ? Effect.annotateLogs(
              Effect.logError(
                "a request answered Internal",
                ...answer(exit.value)
              ),
              status
            )
          : Effect.annotateLogs(Effect.logDebug("Sent HTTP response"), status);
      })
    )
);
