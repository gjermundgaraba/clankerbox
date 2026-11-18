import { Invalid } from "@gjermundgaraba/clankerbox-sdk";
import type { Internal, TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Option } from "effect";
import type { Effect, Redacted } from "effect";

/**
 * The control plane's tailnet, provided only when its config names one: a single-use, ephemeral
 * key for one join, never kept, for a machine or for a template build's builder.
 */
export interface Interface {
  readonly mint: Effect.Effect<Redacted.Redacted, Internal>;
  readonly mintBuild: Effect.Effect<Redacted.Redacted, Internal>;
}

export class Tailnet extends Context.Service<Tailnet, Interface>()(
  "@clankerbox/server/Tailnet"
) {}

/** A request for the tailnet that a control plane with none refuses, before anything is recorded. */
export const unserved = (
  asks: true | undefined,
  tailnet: Option.Option<Interface>
): Invalid | undefined =>
  asks !== undefined && Option.isNone(tailnet)
    ? new Invalid({
        message:
          "the control plane has no tailnet in its config, so nothing joins one: add tailnet to its config",
      })
    : undefined;

const joinedWait = 60;

export const longestBackoff = 64;

/** The place on the tailnet of a machine that requests one, kept in memory: each start checks it again. */
export interface TailnetCheck {
  readonly status: TailnetStatus | undefined;
  readonly wait: number | undefined;
  readonly backoff: number;
  /**
   * Whether its next join carries a key, which a node that needs a login takes: after a start or a
   * make, which may leave one, and after a failed check, but not after a restart of the control
   * plane, whose machines' nodes most likely still run, so a key is minted only where one may be
   * used. A node that needs a login fails a join with no key, and the next brings one.
   */
  readonly keyed: boolean;
}

export const unchecked: TailnetCheck = {
  status: undefined,
  wait: undefined,
  backoff: 1,
  keyed: false,
};

export const firstCheck: TailnetCheck = { ...unchecked, wait: 0 };

export const started: TailnetCheck = { ...firstCheck, keyed: true };

export const checked = (
  check: TailnetCheck,
  status: TailnetStatus | undefined
): TailnetCheck => {
  if (status?.state === "joined") {
    return { status, wait: joinedWait, backoff: 1, keyed: false };
  }

  if (status?.state === "failed") {
    return {
      status,
      wait: check.backoff,
      backoff: Math.min(check.backoff * 2, longestBackoff),
      keyed: true,
    };
  }

  return { ...unchecked, status };
};

export const ticked = (check: TailnetCheck): TailnetCheck =>
  check.wait === undefined || check.wait === 0
    ? check
    : { ...check, wait: check.wait - 1 };

export const due = (check: TailnetCheck): boolean => check.wait === 0;
