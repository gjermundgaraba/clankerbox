import { Cause, Effect, Exit } from "effect";
import {
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
} from "effect/http";
import type { HttpServerResponse } from "effect/http";

const answer = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Uint8Array"
    ? [new TextDecoder().decode(response.body.body)]
    : [];

const sent = (
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
  cause: Cause.Cause<unknown> | undefined
) => {
  const faulted =
    response.status >= 500 &&
    (cause === undefined || !Cause.hasInterruptsOnly(cause));

  return Effect.annotateLogs(
    faulted
      ? Effect.logError(
          "Sent HTTP response",
          ...(cause === undefined ? answer(response) : [cause])
        )
      : Effect.logDebug("Sent HTTP response"),
    {
      "http.method": request.method,
      "http.url": request.url.split("?")[0] ?? request.url,
      "http.status": response.status,
    }
  );
};

/**
 * What a host's journal holds of the requests it serves, in place of Effect's response logger: a
 * request it answers is no line an operator acts on, so each response logs at debug, which
 * `--log-level debug` shows, and one that ends in a 5xx from a failure or a defect logs at error
 * with its cause, or the answer that carries it. A refusal the caller is told about is its caller's answer.
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
      Effect.onExit(app, (exit) =>
        Exit.isSuccess(exit)
          ? sent(request, exit.value, undefined)
          : Effect.flatMap(
              HttpServerError.causeResponse(exit.cause),
              ([response]) => sent(request, response, exit.cause)
            )
      )
    )
);
