import { createServer, type Server, type Socket } from "node:net";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FiberSet, type Scope, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import { lastLines } from "../../guest.ts";

export type Dial = (input: Stream.Stream<Uint8Array>) => ChildProcess.Command;

export interface Forwarder {
  readonly listen: (port: number, dial: Dial) => Effect.Effect<void, Internal>;
  /** Connections already open run until their command ends. */
  readonly close: (port: number) => Effect.Effect<void>;
}

const write = (socket: Socket, chunk: Uint8Array) =>
  Effect.callback<void>((resume) => {
    if (!socket.writable) {
      resume(Effect.void);

      return;
    }

    if (socket.write(chunk)) {
      resume(Effect.void);

      return;
    }

    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resume(Effect.void);
    };

    socket.on("drain", done);
    socket.on("close", done);
  });

export const make = (
  address: string,
): Effect.Effect<Forwarder, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = yield* FiberSet.makeRuntime<never, void, never>();
    const listeners = new Map<number, Server>();

    const connection = (socket: Socket, port: number, dial: Dial) =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = NodeStream.fromReadable<Uint8Array>({
            evaluate: () => socket,
            closeOnDone: false,
          }).pipe(Stream.ignore);

          const handle = yield* spawner.spawn(dial(input));

          const [, errors, exitCode] = yield* Effect.all(
            [
              Stream.runForEach(handle.stdout, (chunk) => write(socket, chunk)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );

          if (exitCode !== 0) {
            yield* Effect.logWarning(
              `forwarder ${address}:${port}: its connection's command exited ${exitCode}: ${lastLines(errors)}`,
            );
          }
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`forwarder ${address}:${port}: ${error.message}`),
        ),
        Effect.ensuring(Effect.sync(() => socket.destroySoon())),
      );

    const close = (port: number) =>
      Effect.sync(() => {
        listeners.get(port)?.close();
        listeners.delete(port);
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...listeners.keys()], close, { discard: true }),
    );

    const listen = (port: number, dial: Dial) =>
      Effect.callback<void, Internal>((resume) => {
        if (listeners.has(port)) {
          resume(Effect.void);

          return;
        }

        const server = createServer({ allowHalfOpen: true }, (socket) => {
          socket.on("error", () => undefined);
          run(connection(socket, port, dial));
        });

        const refused = (error: Error) => {
          resume(
            Effect.fail(
              new Internal({
                message: `the forwarder couldn't listen on ${address}:${port}: ${error.message}`,
              }),
            ),
          );
        };

        server.once("error", refused);

        server.listen({ host: address, port, exclusive: true }, () => {
          server.off("error", refused);
          server.on("error", (error) => {
            run(Effect.logWarning(`forwarder ${address}:${port}: ${error.message}`));
          });
          listeners.set(port, server);
          resume(Effect.void);
        });

        return Effect.sync(() => {
          if (listeners.get(port) !== server) {
            server.close();
          }
        });
      });

    return { listen, close };
  });
