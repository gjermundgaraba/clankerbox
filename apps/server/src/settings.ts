import { Duration } from "effect";

import type { Member } from "./hosts.ts";

export interface ServerSettings {
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly hosts: readonly Member[];
  readonly recheck: Duration.Duration;
  readonly failedRowsLast: Duration.Duration;
  readonly authorizedKeys: string;
  readonly hookTimeoutSeconds: number;
}

export const defaultRecheck = Duration.seconds(30);

export const defaultHookTimeoutSeconds = 120;

export const defaultFailedRowsLast = Duration.days(1);
