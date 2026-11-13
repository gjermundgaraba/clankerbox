import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";
import type { RuntimeTraits, Sizes } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr } from "effect";

import type { BoatType } from "./api.ts";

const gib = 1024;

export const types: Readonly<Record<BoatType, Sizes>> = {
  small: { cpu: 2, ramMib: 4 * gib, diskGib: 80 },
  default: { cpu: 4, ramMib: 8 * gib, diskGib: 80 },
  large: { cpu: 8, ramMib: 16 * gib, diskGib: 149 },
  xlarge: { cpu: 16, ramMib: 32 * gib, diskGib: 251 },
};

export const typeOf = (
  offered: readonly BoatType[],
  sizes: Sizes
): BoatType | undefined =>
  offered.find((type) => {
    const given = types[type];

    return (
      given.cpu === sizes.cpu &&
      given.ramMib === sizes.ramMib &&
      given.diskGib === sizes.diskGib
    );
  });

export const traits = (
  offered: Arr.NonEmptyReadonlyArray<BoatType>
): RuntimeTraits => ({
  runtime: RuntimeName.make("boat"),
  images: "named",
  checkpoint: "disk",
  captureFrom: "stopped",
  pause: "stops",
  copies: "any",
  resize: { running: "none", stopped: "any" },
  sizes: {
    _tag: "classes",
    classes: Arr.map(offered, (name) => ({ name, ...types[name] })),
  },
  stopsOnItsOwn: true,
});
