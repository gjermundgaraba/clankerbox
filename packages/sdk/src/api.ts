import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Schema } from "effect";
import { hostErrors } from "./errors.ts";
import { Id, Name } from "./ids.ts";
import { Checkpoint, CreateRequest, Host, Limit, Machine } from "./resources.ts";

/** A host bounds its own reads of runtime state under it, so a list answers in time. */
export const readTimeout = Duration.seconds(10);

const ById = Schema.Struct({ id: Id });

const FromMachine = Schema.Struct({ machine: Id, name: Name });

/**
 * Every action is public, as a host listens only on the tailnet or loopback. Each declares
 * `hostErrors`, so a client decodes the `Invalid` the host's version check answers with.
 */
const read = { caller: Action.Anyone, error: hostErrors, readOnly: true } as const;

const write = { caller: Action.Anyone, error: hostErrors, readOnly: false } as const;

export const Http = ActionHttp.make(
  [
    Action.make("listMachines", {
      ...read,
      description: "List the host's machines.",
      success: Schema.Array(Machine),
    }),
    Action.make("getMachine", {
      ...read,
      description: "Read one machine.",
      input: ById,
      success: Machine,
    }),
    Action.make("createMachine", {
      ...write,
      description: "Create a machine from a base, run its setup once, and prepare it.",
      input: CreateRequest,
      success: Machine,
    }),
    Action.make("startMachine", {
      ...write,
      description: "Start a machine. On a running machine, run preparation again.",
      input: ById,
      success: Machine,
    }),
    Action.make("stopMachine", {
      ...write,
      description:
        "Stop a machine: a power-off that keeps its disk and ends its processes. A stopped machine stays stopped, and the stop is still its last action.",
      input: ById,
      success: Machine,
    }),
    Action.make("deleteMachine", {
      ...write,
      description: "Delete a machine and everything native it owns.",
      input: ById,
    }),
    Action.make("forkMachine", {
      ...write,
      description: "Copy a machine to a new name on the same host.",
      input: FromMachine,
      success: Machine,
    }),
    Action.make("restoreMachine", {
      ...write,
      description: "Create a machine on the checkpoint's host from that checkpoint.",
      input: Schema.Struct({ checkpoint: Id, name: Name }),
      success: Machine,
    }),
    Action.make("listCheckpoints", {
      ...read,
      description: "List the host's checkpoints.",
      success: Schema.Array(Checkpoint),
    }),
    Action.make("getCheckpoint", {
      ...read,
      description: "Read one checkpoint.",
      input: ById,
      success: Checkpoint,
    }),
    Action.make("captureCheckpoint", {
      ...write,
      description:
        "Capture a checkpoint of a machine. Its kind follows the runtime: ram on smolvm, which captures only a running machine, and disk on Tart and boat.",
      input: FromMachine,
      success: Checkpoint,
    }),
    Action.make("deleteCheckpoint", {
      ...write,
      description: "Delete a checkpoint.",
      input: ById,
    }),
    Action.make("getHost", {
      ...read,
      description: "Read the host: its runtime, versions and bases.",
      success: Host,
    }),
    Action.make("getCapacity", {
      ...read,
      description:
        "Read the host's limits and how much of each is in use. It fails when the runtime can't be read.",
      success: Schema.Array(Limit),
    }),
  ],
  { prefix: "/api" },
);

export const actionsByName = Action.byName(Http.actions);
