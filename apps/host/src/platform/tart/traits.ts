import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

export const traits: RuntimeTraits = {
  runtime: RuntimeName.make("tart"),
  images: "named",
  checkpoint: "disk",
  captureFrom: "stopped",
  pause: "saves",
  stop: "discards",
  copies: "any",
  resize: { running: "none", stopped: "any" },
  sizes: { _tag: "free" },
};
