import { WebSocket } from "@effect/platform-node/NodeWS";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  Deferred,
  Effect,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import type { Dial, Execution } from "../../runtime.ts";

/**
 * The Kubernetes API's channel protocols over a WebSocket, as
 * https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/util/remotecommand/constants.go
 * names them: every frame starts with its channel's byte. `v5.channel.k8s.io` adds the frame
 * `[255, 0]`, which closes stdin; a port-forward is served only under `v4.channel.k8s.io`.
 */
const execProtocol = "v5.channel.k8s.io";

const forwardProtocol = "v4.channel.k8s.io";

const stdin = 0;

const stdout = 1;

const stderr = 2;

const status = 3;

const closeStdin = Uint8Array.of(255, stdin);

const forwarded = 0;

const forwardError = 1;

const portBytes = 2;

const frameBytes = 32 * 1024;

const Status = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    message: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    details: Schema.optionalKey(
      Schema.Struct({
        causes: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              reason: Schema.optionalKey(Schema.String),
              message: Schema.optionalKey(Schema.String),
            })
          )
        ),
      })
    ),
  })
);

const decodeStatus = Schema.decodeUnknownOption(Status);

const decoder = new TextDecoder();

const encoder = new TextEncoder();

const exitOfStatusFrame = (
  frame: Uint8Array
): Result.Result<number, string> => {
  const text = decoder.decode(frame);

  return Option.match(decodeStatus(text), {
    onNone: () => Result.fail(`a status it couldn't read: ${text}`),
    onSome: (answered) => {
      if (answered.status === "Success") {
        return Result.succeed(0);
      }

      const code = Number(
        answered.details?.causes?.find(({ reason }) => reason === "ExitCode")
          ?.message
      );

      return answered.reason === "NonZeroExitCode" && Number.isInteger(code)
        ? Result.succeed(code)
        : Result.fail(answered.message ?? text);
    },
  });
};

const framed = (channel: number, data: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(data.byteLength + 1);

  frame[0] = channel;
  frame.set(data, 1);

  return frame;
};

const pieces = (data: Uint8Array): Uint8Array[] =>
  Array.from({ length: Math.ceil(data.byteLength / frameBytes) }, (_, at) =>
    data.subarray(at * frameBytes, (at + 1) * frameBytes)
  );

const normallyClosed = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" && error.reason.code === 1000;

export interface Endpoint {
  readonly api: string;
  readonly token: Effect.Effect<Redacted.Redacted, Internal>;
  readonly ca: string;
}

const opened = (
  endpoint: Endpoint,
  path: string,
  protocol: string
): Effect.Effect<Socket.Socket, Internal> =>
  Effect.flatMap(endpoint.token, (token) =>
    Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(
              `${endpoint.api.replace(/^http/u, "ws")}${path}`,
              protocol,
              {
                headers: { authorization: `Bearer ${Redacted.value(token)}` },
                ca: endpoint.ca,
              }
            )
        ),
        (ws) =>
          Effect.sync(() => {
            ws.close(1000);
          })
      )
    )
  );

const exchanged = (
  socket: Socket.Socket,
  input: Stream.Stream<Uint8Array>
): Stream.Stream<Uint8Array, Socket.SocketError> =>
  Stream.pipeThroughChannelOrFail(input, Socket.toChannel(socket)).pipe(
    Stream.filter((frame) => frame.byteLength > 0),
    Stream.catchIf(normallyClosed, () => Stream.empty)
  );

export const internal =
  (what: string) =>
  (error: { readonly message: string }): Internal =>
    new Internal({ message: `${what}: ${error.message}` });

/**
 * Runs `argv` in container `container` of `pod` through `pods/exec`, with `input` on its stdin,
 * which is then closed. Closing the scope closes the socket, which leaves the command running in
 * the container, as `guest.ts` expects of an exec cut short.
 */
export const exec = (
  endpoint: Endpoint,
  pod: { readonly namespace: string; readonly name: string },
  container: string,
  argv: readonly string[],
  input: string | undefined
): Effect.Effect<Execution, Internal, Scope.Scope> =>
  Effect.gen(function* () {
    const what = `exec in pod ${pod.name}`;

    const query = new URLSearchParams([
      ["container", container],
      ["stdin", "true"],
      ["stdout", "true"],
      ["stderr", "true"],
      ...argv.map((word) => ["command", word]),
    ]);

    const socket = yield* opened(
      endpoint,
      `/api/v1/namespaces/${pod.namespace}/pods/${pod.name}/exec?${query.toString()}`,
      execProtocol
    );

    const exit = yield* Deferred.make<number, Internal>();

    const stdinFrames = Stream.make(
      ...pieces(encoder.encode(input ?? "")).map((piece) =>
        framed(stdin, piece)
      ),
      closeStdin
    );

    const output = exchanged(socket, stdinFrames).pipe(
      Stream.mapError(internal(what)),
      Stream.mapEffect((frame) => {
        const [channel] = frame;
        const data = frame.subarray(1);

        if (channel === status) {
          return Result.match(exitOfStatusFrame(data), {
            onSuccess: (code) => Effect.as(Deferred.succeed(exit, code), []),
            onFailure: (why) =>
              Effect.fail(new Internal({ message: `${what}: ${why}` })),
          });
        }

        return Effect.succeed(
          (channel === stdout || channel === stderr) && data.byteLength > 0
            ? [data]
            : []
        );
      }),
      Stream.flattenIterable,
      Stream.onExit((ended) =>
        ended._tag === "Failure"
          ? Deferred.failCause(exit, ended.cause)
          : Deferred.fail(
              exit,
              new Internal({ message: `${what} ended with no exit status` })
            )
      )
    );

    return { output, exitCode: Deferred.await(exit) };
  });

/**
 * Carries a connection to `port` of `pod` through `pods/portforward`. Each channel's first two
 * bytes name the port; the error channel's data, once past them, fails the connection. The
 * protocol carries no half-close, so the connection ends, closing its socket, once `input` ends,
 * as a client that disconnects ends it.
 */
export const forward =
  (
    endpoint: Endpoint,
    pod: { readonly namespace: string; readonly name: string },
    port: number
  ): Dial =>
  (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { namespace, name } = pod;
        const what = `port-forward to ${name}:${port}`;

        const socket = yield* opened(
          endpoint,
          `/api/v1/namespaces/${namespace}/pods/${name}/portforward?ports=${port}`,
          forwardProtocol
        );

        const unread = new Map([
          [forwarded, portBytes],
          [forwardError, portBytes],
        ]);

        const past = (channel: number, data: Uint8Array) => {
          const skip = Math.min(unread.get(channel) ?? 0, data.byteLength);

          unread.set(channel, (unread.get(channel) ?? 0) - skip);

          return data.subarray(skip);
        };

        const ended = yield* Deferred.make<undefined>();

        return exchanged(
          socket,
          Stream.map(input, (chunk) => framed(forwarded, chunk)).pipe(
            Stream.ensuring(Deferred.succeed(ended, undefined))
          )
        ).pipe(
          Stream.mapError(internal(what)),
          Stream.mapEffect((frame) => {
            const [channel = -1] = frame;
            const data = past(channel, frame.subarray(1));

            if (channel === forwardError && data.byteLength > 0) {
              return Effect.fail(
                new Internal({ message: `${what}: ${decoder.decode(data)}` })
              );
            }

            return Effect.succeed(
              channel === forwarded && data.byteLength > 0 ? [data] : []
            );
          }),
          Stream.flattenIterable,
          Stream.interruptWhen(Deferred.await(ended))
        );
      })
    );
