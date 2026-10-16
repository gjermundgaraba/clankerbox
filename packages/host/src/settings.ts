import type { Runtime } from "@gjermundgaraba/clankerbox-sdk";
import { Duration } from "effect";
import type { PortRange } from "./machine-ports.ts";

export interface HostSettings {
  readonly id: string;
  readonly runtime: Runtime;
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly bases: ReadonlyMap<string, string>;
  readonly machinePorts: PortRange;
  /**
   * How long a machine rests before the runtime is read again, for every resting machine at once:
   * one the runtime couldn't read included.
   */
  readonly recheck: Duration.Duration;
}

export const defaultRecheck = Duration.seconds(30);
