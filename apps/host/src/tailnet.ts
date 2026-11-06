import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context } from "effect";
import type { Effect, Redacted } from "effect";

/** Mints a key for a machine's node, and `mintBuild` one for a template builder's. */
export interface Interface {
  readonly mint: Effect.Effect<Redacted.Redacted, Internal>;
  readonly mintBuild: Effect.Effect<Redacted.Redacted, Internal>;
}

export class Tailnet extends Context.Service<Tailnet, Interface>()(
  "@clankerbox/host/Tailnet"
) {}
