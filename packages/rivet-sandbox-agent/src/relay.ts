import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { pipeline } from "node:stream";

import { Effect, Function, Predicate } from "effect";
import type { Scope } from "effect";

import { LocalTunnelError } from "./tunnel.ts";

export interface Relay {
  readonly port: number;
}

const relayed = (socket: Socket, to: string | undefined) => {
  socket.unref();

  if (to === undefined) {
    socket.resetAndDestroy();

    return;
  }

  const upstream = connect({ path: to, allowHalfOpen: true });

  upstream.unref();
  pipeline(socket, upstream, socket, Function.constVoid);
};

/**
 * `server` on a loopback port the OS picks, until the scope ends. An error the server meets once
 * it listens, as an accept that fails, costs at most that connection, and the port stays held.
 */
export const listenOn = (
  machine: string,
  server: Server
): Effect.Effect<Relay, LocalTunnelError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Server, LocalTunnelError>((resume) => {
      const refused = (error: Error) => {
        resume(
          Effect.fail(
            new LocalTunnelError({
              message: `couldn't take a port for the tunnel to ${machine}: ${error.message}`,
            })
          )
        );
      };

      server.once("error", refused);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", refused);
        server.on("error", Function.constVoid);
        server.unref();
        resume(Effect.succeed(server));
      });
    }),
    (listening) =>
      Effect.sync(() => {
        listening.close();
      })
  ).pipe(
    Effect.flatMap((listening) => {
      const address = listening.address();

      return address === null || Predicate.isString(address)
        ? Effect.fail(
            new LocalTunnelError({
              message: `couldn't take a port for the tunnel to ${machine}`,
            })
          )
        : Effect.succeed({ port: address.port });
    })
  );

/**
 * A sandbox's port on loopback, which the provider holds for the sandbox's whole life, so no other
 * program can listen there while its tunnel is down. Each connection goes to the socket `to` names
 * as it comes, that of a tunnel that is open, with each side's end of it, and one that comes while
 * `to` names none is reset. Neither the port nor a connection keeps the process running.
 */
export const listen = (machine: string, to: () => string | undefined) =>
  Effect.suspend(() =>
    listenOn(
      machine,
      createServer({ allowHalfOpen: true }, (socket) => {
        relayed(socket, to());
      })
    )
  );
