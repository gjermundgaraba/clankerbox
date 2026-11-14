import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

/** smol cloud's traits, with the most the account's plan gives one machine. */
export const traits = (
  most: RuntimeTraits["limits"]["most"]
): RuntimeTraits => ({
  runtime: RuntimeName.make("smol-cloud"),
  images: "references",
  checkpoint: "ram",
  captureFrom: "running",
  pause: "saves",
  stop: "resumes",
  copies: "same",
  resize: { running: "grow", stopped: "grow" },
  sizes: { _tag: "free" },
  limits: { least: {}, most, live: {} },
});
