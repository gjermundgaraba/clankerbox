import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Stream } from "effect";
import { Socket } from "effect/socket";

import type { Dial, Target } from "../../runtime.ts";
import type { Api } from "./api.ts";

const closed = (error: Socket.SocketError) =>
  error.reason instanceof Socket.SocketCloseError;

/**
 * A connection to a machine's sshd through the provider's tunnel, raw TCP over a WebSocket that
 * carries the full key: the provider refuses a connect token there. A tunnel can't wake a stopped
 * machine, so its dial fails as one to any stopped machine does.
 */
export const tunnel =
  (api: Api, sockets: Socket.WebSocketConstructor["Service"]) =>
  (machine: Target): Dial =>
  (input) => {
    const { url, headers } = api.tunnel(machine.handle);

    return Stream.unwrap(
      Effect.map(Socket.makeWebSocket(url, { headers }), (socket) =>
        input.pipe(Stream.pipeThroughChannel(Socket.toChannel(socket)))
      )
    ).pipe(
      Stream.catchIf(closed, () => Stream.empty),
      Stream.mapError(
        (error) =>
          new Internal({
            message: `the tunnel to ${machine.name}: ${error.message}`,
          })
      ),
      Stream.provideService(Socket.WebSocketConstructor, sockets)
    );
  };
