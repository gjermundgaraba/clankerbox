import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context } from "effect";
import type { Effect, Redacted } from "effect";

export interface Interface {
  readonly mint: Effect.Effect<Redacted.Redacted, Internal>;
}

export class Tailnet extends Context.Service<Tailnet, Interface>()(
  "@clankerbox/host/Tailnet"
) {}
