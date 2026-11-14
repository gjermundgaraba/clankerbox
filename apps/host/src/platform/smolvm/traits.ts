import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/data/resources.rs#L250
const leastRamMib = 64;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L4511
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6466
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6539
const mostCpuParsed = 255;

// https://github.com/smol-machines/libkrun/blob/9df62257098acb5a3cd4f6807cf84f09e1b13323/src/arch/src/x86_64/mptable.rs#L82
const mostCpuOnX64 = 254;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L4517
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6470
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6543
const mostRamMib = 2 ** 32 - 1;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/krun.rs#L331
// https://github.com/smol-machines/libkrun/blob/9df62257098acb5a3cd4f6807cf84f09e1b13323/src/vmm/src/builder.rs#L869
const liveCpu = 16;

/** The traits of a smolvm host on `arch`, as Node names it. */
export const traits = (arch: string): RuntimeTraits => ({
  runtime: RuntimeName.make("smolvm"),
  images: "references",
  checkpoint: "ram",
  captureFrom: "running",
  pause: "saves",
  stop: "resumes",
  copies: "grow",
  resize: { running: "grow", stopped: "any" },
  sizes: { _tag: "free" },
  limits: {
    least: { ramMib: leastRamMib },
    most: {
      cpu: arch === "x64" ? mostCpuOnX64 : mostCpuParsed,
      ramMib: mostRamMib,
    },
    live: { cpu: liveCpu },
  },
});
