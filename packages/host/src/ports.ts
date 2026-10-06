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
 * The ranges the machines' ports stay out of, which the host config refuses a range reaching
 * into: smolvm's own fork ports (`CLONE_PORT_FLOOR` up to `CLONE_PORT_CEILING`, excluded,
 * S@1.22.2:src/agent/fork.rs), and the ephemeral ports of Linux (`ip_local_port_range`'s
 * default) and macOS (`net.inet.ip.portrange.first` to `.last`), from which the kernel can hand a
 * machine's port to an outgoing connection.
 */
export const reservedPorts: ReadonlyArray<PortRange & { readonly owner: string }> = [
  { first: 20_000, last: 31_999, owner: "smolvm's fork ports" },
  { first: 32_768, last: 60_999, owner: "Linux's ephemeral ports" },
  { first: 49_152, last: 65_535, owner: "macOS's ephemeral ports" },
];

/** The machines' ports unless the host config names others: below every reserved range. */
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
