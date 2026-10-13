/**
 * One host's calls: the contract's binding over the host's URL, and the translation of what
 * comes back into the SDK's errors.
 */
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Effect, Match } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { Http } from "../api.ts";
import { type ClankerboxError, Internal, Invalid, Unavailable } from "../errors.ts";
import { version, versionHeader } from "../release.ts";
import type { Host } from "../resources.ts";
import type { HostEntry } from "./client.ts";

/**
 * A client for one host. Every request carries the SDK's version, which the host checks
 * against its own. Input that doesn't encode fails as `InvalidInput` before anything is
 * sent, so a `SchemaError` that reaches `settle` is a reply that didn't decode.
 */
export const hostApi = (entry: HostEntry) =>
  ActionHttp.client(Http, {
    baseUrl: entry.url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader(versionHeader, version)),
  });

export type HostApi = Effect.Success<ReturnType<typeof hostApi>>;

export type CallError = ActionHttp.MethodError<(typeof Http.actions)[number]>;

/** What a call reads of its action's contract. */
export type Contract = Pick<Action.Any, "readOnly">;

/** Which call met an error, for its message and for whether it is retryable. */
export interface CallContext {
  readonly host: HostEntry;
  readonly timeout: Duration.Duration | undefined;
  readonly readOnly: boolean;
  /** What the call does, such as `start linux_dev` or `list machines`. */
  readonly action: string;
  /** The ID to read when a mutation's reply is lost. */
  readonly target?: string | undefined;
}

const causeDetail = (error: HttpClientError.HttpClientError): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

/**
 * No reply came: the connection failed or dropped, or the timeout passed. A mutation's
 * request may or may not have reached its host, so it may have run.
 */
const unanswered = (context: CallContext, detail: string): Unavailable =>
  context.readOnly
    ? new Unavailable({
        message: `host ${context.host.id} (${context.host.url}) didn't answer ${context.action}: ${detail}`,
        readOnly: context.readOnly,
      })
    : new Unavailable({
        message: `no reply from host ${context.host.id} to ${context.action} (${detail}); the action may have run: read ${context.target ?? "the resource"} to see`,
        readOnly: context.readOnly,
      });

/** Bounds the wait for the reply; the clock starts when the request is sent. */
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

/** The host answered with something the call doesn't expect. */
const unexpected = (context: CallContext, error: { readonly message: string }): Internal =>
  new Internal({
    message: `host ${context.host.id} answered ${context.action} unexpectedly: ${error.message}`,
  });

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
            message: `${context.action}: the request doesn't match the action's input: ${error.message}`,
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
  );

/** A host this client can use: it calls itself by its entry's ID. */
export const checkHost = (entry: HostEntry, host: Host): Effect.Effect<Host, Invalid> =>
  host.id === entry.id
    ? Effect.succeed(host)
    : Effect.fail(
        new Invalid({
          message: `host ${entry.id} (${entry.url}) calls itself ${host.id}; its entry in the host list must use that ID`,
        }),
      );
