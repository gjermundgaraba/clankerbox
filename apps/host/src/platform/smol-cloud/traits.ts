import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

export const traits: RuntimeTraits = {
  runtime: RuntimeName.make("smol-cloud"),
  images: "references",
  checkpoint: "ram",
  captureFrom: "running",
  pause: "saves",
  stop: "resumes",
  copies: "same",
  resize: { running: "grow", stopped: "grow" },
  sizes: { _tag: "free" },
  limits: { least: {}, most: {}, live: {} },
};
