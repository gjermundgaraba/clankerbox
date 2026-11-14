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
