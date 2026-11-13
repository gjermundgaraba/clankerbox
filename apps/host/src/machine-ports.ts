import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context } from "effect";
import type { Effect } from "effect";

export interface PortRange {
  readonly first: number;
  readonly last: number;
}

/** A range some program on the host takes ports from, which machines' ports must stay out of. */
export interface ReservedPorts extends PortRange {
  readonly owner: string;
}

/**
 * The ports a box's OS hands its own outgoing connections, by Node's `process.platform`: Linux's
 * default `ip_local_port_range`, and elsewhere IANA's dynamic ports, which macOS takes.
 */
export const ephemeralPorts = (platform: string): ReservedPorts =>
  platform === "linux"
    ? { first: 32_768, last: 60_999, owner: "Linux's ephemeral ports" }
    : {
        first: 49_152,
        last: 65_535,
        owner:
          platform === "darwin"
            ? "macOS's ephemeral ports"
            : "IANA's dynamic ports, which this OS takes for its ephemeral ones",
      };

export const defaultMachinePorts: PortRange = { first: 10_000, last: 19_999 };

export interface Probe {
  readonly free: (
    address: string,
    port: number
  ) => Effect.Effect<boolean, Internal>;
}

export class PortProbe extends Context.Service<PortProbe, Probe>()(
  "@clankerbox/host/PortProbe"
) {}
