import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/data/resources.rs#L250
const leastRamMib = 64;

// The guest kernel smolvm ships boots no more, on either architecture, and libkrun reserves the
// live-resize slots of a running machine up to the same count:
// https://github.com/smol-machines/smolvm/blob/v1.34.1/lib/linux-x86_64/libkrun.provenance#L6
// https://github.com/smol-machines/libkrunfw/blob/7f4d4950688f259344044db0465162295a1b8255/Makefile#L108-L109
// https://github.com/smol-machines/libkrunfw/blob/7f4d4950688f259344044db0465162295a1b8255/config-libkrunfw_x86_64#L344
// https://github.com/smol-machines/libkrunfw/blob/7f4d4950688f259344044db0465162295a1b8255/config-libkrunfw_aarch64#L398
// https://github.com/smol-machines/libkrun/blob/9df62257098acb5a3cd4f6807cf84f09e1b13323/src/vmm/src/builder.rs#L856-L869
const mostCpu = 16;

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L4517
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6470
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/machine.rs#L6543
// https://github.com/smol-machines/libkrun/blob/9df62257098acb5a3cd4f6807cf84f09e1b13323/src/libkrun/src/lib.rs#L2671
const mostRamMib = 2 ** 32 - 1;

export const traits: RuntimeTraits = {
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
    most: { cpu: mostCpu, ramMib: mostRamMib },
  },
};
