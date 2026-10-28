import type { Checkpoint, Kind } from "@gjermundgaraba/clankerbox-sdk";
import { Duration } from "effect";

import type { PortRange } from "./machine-ports.ts";

export interface HostSettings {
  readonly id: string;
  readonly kind: Kind;
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly bases: ReadonlyMap<string, string>;
  readonly machinePorts: PortRange;
  readonly recheck: Duration.Duration;
}

export const checkpointKinds = {
  linux: "ram",
  mac: "disk",
} as const satisfies Record<Kind, Checkpoint["kind"]>;

export const defaultRecheck = Duration.seconds(30);
