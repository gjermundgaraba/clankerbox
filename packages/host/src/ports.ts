/**
 * Host ports for guest port 22. The core picks one when it inserts a machine's row, for a
 * runtime with a `publishAddress` (smolvm and Tart). The range sits below smolvm's fork range
 * (20000–32000) and the Linux ephemeral range (32768 and up).
 */
import { createServer } from "node:net";
import { Capacity, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

export const firstPort = 10_000;

export const lastPort = 19_999;

/** Whether `address:port` can be bound now. Something else listening there makes it false. */
const probe = (address: string, port: number): Effect.Effect<boolean, Internal> =>
  Effect.callback((resume) => {
    const server = createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      resume(
        error.code === "EADDRINUSE" || error.code === "EACCES"
          ? Effect.succeed(false)
          : Effect.fail(
              new Internal({ message: `couldn't probe port ${address}:${port}: ${error.message}` }),
            ),
      );
    });

    server.listen({ host: address, port, exclusive: true }, () => {
      server.close(() => {
        resume(Effect.succeed(true));
      });
    });
  });

/**
 * The lowest port in the range that no machine row holds and that binds on `address`. The
 * caller records it under the rows' unique index, and picks again if another action took it
 * since.
 */
export const pickPort = (
  address: string,
  taken: ReadonlySet<number>,
): Effect.Effect<number, Capacity | Internal> =>
  Effect.gen(function* () {
    for (let port = firstPort; port <= lastPort; port++) {
      if (!taken.has(port) && (yield* probe(address, port))) {
        return port;
      }
    }

    return yield* new Capacity({
      message: `no free port in ${firstPort}-${lastPort} on ${address}`,
    });
  });
