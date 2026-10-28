import type { Desired } from "@gjermundgaraba/clankerbox-sdk";

import type { MachineState } from "./runtime.ts";

export type Next =
  | "creating"
  | "starting"
  | "stopping"
  | "pausing"
  | "deleting"
  | "waiting"
  | "settled"
  | "lost";

export interface Decided {
  readonly desired: Desired;
  readonly made: boolean;
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

  if (decided.desired === "paused") {
    return seen === "running" ? "pausing" : "settled";
  }

  if (decided.desired === "stopped") {
    return seen === "stopped" ? "settled" : "stopping";
  }

  return seen === "running" && decided.prepared ? "settled" : "starting";
};
