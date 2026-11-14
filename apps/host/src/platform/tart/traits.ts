import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Set.swift#L12
// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Set.swift#L41
const mostFlag = 2 ** 16 - 1;

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Get.swift#L36
export const diskGibOf = (gb: number): number =>
  Math.floor((gb * 1e9) / 1024 ** 3);

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
  limits: {
    least: {},
    most: {
      cpu: mostFlag,
      diskGib: diskGibOf(mostFlag),
    },
    live: {},
  },
};
