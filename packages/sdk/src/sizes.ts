export const mibPerGib = 1024;

/** Exactly, as a size flag takes it: `32G`, `1.5G`, `512M`, `1500M`. */
export const formatMib = (mib: number): string =>
  mib >= mibPerGib && mib % (mibPerGib / 2) === 0 ? `${mib / mibPerGib}G` : `${mib}M`;

/** As a size flag takes it: `60G`. */
export const formatGib = (gib: number): string => `${gib}G`;
