import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import * as NodeStream from "@effect/platform-node/NodeStream";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FiberSet, Function, Layer, Stream } from "effect";
import type { Scope, Option } from "effect";

import { Relays } from "../reach.ts";
import type { Listener, RelaysInterface } from "../reach.ts";
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
      Effect.logWarning(`relay ${address}:${port}: ${error.message}`)
    ),
    Effect.ensuring(
      Effect.sync(() => {
        socket.destroySoon();
      })
    )
  );

export const make: Effect.Effect<RelaysInterface, never, Scope.Scope> =
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never, unknown, never>();
    const servers = new Set<Server>();

    const closed = (server: Server) =>
      Effect.sync(() => {
        if (servers.delete(server)) {
          server.close();
        }
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...servers], closed, { discard: true })
    );

    const bind = (
      address: string,
      port: number
    ): Effect.Effect<Option.Option<Listener>, Internal> =>
      Effect.callback((resume) => {
        const server = createServer({ allowHalfOpen: true });
        let carried: Dial | undefined;

        const refused = (error: NodeJS.ErrnoException) => {
          resume(
            error.code === "EADDRINUSE" || error.code === "EACCES"
              ? Effect.succeedNone
              : Effect.fail(
                  new Internal({
                    message: `the relay couldn't listen on ${address}:${port}: ${error.message}`,
                  })
                )
          );
        };

        server.once("error", refused);

        server.listen({ host: address, port, exclusive: true }, () => {
          server.on("connection", (socket) => {
            socket.on("error", Function.constVoid);

            if (carried === undefined) {
              socket.destroy();
            } else {
              run(connection(address, socket, port, carried));
            }
          });
          server.off("error", refused);
          server.on("error", (error) => {
            run(
              Effect.logWarning(`relay ${address}:${port}: ${error.message}`)
            );
          });
          servers.add(server);
          resume(
            Effect.succeedSome({
              relay: (dial) =>
                Effect.sync(() => {
                  carried = dial;
                }),
              close: closed(server),
            })
          );
        });

        return Effect.sync(() => {
          if (!servers.has(server)) {
            server.close();
          }
        });
      });

    return { bind };
  });

export const layer: Layer.Layer<Relays> = Layer.effect(Relays, make);
