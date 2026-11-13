import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";
import type { RuntimeTraits } from "@gjermundgaraba/clankerbox-sdk";

export const traits: RuntimeTraits = {
  runtime: RuntimeName.make("smolvm"),
  images: "references",
  checkpoint: "ram",
  captureFrom: "running",
  pause: "saves",
  copies: "grow",
  resize: { running: "grow", stopped: "any" },
  sizes: { _tag: "free" },
  stopsOnItsOwn: false,
};
