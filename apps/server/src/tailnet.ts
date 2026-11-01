import type { TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";

const joinedWait = 60;

export const longestBackoff = 64;

/** A machine's place on the tailnet, kept in memory: each start checks it again. */
export interface TailnetCheck {
  readonly status: TailnetStatus | undefined;
  readonly wait: number | undefined;
  readonly backoff: number;
}

export const unchecked: TailnetCheck = {
  status: undefined,
  wait: undefined,
  backoff: 1,
};

/** What a machine starts from once it runs: due, as nothing has looked at it yet. */
export const firstCheck: TailnetCheck = { ...unchecked, wait: 0 };

export const checked = (
  check: TailnetCheck,
  status: TailnetStatus | undefined
): TailnetCheck => {
  if (status?.state === "joined") {
    return { status, wait: joinedWait, backoff: 1 };
  }

  if (status?.state === "failed") {
    return {
      status,
      wait: check.backoff,
      backoff: Math.min(check.backoff * 2, longestBackoff),
    };
  }

  return { ...unchecked, status };
};

export const ticked = (check: TailnetCheck): TailnetCheck =>
  check.wait === undefined || check.wait === 0
    ? check
    : { ...check, wait: check.wait - 1 };

export const due = (check: TailnetCheck): boolean => check.wait === 0;
