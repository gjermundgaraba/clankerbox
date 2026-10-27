import type { Checkpoint, Kind } from "@gjermundgaraba/clankerbox-sdk";
import { Duration } from "effect";

import type { PortRange } from "./machine-ports.ts";

export interface HostSettings {
  readonly id: string;
  /**
   * Fixes its checkpoints, through `checkpointKinds`: `ram` (RAM and disks) on linux, of a running
   * machine, and `disk` on mac, of a stopped one.
   */
  readonly kind: Kind;
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

export const checkpointKinds = {
  linux: "ram",
  mac: "disk",
} as const satisfies Record<Kind, Checkpoint["kind"]>;

export const defaultRecheck = Duration.seconds(30);
