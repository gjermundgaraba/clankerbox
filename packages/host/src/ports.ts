/**
 * Host ports for guest port 22. The core picks one when it inserts a machine's row, for a
 * runtime with a `publishAddress` (smolvm and Tart), from the host config's `machinePorts`.
 */
import { createServer } from "node:net";
import { Capacity, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

/** A range of ports, both ends included. */
export interface PortRange {
  readonly first: number;
  readonly last: number;
}

/**
 * The machines' ports unless the host config names others: below smolvm's fork range
 * (20000–32000) and the Linux ephemeral range (32768 and up).
 */
export const defaultMachinePorts: PortRange = { first: 10_000, last: 19_999 };

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
 * The lowest port in `range` that no machine row holds and that binds on `address`. Actions
 * that allocate a port pick and record it one at a time, so no other action takes it between.
 */
export const pickPort = (
  address: string,
  range: PortRange,
  taken: ReadonlySet<number>,
): Effect.Effect<number, Capacity | Internal> =>
  Effect.gen(function* () {
    for (let port = range.first; port <= range.last; port++) {
      if (!taken.has(port) && (yield* probe(address, port))) {
        return port;
      }
    }

    return yield* new Capacity({
      message: `no free port in ${range.first}-${range.last} on ${address}`,
    });
  });
