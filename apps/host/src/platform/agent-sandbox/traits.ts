import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

export const traits: RuntimeTraits = {
  runtime: RuntimeName.make("agent-sandbox"),
  images: "references",
  captureFrom: "either",
  copies: "any",
  resize: { running: "none", stopped: "any" },
  sizes: { _tag: "free" },
  limits: { least: {}, most: {} },
};
