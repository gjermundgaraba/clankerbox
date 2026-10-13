/** What the host core reads of its config, whatever its runtime: paths resolved, defaults applied. */
import type { Runtime } from "@gjermundgaraba/clankerbox-sdk";
import type { PortRange } from "./machine-ports.ts";

export interface HostSettings {
  readonly id: string;
  readonly runtime: Runtime;
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly bases: ReadonlyMap<string, string>;
  readonly machinePorts: PortRange;
}
