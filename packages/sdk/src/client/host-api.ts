import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Effect, Match } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { Http } from "../api.ts";
import {
  Capacity,
  type ClankerboxError,
  Conflict,
  Internal,
  Invalid,
  NotFound,
  Precondition,
  Unavailable,
} from "../errors.ts";
import { version, versionHeader } from "../release.ts";
import type { Host } from "../resources.ts";
import type { HostEntry } from "./client.ts";

/**
 * Input that doesn't encode fails as `InvalidInput` before anything is sent, so a `SchemaError`
 * that reaches `settle` is a reply that didn't decode.
 */
export const hostApi = (entry: HostEntry) =>
  ActionHttp.client(Http, {
    baseUrl: entry.url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader(versionHeader, version)),
  });

export type HostApi = Effect.Success<ReturnType<typeof hostApi>>;

export type CallError = ActionHttp.MethodError<(typeof Http.actions)[number]>;

export type Contract = Pick<Action.Any, "name" | "readOnly">;

export interface CallContext {
  readonly host: HostEntry;
  readonly timeout: Duration.Duration | undefined;
  readonly contract: Contract;
  readonly what: string;
  readonly target?: string | undefined;
}

const causeDetail = (error: HttpClientError.HttpClientError): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

const unanswered = (context: CallContext, detail: string): Unavailable =>
  context.contract.readOnly
    ? new Unavailable({
        message: `host ${context.host.id} (${context.host.url}) didn't answer ${context.what}: ${detail}`,
        readOnly: context.contract.readOnly,
      })
    : new Unavailable({
        message: `no reply from host ${context.host.id} to ${context.what} (${detail}); the action may have run: read ${context.target ?? "the resource"} to see`,
        readOnly: context.contract.readOnly,
      });

const bounded = <A>(
  call: Effect.Effect<A, CallError>,
  context: CallContext,
): Effect.Effect<A, CallError | Unavailable> => {
  const { timeout } = context;

  return timeout === undefined
    ? call
    : Effect.timeoutOrElse(call, {
        duration: timeout,
        orElse: () =>
          Effect.fail(unanswered(context, `timed out after ${Duration.format(timeout)}`)),
      });
};

const unexpected = (context: CallContext, error: { readonly message: string }): Internal =>
  new Internal({
    message: `host ${context.host.id} answered ${context.what} unexpectedly: ${error.message}`,
  });

const locate = (error: ClankerboxError, context: CallContext): ClankerboxError => {
  const host = context.host.id;
  const action = context.contract.name;

  const where =
    context.target === undefined ? { host, action } : { host, action, id: context.target };

  return Match.value(error).pipe(
    Match.tagsExhaustive({
      Invalid: ({ message }) => new Invalid({ message, ...where }),
      NotFound: ({ message }) => new NotFound({ message, ...where }),
      Conflict: ({ message, kind }) => new Conflict({ message, kind, ...where }),
      Precondition: ({ message }) => new Precondition({ message, ...where }),
      Capacity: ({ message }) => new Capacity({ message, ...where }),
      Internal: ({ message }) => new Internal({ message, ...where }),
      Unavailable: ({ message, readOnly }) => new Unavailable({ message, readOnly, ...where }),
    }),
  );
};

export const settle = <A>(
  call: Effect.Effect<A, CallError>,
  context: CallContext,
): Effect.Effect<A, ClankerboxError> =>
  bounded(call, context).pipe(
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(
          Match.value(error.reason).pipe(
            Match.tag("TransportError", () => unanswered(context, causeDetail(error))),
            // The connection closed while the body was read. A body that arrived and doesn't
            // parse fails as a SyntaxError or a SchemaError, and a wrong status or content
            // type carries no cause.
            Match.when(
              {
                _tag: "DecodeError",
                cause: (cause: unknown) => cause !== undefined && !(cause instanceof SyntaxError),
              },
              () => unanswered(context, causeDetail(error)),
            ),
            Match.orElse(() => unexpected(context, error)),
          ),
        ),
      // Schema issues never carry the rejected values, so a setup script never reaches the message.
      InvalidInput: (error) =>
        Effect.fail(
          new Invalid({
            message: `${context.what}: the request doesn't match the action's input: ${error.message}`,
          }),
        ),
      SchemaError: (error) =>
        Effect.fail(
          new Internal({
            message: `host ${context.host.id}'s reply didn't decode: ${error.message}`,
          }),
        ),
      // Every action is public, so a host never refuses a caller.
      Unauthenticated: (error) => Effect.fail(unexpected(context, error)),
      Forbidden: (error) => Effect.fail(unexpected(context, error)),
    }),
    Effect.mapError((error) => locate(error, context)),
  );

export const checkHost = (entry: HostEntry, host: Host): Effect.Effect<Host, Invalid> =>
  host.id === entry.id
    ? Effect.succeed(host)
    : Effect.fail(
        new Invalid({
          message: `host ${entry.id} (${entry.url}) calls itself ${host.id}; its entry in the host list must use that ID`,
        }),
      );
