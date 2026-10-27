import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context } from "effect";
import type { Effect, Redacted } from "effect";

export interface Interface {
  /**
   * Mints one auth key for one machine's join: single-use, ephemeral, preauthorized and for the
   * host's tags, expiring within minutes. The secret that mints it never leaves the host, and
   * only a host that joins its machines to a tailnet provides the service.
   */
  readonly mint: Effect.Effect<Redacted.Redacted, Internal>;
}

export class Tailnet extends Context.Service<Tailnet, Interface>()(
  "@clankerbox/host/Tailnet"
) {}
