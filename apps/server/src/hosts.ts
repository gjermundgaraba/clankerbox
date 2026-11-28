import { HostHttp, stoppingStatus } from "@clankerbox/host-contract";
import type { HostInfo } from "@clankerbox/host-contract";
import {
  HostError,
  readTimeout,
  release,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Host, Internal } from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import type { Redacted } from "effect";
import { Brand, Context, Data, Duration, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

export type FreshBoot = Brand.Branded<string, "FreshBoot">;

const freshBoot = Brand.nominal<FreshBoot>();

export type Fresh = HostInfo & { readonly boot: FreshBoot };

export interface Member {
  readonly id: string;
  readonly url: string;
  readonly draining: boolean;
  readonly token?: Redacted.Redacted | undefined;
}

interface Failed {
  readonly host: string;
  readonly message: string;
  readonly logOnly?: string;
}

export class Unanswered extends Data.TaggedError("Unanswered")<Failed> {}

export class Incompatible extends Data.TaggedError("Incompatible")<Failed> {}

export class Unsent extends Data.TaggedError("Unsent")<Failed> {}

export type Unreachable = Unanswered | Incompatible | Unsent;

const hostApi = (member: Member) =>
  ActionHttp.client(HostHttp, {
    baseUrl: member.url,
    transformClient: HttpClient.mapRequest((request) => {
      const versioned = HttpClientRequest.setHeader(
        request,
        versionHeader,
        version
      );

      return member.token === undefined
        ? versioned
        : HttpClientRequest.bearerToken(versioned, member.token);
    }),
  });

export type HostApi = Effect.Success<ReturnType<typeof hostApi>>;

export type Reached =
  | {
      readonly member: Member;
      readonly info: HostInfo;
      readonly problem: undefined;
    }
  | {
      readonly member: Member;
      readonly info: undefined;
      readonly problem: Unreachable;
    };

export const unread = (problem: {
  readonly _tag: string;
}): "incompatible" | "unreachable" =>
  problem._tag === "Incompatible" ? "incompatible" : "unreachable";

export interface Interface {
  readonly members: readonly Member[];
  readonly call: <A, E>(
    host: string,
    run: (api: HostApi) => Effect.Effect<A, E>,
    within?: Duration.Duration
  ) => Effect.Effect<A, Extract<E, HostError> | Unreachable>;
  readonly read: (host: string) => Effect.Effect<Fresh, Unreachable>;
  readonly known: (host: string) => HostInfo | undefined;
  readonly reachAll: Effect.Effect<readonly Reached[]>;
}

export class Hosts extends Context.Service<Hosts, Interface>()(
  "@clankerbox/server/Hosts"
) {}

export const listed = ({ member, info, problem }: Reached): Host =>
  info === undefined
    ? {
        id: member.id,
        state: unread(problem),
        bases: [],
        problem: problem.message,
      }
    : {
        id: member.id,
        state: member.draining ? "draining" : "up",
        runtime: info.traits.runtime,
        version: info.version,
        runtimeVersion: info.runtimeVersion,
        bases: info.bases,
      };

export const answering = (
  hosts: Interface,
  host: string
): Effect.Effect<HostInfo, Action.Unavailable> =>
  hosts
    .read(host)
    .pipe(
      Effect.mapError(({ message }) => new Action.Unavailable({ message }))
    );

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const httpApiClientUndeclaredStatus = "undeclared status code";

type Reply =
  | HttpClientError.StatusCodeError
  | HttpClientError.DecodeError
  | HttpClientError.EmptyBodyError;

const unexpected = (reason: Reply) => {
  const { status } = reason.response;

  if (reason._tag === "EmptyBodyError") {
    return `it replied HTTP ${status} with no body`;
  }

  return reason._tag === "DecodeError" &&
    reason.description === httpApiClientUndeclaredStatus
    ? `it replied HTTP ${status}, which the host contract doesn't declare`
    : `it replied HTTP ${status} with a body the control plane couldn't read`;
};

const replied = (host: string, reason: Reply) =>
  reason.response.status === stoppingStatus &&
  reason.response.headers["content-type"] === undefined
    ? `host ${host} is stopping: it replied HTTP 503 with no body, as a host's server does to each request while the host stops`
    : `host ${host} didn't answer as the host contract says: ${unexpected(reason)}`;

const unusable = (host: string, error: unknown): Unreachable => {
  if (Schema.isSchemaError(error)) {
    return new Incompatible({
      host,
      message: `host ${host} answers in another contract than this control plane's: ${error.message.replaceAll(/\s*\n\s*/gu, " ")}`,
    });
  }

  if (Schema.is(Action.Unauthenticated)(error)) {
    return new Unanswered({
      host,
      message: `host ${host} refused the control plane's token: ${error.message}; its entry in the config must name the token whose hash is in the host's callers`,
    });
  }

  if (!HttpClientError.isHttpClientError(error)) {
    return new Unanswered({
      host,
      message: `host ${host} didn't answer`,
      logOnly: describe(error),
    });
  }

  const logOnly = error.message;

  switch (error.reason._tag) {
    case "EncodeError":
    case "InvalidUrlError": {
      return new Unanswered({
        host,
        message: `host ${host} wasn't called: the control plane couldn't make the request`,
        logOnly,
      });
    }

    case "TransportError": {
      return new Unanswered({
        host,
        message: `host ${host} didn't answer: the connection to it failed`,
        logOnly,
      });
    }

    case "StatusCodeError":
    case "DecodeError":
    case "EmptyBodyError": {
      return new Unanswered({
        host,
        message: replied(host, error.reason),
        logOnly,
      });
    }
  }
};

const isHostError = Schema.is(HostError);

const bounded = <A, E>(
  host: string,
  answer: Effect.Effect<A, E>,
  within: Duration.Duration
) =>
  Duration.isFinite(within)
    ? Effect.timeoutOrElse(answer, {
        duration: within,
        orElse: () =>
          Effect.fail(
            new Unanswered({
              host,
              message: `host ${host} didn't answer in time`,
            })
          ),
      })
    : answer;

export const make = (
  members: readonly Member[]
): Effect.Effect<Interface, Internal, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const apis = new Map(
      yield* Effect.forEach(members, (member) =>
        Effect.map(hostApi(member), (api) => [member.id, api] as const)
      )
    );

    const infos = new Map<string, HostInfo>();
    const incompatibles = new Map<string, Incompatible>();
    const unanswered = new Set<string>();

    const answered = (host: string) =>
      Effect.suspend(() =>
        unanswered.delete(host)
          ? Effect.logInfo(`host ${host} answers again`)
          : Effect.void
      );

    const unanswering = ({ host, message, logOnly }: Unreachable) =>
      Effect.suspend(() => {
        const line =
          logOnly === undefined ? message : `${message} (${logOnly})`;

        if (unanswered.has(host)) {
          return Effect.logDebug(line);
        }

        unanswered.add(host);

        return Effect.logWarning(line);
      });

    const reaching = <A, E>(
      host: string,
      run: (api: HostApi) => Effect.Effect<A, E>,
      within: Duration.Duration = readTimeout
    ): Effect.Effect<A, Extract<E, HostError> | Unreachable> =>
      Effect.suspend(
        (): Effect.Effect<A, Extract<E, HostError> | Unreachable> => {
          const api = apis.get(host);

          return api === undefined
            ? Effect.fail(
                new Unsent({
                  host,
                  message: `host ${host} isn't in the control plane's config`,
                })
              )
            : bounded(
                host,
                run(api).pipe(
                  Effect.catchIf(
                    (error: E): error is Extract<E, HostError> =>
                      isHostError(error),
                    Effect.fail,
                    (error) => Effect.fail(unusable(host, error))
                  )
                ),
                within
              );
        }
      );

    const call: Interface["call"] = (host, run, within) =>
      Effect.suspend(() => {
        const refused = incompatibles.get(host);

        return refused === undefined
          ? reaching(host, run, within).pipe(
              Effect.tap(() => answered(host)),
              Effect.tapError((error) =>
                isHostError(error) ? answered(host) : unanswering(error)
              )
            )
          : Effect.fail(new Unsent({ host, message: refused.message }));
      });

    const read = (host: string) =>
      Effect.gen(function* () {
        const info = yield* reaching(host, (api) => api.readHost({})).pipe(
          Effect.catchTag("Invalid", ({ message }) =>
            Effect.fail(
              new Incompatible({
                host,
                message: `host ${host} refused the read: ${message}`,
              })
            )
          )
        );

        if (release(info.version) !== release(version)) {
          return yield* new Incompatible({
            host,
            message: `host ${host} runs clankerbox ${info.version}, and this control plane ${version}; their major.minor must match, so upgrade them together`,
          });
        }

        if (info.id !== host) {
          return yield* new Unanswered({
            host,
            message: `host ${host} calls itself ${info.id}; its entry in the config must use that ID`,
          });
        }

        infos.set(host, info);

        return { ...info, boot: freshBoot(info.boot) };
      }).pipe(
        Effect.tap(() => {
          incompatibles.delete(host);

          return answered(host);
        }),
        Effect.tapError((error) => {
          if (error._tag === "Incompatible") {
            incompatibles.set(host, error);
            infos.delete(host);
          }

          return unanswering(error);
        })
      );

    return {
      members,
      call,
      read,
      known: (host) => infos.get(host),
      reachAll: Effect.forEach(
        members,
        (member) =>
          read(member.id).pipe(
            Effect.match({
              onSuccess: (info): Reached => ({
                member,
                info,
                problem: undefined,
              }),
              onFailure: (error): Reached => ({
                member,
                info: undefined,
                problem: error,
              }),
            })
          ),
        { concurrency: "unbounded" }
      ),
    } satisfies Interface;
  });

export const layer = (
  members: readonly Member[]
): Layer.Layer<Hosts, Internal, HttpClient.HttpClient> =>
  Layer.effect(Hosts, make(members));
