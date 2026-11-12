import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import * as NodeStream from "@effect/platform-node/NodeStream";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FiberSet, Function, Layer, Stream } from "effect";
import type { Scope } from "effect";

import { Relays } from "../reach.ts";
import type { RelaysInterface } from "../reach.ts";
import type { Dial } from "../runtime.ts";

const write = (socket: Socket, chunk: Uint8Array): Effect.Effect<void> =>
  Effect.callback((resume) => {
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

const connection = (
  address: string,
  socket: Socket,
  port: number,
  dial: Dial
) =>
  Stream.runForEach(
    dial(
      NodeStream.fromReadable({
        evaluate: () => socket,
        closeOnDone: false,
      }).pipe(Stream.ignore)
    ),
    (chunk) => write(socket, chunk)
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`forwarder ${address}:${port}: ${error.message}`)
    ),
    Effect.ensuring(
      Effect.sync(() => {
        socket.destroySoon();
      })
    )
  );

export const make = (
  address: string
): Effect.Effect<RelaysInterface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never, unknown, never>();
    const listeners = new Map<number, Server>();

    const close = (port: number) =>
      Effect.sync(() => {
        listeners.get(port)?.close();
        listeners.delete(port);
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...listeners.keys()], close, { discard: true })
    );

    const listen = (port: number, dial: Dial): Effect.Effect<void, Internal> =>
      Effect.callback((resume) => {
        if (listeners.has(port)) {
          resume(Effect.void);

          return;
        }

        const server = createServer({ allowHalfOpen: true }, (socket) => {
          socket.on("error", Function.constVoid);
          run(connection(address, socket, port, dial));
        });

        const refused = (error: Error) => {
          resume(
            Effect.fail(
              new Internal({
                message: `the forwarder couldn't listen on ${address}:${port}: ${error.message}`,
              })
            )
          );
        };

        server.once("error", refused);

        server.listen({ host: address, port, exclusive: true }, () => {
          server.off("error", refused);
          server.on("error", (error) => {
            run(
              Effect.logWarning(
                `forwarder ${address}:${port}: ${error.message}`
              )
            );
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

export const layer = (address: string): Layer.Layer<Relays> =>
  Layer.effect(Relays, make(address));
