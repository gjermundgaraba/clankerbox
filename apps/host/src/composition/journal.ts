import { Cause, Effect, Exit, Option } from "effect";
import {
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
} from "effect/http";
import type { HttpServerResponse } from "effect/http";

const internalStatus = 500;

const answer = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Uint8Array"
    ? [new TextDecoder().decode(response.body.body)]
    : [];

/**
 * What a host's journal holds of the requests it serves, in place of Effect's response logger, as
 * the control plane's: a request whose answer is a 500, `Internal` or one Effect gives a failure no
 * action declares, logs at error, with that answer or that cause. A request cut short, by its
 * caller or by the host's stop, logs nothing: Effect answers it with a response it adds to the
 * cause, which is stripped. Any other answer, a refusal included, is its caller's, and logs at
 * debug, which `--log-level debug` shows.
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

        if (Exit.isSuccess(exit)) {
          const status = { ...fields, "http.status": exit.value.status };

          return exit.value.status === internalStatus
            ? Effect.annotateLogs(
                Effect.logError(
                  "a request answered Internal",
                  ...answer(exit.value)
                ),
                status
              )
            : Effect.annotateLogs(
                Effect.logDebug("Sent HTTP response"),
                status
              );
        }

        const [response, cause] = HttpServerError.causeResponseStripped(
          exit.cause
        );

        const status = { ...fields, "http.status": response.status };

        if (Option.isNone(cause) || Cause.hasInterruptsOnly(cause.value)) {
          return Effect.void;
        }

        return response.status === internalStatus
          ? Effect.annotateLogs(
              Effect.logError("a request failed", cause.value),
              status
            )
          : Effect.annotateLogs(Effect.logDebug("Sent HTTP response"), status);
      })
    )
);
