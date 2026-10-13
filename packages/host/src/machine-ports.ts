import { Capacity, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect } from "effect";

export interface PortRange {
  readonly first: number;
  readonly last: number;
}

/**
 * The ranges the machines' ports stay out of, which the host config refuses a range reaching
 * into: smolvm's own fork ports (`CLONE_PORT_FLOOR` up to `CLONE_PORT_CEILING`, excluded,
 * S@1.27.3:src/agent/fork.rs:3978-3980), and the ephemeral ports of Linux (`ip_local_port_range`'s
 * default) and macOS (`net.inet.ip.portrange.first` to `.last`), from which the kernel can hand a
 * machine's port to an outgoing connection.
 */
export const reservedPorts: ReadonlyArray<PortRange & { readonly owner: string }> = [
  { first: 20_000, last: 31_999, owner: "smolvm's fork ports" },
  { first: 32_768, last: 60_999, owner: "Linux's ephemeral ports" },
  { first: 49_152, last: 65_535, owner: "macOS's ephemeral ports" },
];

/** Below every reserved range. */
export const defaultMachinePorts: PortRange = { first: 10_000, last: 19_999 };

export interface Probe {
  readonly free: (address: string, port: number) => Effect.Effect<boolean, Internal>;
}

export class PortProbe extends Context.Service<PortProbe, Probe>()("@clankerbox/host/PortProbe") {}

/**
 * Actions that allocate a port pick and record it one at a time, so no other action takes it
 * between.
 */
export const pickPort = (
  probe: Probe,
  address: string,
  range: PortRange,
  taken: ReadonlySet<number>,
): Effect.Effect<number, Capacity | Internal> =>
  Effect.gen(function* () {
    for (let port = range.first; port <= range.last; port++) {
      if (!taken.has(port) && (yield* probe.free(address, port))) {
        return port;
      }
    }

    return yield* new Capacity({
      message: `no free port in ${range.first}-${range.last} on ${address}`,
    });
  });
