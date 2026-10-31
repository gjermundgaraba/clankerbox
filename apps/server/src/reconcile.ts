import type { MachineState, Report } from "@clankerbox/host-contract";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { Desired, HostError } from "@gjermundgaraba/clankerbox-sdk";

import type { MachineRow, Operation, Stage } from "./store.ts";

/** What a machine does next. `unread` writes nothing: it rests as it is until a read answers. */
export type Next =
  | "creating"
  | "starting"
  | "stopping"
  | "pausing"
  | "resizing"
  | "deleting"
  | "unread"
  | "settled"
  | "failed"
  | "lost";

export interface Decided {
  readonly stage: Stage;
  readonly desired: Desired;
  readonly prepared: boolean;
  readonly resizing: boolean;
}

export const next = (decided: Decided, seen: MachineState): Next => {
  if (decided.desired === "deleted" || decided.stage === "undoing") {
    return "deleting";
  }

  if (decided.stage === "undone") {
    return "failed";
  }

  if (decided.stage === "making") {
    return "creating";
  }

  if (seen === "unknown") {
    return "unread";
  }

  if (seen === "missing") {
    return "lost";
  }

  if (decided.resizing) {
    return "resizing";
  }

  if (decided.desired === "paused") {
    return seen === "running" ? "pausing" : "settled";
  }

  if (decided.desired === "stopped") {
    return seen === "stopped" ? "settled" : "stopping";
  }

  return seen === "running" && decided.prepared ? "settled" : "starting";
};

/** A failed machine rests until the next request; a failed delete runs again at each recheck. */
export const holds = ({ phase, stage, desired }: MachineRow): boolean =>
  phase === "failed" && stage === "made" && desired !== "deleted";

/** Whether `desired` still wants a step of `kind`: one it doesn't is cut short. */
export const wants = (kind: Operation["kind"], desired: Desired): boolean => {
  switch (kind) {
    case "make": {
      return desired !== "deleted";
    }

    case "start":
    case "join": {
      return desired === "running";
    }

    case "stop": {
      return desired === "stopped";
    }

    case "pause": {
      return desired === "paused";
    }

    case "remove":
    case "resize":
    case "capture":
    case "deleteCheckpoint": {
      return true;
    }
  }
};

export type Patch = Partial<
  Pick<
    MachineRow,
    | "stage"
    | "prepared"
    | "phase"
    | "error"
    | "hostKey"
    | "cpu"
    | "ramMib"
    | "diskGib"
    | "port"
  >
>;

const failureAnswers = (row: MachineRow, op: Operation) =>
  wants(op.kind, row.desired) && row.resize === undefined;

const failing = (
  row: MachineRow,
  op: Operation,
  error: HostError,
  sized: Patch
): Patch => {
  if (op.kind === "make") {
    return { stage: "undoing", error, phase: "observing" };
  }

  if (op.kind === "resize") {
    return { error, phase: "failed", ...sized };
  }

  if (op.kind === "remove") {
    return row.stage === "undoing"
      ? { phase: "failed" }
      : { error, phase: "failed" };
  }

  return failureAnswers(row, op)
    ? { error, phase: "failed" }
    : { phase: "observing" };
};

const cutShort = ({ name }: Operation) =>
  new Internal({ message: `the make of ${name} ended on its host` });

/** What a report does to the row, or `removed` when the row goes with it. */
export const settled = (
  row: MachineRow,
  op: Operation,
  report: Report
): Patch | "removed" => {
  const { outcome, error } = report;
  const sized = outcome.sizes ?? {};

  if (report.status === "cancelled") {
    return op.kind === "make" && wants(op.kind, row.desired)
      ? failing(row, op, cutShort(op), sized)
      : { phase: "observing" };
  }

  if (report.status === "failed" && error !== undefined) {
    return failing(row, op, error, sized);
  }

  switch (op.kind) {
    case "make": {
      return {
        stage: "made",
        prepared: false,
        phase: "observing",
        port: outcome.port,
      };
    }

    case "start": {
      return {
        prepared: true,
        phase: "observing",
        ...(outcome.hostKey === undefined ? {} : { hostKey: outcome.hostKey }),
      };
    }

    case "stop":
    case "pause": {
      return { prepared: false, phase: "observing" };
    }

    case "resize": {
      return { phase: "observing", ...sized };
    }

    case "remove": {
      return row.desired === "deleted"
        ? "removed"
        : { stage: "undone", phase: "failed" };
    }

    case "join":
    case "capture":
    case "deleteCheckpoint": {
      return {};
    }
  }
};

/**
 * What an operation its host no longer holds does to the row: a make is undone, as nothing can say
 * how far it got, and any other step is decided afresh from a new read.
 */
export const lost = (op: Operation, error: HostError): Patch =>
  op.kind === "make"
    ? { stage: "undoing", error, phase: "observing" }
    : { phase: "observing" };
