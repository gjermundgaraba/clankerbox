import { HostHttp } from "@clankerbox/host-contract";
import type { HostInfo } from "@clankerbox/host-contract";
import {
  HostError,
  readTimeout,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export interface Member {
  readonly id: string;
  readonly url: string;
  readonly draining: boolean;
}

/** A host gave no usable answer. Nothing can tell what became of a mutation it was sent. */
export class Unreachable extends Data.TaggedError("Unreachable")<{
  readonly host: string;
  readonly message: string;
}> {}

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
  readonly problem: string | undefined;
}

export interface Interface {
  readonly members: readonly Member[];
  /**
   * One call to a host, bounded. It fails with an error its action declares, as the host answered
   * it, and with `Unreachable` for every way it got no answer.
   */
  readonly call: <A, E>(
    host: string,
    run: (api: HostApi) => Effect.Effect<A, E>
  ) => Effect.Effect<A, Extract<E, HostError> | Unreachable>;
  /**
   * Reads the host, and checks it calls itself what the config says. Every look at a host comes
   * through here, so this logs when it stops answering and when it answers again, and no one else.
   */
  readonly read: (host: string) => Effect.Effect<HostInfo, Unreachable>;
  /** What the host last said, read or not since. */
  readonly known: (host: string) => HostInfo | undefined;
  readonly reachAll: Effect.Effect<readonly Reached[]>;
}

export class Hosts extends Context.Service<Hosts, Interface>()(
  "@clankerbox/server/Hosts"
) {}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isHostError = Schema.is(HostError);

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
    const unanswered = new Set<string>();

    const answered = (host: string) =>
      Effect.suspend(() =>
        unanswered.delete(host)
          ? Effect.logInfo(`host ${host} answers again`)
          : Effect.void
      );

    const unanswering = ({ host, message }: Unreachable) =>
      Effect.suspend(() => {
        if (unanswered.has(host)) {
          return Effect.void;
        }

        unanswered.add(host);

        return Effect.logWarning(message);
      });

    const call = <A, E>(
      host: string,
      run: (api: HostApi) => Effect.Effect<A, E>
    ): Effect.Effect<A, Extract<E, HostError> | Unreachable> =>
      Effect.suspend(() => {
        const api = apis.get(host);

        return api === undefined
          ? Effect.fail(
              new Unreachable({
                host,
                message: `host ${host} isn't in the control plane's config`,
              })
            )
          : run(api).pipe(
              Effect.catchIf(
                (error: E): error is Extract<E, HostError> =>
                  isHostError(error),
                Effect.fail,
                (error) =>
                  Effect.fail(
                    new Unreachable({
                      host,
                      message: `host ${host}: ${describe(error)}`,
                    })
                  )
              ),
              Effect.timeoutOrElse({
                duration: readTimeout,
                orElse: () =>
                  Effect.fail(
                    new Unreachable({
                      host,
                      message: `host ${host} didn't answer in time`,
                    })
                  ),
              })
            );
      });

    const read = (host: string) =>
      Effect.gen(function* () {
        const info = yield* call(host, (api) => api.readHost({})).pipe(
          Effect.catchTag("Invalid", ({ message }) =>
            Effect.fail(
              new Unreachable({
                host,
                message: `host ${host} refused the read: ${message}`,
              })
            )
          )
        );

        if (info.id !== host) {
          return yield* new Unreachable({
            host,
            message: `host ${host} calls itself ${info.id}; its entry in the config must use that ID`,
          });
        }

        infos.set(host, info);

        return info;
      }).pipe(
        Effect.tap(() => answered(host)),
        Effect.tapError(unanswering)
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
                problem: error.message,
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
