import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";
import type { Sizes } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr } from "effect";

import type { BoatType } from "./api.ts";

const gib = 1024;

/**
 * Each type's disk as the guest's block device reads it. boat's own figures, 51, 51, 111 and 251
 * GB, are the room it leaves the user's own files, without the system's, so the two differ and
 * neither decides a resize or a fork to a smaller type: boat refuses `type_too_small` where the
 * machine's data doesn't fit.
 * https://docs.boat.dev/machines
 */
export const types: Readonly<Record<BoatType, Sizes>> = {
  small: { cpu: 2, ramMib: 4 * gib, diskGib: 80 },
  default: { cpu: 4, ramMib: 8 * gib, diskGib: 80 },
  large: { cpu: 8, ramMib: 16 * gib, diskGib: 149 },
  xlarge: { cpu: 16, ramMib: 32 * gib, diskGib: 251 },
};

/**
 * The most of the user's own files each type holds, boat's "Disk" column, in bytes: 51, 51, 111
 * and 251 GB. boat refuses `type_too_small` against these on a resume and a `/fork`, but not on a
 * create from a saved snapshot, which a fork of a running sandbox goes through: measured live on
 * 2026-11-21, a large sandbox holding 90 GiB saved and created as a small came up holding all 90.
 * https://docs.boat.dev/machines
 */
export const filesBytes: Readonly<Record<BoatType, number>> = {
  small: 51e9,
  default: 51e9,
  large: 111e9,
  xlarge: 251e9,
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

/**
 * A fork of a running sandbox saves a fresh snapshot first, timed live on 2026-11-21 at 694 s, 906 s
 * and 2807 s for the same 90 GiB. Its check of the save's size against the fork's type is checked against the fake
 * alone.
 */
export const traits = (
  offered: Arr.NonEmptyReadonlyArray<BoatType>
): RuntimeTraits => ({
  runtime: RuntimeName.make("boat"),
  images: "named",
  captureFrom: "either",
  copies: "any",
  resize: { running: "none", stopped: "any" },
  sizes: {
    _tag: "classes",
    classes: Arr.map(offered, (name) => ({ name, ...types[name] })),
  },
  limits: { least: {}, most: {} },
});
