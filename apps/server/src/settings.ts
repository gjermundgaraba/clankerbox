import { Duration } from "effect";

import type { Member } from "./hosts.ts";

export interface ServerSettings {
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly hosts: readonly Member[];
  /** How often what no request wakes is looked at again. */
  readonly recheck: Duration.Duration;
  readonly failedRowsLast: Duration.Duration;
  readonly authorizedKeys: string;
  /** How long a machine's guest hook may run before its stop, pause or delete. */
  readonly hookTimeout: Duration.Duration;
}

export const defaultRecheck = Duration.seconds(30);

export const defaultHookTimeout = Duration.seconds(120);

export const defaultFailedRowsLast = Duration.days(1);
