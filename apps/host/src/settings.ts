export interface PortRange {
  readonly first: number;
  readonly last: number;
}

/** A range some program on the host takes ports from, which machines' ports must stay out of. */
export interface ReservedPorts extends PortRange {
  readonly owner: string;
}

export const defaultMachinePorts: PortRange = { first: 10_000, last: 19_999 };

export interface HostSettings {
  readonly id: string;
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly bases: ReadonlyMap<string, string>;
  readonly machinePorts: PortRange;
}
