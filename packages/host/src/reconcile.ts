import type { Desired } from "@gjermundgaraba/clankerbox-sdk";
import type { MachineState } from "./runtime.ts";

/** What the host does next about a machine: a step, or a rest. */
export type Next =
  | "creating"
  | "starting"
  | "stopping"
  | "deleting"
  | "waiting"
  | "settled"
  | "lost";

/** What `next` decides from, beside the runtime's report. Only a delete stops a machine's making. */
export interface Decided {
  readonly desired: Desired;
  readonly made: boolean;
  /** Preparation ran since the machine last booted or stopped, in this host's life. */
  readonly prepared: boolean;
}

export const next = (decided: Decided, seen: MachineState): Next => {
  if (decided.desired === "deleted") {
    return "deleting";
  }

  if (!decided.made) {
    return "creating";
  }

  if (seen === "unknown") {
    return "waiting";
  }

  if (seen === "missing") {
    return "lost";
  }

  const running = seen === "running";

  if (decided.desired === "stopped") {
    return running ? "stopping" : "settled";
  }

  return running && decided.prepared ? "settled" : "starting";
};
