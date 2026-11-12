import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context } from "effect";
import type { Effect } from "effect";

export interface PortRange {
  readonly first: number;
  readonly last: number;
}

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/fork.rs#L4511-L4513
export const reservedPorts: ReadonlyArray<
  PortRange & { readonly owner: string }
> = [
  { first: 20_000, last: 31_999, owner: "smolvm's fork ports" },
  { first: 32_768, last: 60_999, owner: "Linux's ephemeral ports" },
  { first: 49_152, last: 65_535, owner: "macOS's ephemeral ports" },
];

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
