import { HostHttp } from "@clankerbox/host-contract";
import type { HostInfo } from "@clankerbox/host-contract";
import {
  HostError,
  readTimeout,
  release,
  Unavailable,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Host, Internal } from "@gjermundgaraba/clankerbox-sdk";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Brand, Context, Data, Duration, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

export type FreshBoot = Brand.Branded<string, "FreshBoot">;

const freshBoot = Brand.nominal<FreshBoot>();

export type Fresh = HostInfo & { readonly boot: FreshBoot };

export interface Member {
  readonly id: string;
  readonly url: string;
  readonly draining: boolean;
}

interface Failed {
  readonly host: string;
  readonly message: string;
  readonly logOnly?: string;
}

/** A host gave no usable answer, so nothing can tell what became of a mutation it was sent. */
export class Unanswered extends Data.TaggedError("Unanswered")<Failed> {}

/**
 * A host answers, but of another release than the control plane's or in another contract, so
 * nothing it says can be used, and nothing can tell what became of a mutation it was sent.
 */
export class Incompatible extends Data.TaggedError("Incompatible")<Failed> {}

/**
 * A call refused before it left: its host isn't in the config, or the last read found it
 * incompatible, and only a read, which may find it upgraded, reaches it.
 */
export class Unsent extends Data.TaggedError("Unsent")<Failed> {}

/** Every way a call to a host or a read of it gets no answer it can use. */
export type Unreachable = Unanswered | Incompatible | Unsent;

const hostApi = (member: Member) =>
  ActionHttp.client(HostHttp, {
    baseUrl: member.url,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader(versionHeader, version)
    ),
  });

export type HostApi = Effect.Success<ReturnType<typeof hostApi>>;

export interface Reached {
  readonly member: Member;
  readonly info: HostInfo | undefined;
  readonly problem: Unreachable | undefined;
}

/** What an operator is shown of a host whose read or call failed with `problem`. */
export const unread = (problem: {
  readonly _tag: string;
}): "incompatible" | "unreachable" =>
  problem._tag === "Incompatible" ? "incompatible" : "unreachable";

export interface Interface {
  readonly members: readonly Member[];
  /**
   * One call to a host, bounded by `readTimeout` unless `within` says otherwise, as a command runs
   * as long as its request does. It fails with an error its action declares, as the host answered
   * it, and with `Unreachable` for every way it got no answer: `Unsent` for one that never left.
   */
  readonly call: <A, E>(
    host: string,
    run: (api: HostApi) => Effect.Effect<A, E>,
    within?: Duration.Duration
  ) => Effect.Effect<A, Extract<E, HostError> | Unreachable>;
  /**
   * Reads the host, and checks it calls itself what the config says. Every look at a host comes
   * through here, so this logs when it stops answering and when it answers again, and no one else.
   */
  readonly read: (host: string) => Effect.Effect<Fresh, Unreachable>;
  /** What the host last said, read or not since, unless a read since found it incompatible. */
  readonly known: (host: string) => HostInfo | undefined;
  readonly reachAll: Effect.Effect<readonly Reached[]>;
}

export class Hosts extends Context.Service<Hosts, Interface>()(
  "@clankerbox/server/Hosts"
) {}

/** What an operator reads of a host: what it reports, or why it couldn't be read. */
export const listed = ({ member, info, problem }: Reached): Host =>
  info === undefined
    ? {
        id: member.id,
        state: problem === undefined ? "unreachable" : unread(problem),
        bases: [],
        ...(problem === undefined ? {} : { problem: problem.message }),
      }
    : {
        id: member.id,
        state: member.draining ? "draining" : "up",
        runtime: info.traits.runtime,
        version: info.version,
        runtimeVersion: info.runtimeVersion,
        bases: info.bases,
      };

/** Reads a host for a caller to whom a host that doesn't answer is a read that may yet succeed. */
export const answering = (
  hosts: Interface,
  host: string
): Effect.Effect<HostInfo, Unavailable> =>
  hosts
    .read(host)
    .pipe(
      Effect.mapError(
        ({ message }) => new Unavailable({ message, readOnly: true })
      )
    );

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unusable = (host: string, error: unknown): Unreachable => {
  if (Schema.isSchemaError(error)) {
    return new Incompatible({
      host,
      message: `host ${host} answers in another contract than this control plane's: ${error.message.replaceAll(/\s*\n\s*/gu, " ")}`,
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
      return new Unsent({
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
        message: `host ${host} didn't answer as the host contract says: it replied HTTP ${error.reason.response.status}, which is no answer the contract declares`,
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
        if (unanswered.has(host)) {
          return Effect.void;
        }

        unanswered.add(host);

        return Effect.logWarning(
          logOnly === undefined ? message : `${message} (${logOnly})`
        );
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
                  Effect.catchDefect((defect) =>
                    HttpClientError.isHttpClientError(defect)
                      ? Effect.fail(defect)
                      : Effect.die(defect)
                  ),
                  Effect.catchIf(
                    (
                      error: E | HttpClientError.HttpClientError
                    ): error is Extract<E, HostError> => isHostError(error),
                    Effect.fail,
                    (error) => {
                      const failed = unusable(host, error);

                      return Effect.andThen(
                        failed.logOnly === undefined
                          ? Effect.void
                          : Effect.logDebug(`host ${host}: ${failed.logOnly}`),
                        Effect.fail(failed)
                      );
                    }
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
          ? reaching(host, run, within)
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
