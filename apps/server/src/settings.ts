import { Duration } from "effect";

import type { Member } from "./hosts.ts";

export interface ServerSettings {
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly hosts: readonly Member[];
  /** How often what no request wakes is looked at again. */
  readonly recheck: Duration.Duration;
  /** How long a failed create's or capture's row stays to tell why. */
  readonly failedRowsLast: Duration.Duration;
}

export const defaultRecheck = Duration.seconds(30);

export const defaultFailedRowsLast = Duration.days(1);
