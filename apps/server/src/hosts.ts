import { HostHttp } from "@clankerbox/host-contract";
import type { HostInfo } from "@clankerbox/host-contract";
import {
  HostError,
  readTimeout,
  Unavailable,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Host, Internal } from "@gjermundgaraba/clankerbox-sdk";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Brand, Context, Data, Duration, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export type FreshBoot = Brand.Branded<string, "FreshBoot">;

const freshBoot = Brand.nominal<FreshBoot>();

export type Fresh = HostInfo & { readonly boot: FreshBoot };

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
   * One call to a host, bounded by `readTimeout` unless `within` says otherwise, as a command runs
   * as long as its request does. It fails with an error its action declares, as the host answered
   * it, and with `Unreachable` for every way it got no answer.
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
  /** What the host last said, read or not since. */
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
        state: "unreachable",
        bases: [],
        ...(problem === undefined ? {} : { problem }),
      }
    : {
        id: member.id,
        state: member.draining ? "draining" : "up",
        kind: info.kind,
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
            new Unreachable({
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
      run: (api: HostApi) => Effect.Effect<A, E>,
      within: Duration.Duration = readTimeout
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
          : bounded(
              host,
              run(api).pipe(
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
                )
              ),
              within
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

        return { ...info, boot: freshBoot(info.boot) };
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
