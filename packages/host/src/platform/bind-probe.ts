import { createServer } from "node:net";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";

import { PortProbe } from "../machine-ports.ts";

const free = (
  address: string,
  port: number
): Effect.Effect<boolean, Internal> =>
  Effect.callback((resume) => {
    const server = createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      resume(
        error.code === "EADDRINUSE" || error.code === "EACCES"
          ? Effect.succeed(false)
          : Effect.fail(
              new Internal({
                message: `couldn't probe port ${address}:${port}: ${error.message}`,
              })
            )
      );
    });

    server.listen({ host: address, port, exclusive: true }, () => {
      server.close(() => {
        resume(Effect.succeed(true));
      });
    });
  });

export const layer = Layer.succeed(PortProbe, { free });
