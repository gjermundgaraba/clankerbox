/**
 * The forwarder, used only by Tart, which has no port publishing: for each running machine it
 * listens on the publish address and the machine's host port, and each connection it accepts
 * runs one command that carries the bytes to the guest's port 22, `tart exec -i <vm> nc
 * 127.0.0.1 22`. That needs no guest IP, no Softnet exception and no Local Network permission.
 *
 * A connection ends by closing the command's stdin, never by killing it: a killed `tart exec`
 * leaves the guest's `nc` and `sshd-session` running until the session next writes (P2). Only
 * the host's own shutdown kills them, and a host restart drops open connections.
 */
import { createServer, type Server, type Socket } from "node:net";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FiberSet, type Scope, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import { lastLines } from "./guest.ts";

/** The command one connection runs, reading the client's bytes from `input`. */
export type Dial = (input: Stream.Stream<Uint8Array>) => ChildProcess.Command;

export interface Forwarder {
  /** Listens on `port` of the publish address, unless it already does; each connection runs `dial`. */
  readonly listen: (port: number, dial: Dial) => Effect.Effect<void, Internal>;
  /** Stops accepting on `port`. Connections already open run until their command ends. */
  readonly close: (port: number) => Effect.Effect<void>;
}

/**
 * Writes a chunk to the client, waiting while its buffer is full. Once the client has gone the
 * chunk is dropped, so the command's output is still read to its end and the command can exit
 * on its closed stdin.
 */
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

/** A forwarder on `address`, whose listeners and connections end with the scope. */
export const make = (
  address: string,
): Effect.Effect<Forwarder, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = yield* FiberSet.makeRuntime<never, void, never>();
    const listeners = new Map<number, Server>();

    /**
     * One connection: the client's bytes are the command's stdin, which ends when the client
     * closes or resets its side, and the command's output goes back until it ends.
     */
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

        // A client that half-closes still gets the rest of the guest's output.
        const server = createServer({ allowHalfOpen: true }, (socket) => {
          // The connection's streams see a reset as the end of the client's side; this keeps a
          // late error on a finished connection from being unhandled.
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
      });

    return { listen, close };
  });
