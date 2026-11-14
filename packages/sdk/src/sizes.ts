export const mibPerGib = 1024;

/** Exactly, as a size flag takes it: `32G`, `1.5G`, `512M`, `1500M`. */
export const formatMib = (mib: number): string =>
  mib >= mibPerGib && mib % (mibPerGib / 2) === 0
    ? `${mib / mibPerGib}G`
    : `${mib}M`;

/** As a size flag takes it: `60G`. */
export const formatGib = (gib: number): string => `${gib}G`;

/** In words: `1 vCPU`, `4 vCPUs`. */
export const formatCpu = (cpu: number): string =>
  cpu === 1 ? "1 vCPU" : `${cpu} vCPUs`;
