/**
 * The host API: three effect-actions bindings, one per area, served as JSON POST routes at
 * `/api/<area>/<action>`. A mutation replies when its action has finished. Every action is
 * public: a host listens only on the tailnet or loopback.
 */
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Schema } from "effect";
import { hostErrors } from "./errors.ts";
import { Id, Name } from "./ids.ts";
import { Checkpoint, CreateRequest, Host, Machine } from "./resources.ts";

/**
 * How long a client waits for a read's reply from one host, unless it sets its own. A host
 * bounds its own reads of runtime state under it, so a list answers in time.
 */
export const readTimeout = Duration.seconds(10);

/**
 * The header every client request carries the SDK's `version` in. A host refuses a request
 * whose release (major.minor) differs from its own, or that carries none, before it runs
 * anything.
 */
export const versionHeader = "clankerbox-version";

const ById = Schema.Struct({ id: Id });

/** Input of the actions that make a new resource from a machine: its ID and the new name. */
const FromMachine = Schema.Struct({ machine: Id, name: Name });

export const MachineHttp = ActionHttp.make(
  [
    Action.make("list", {
      description: "List the host's machines.",
      success: Schema.Array(Machine),
      readOnly: true,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("get", {
      description: "Read one machine.",
      input: ById,
      success: Machine,
      readOnly: true,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("create", {
      description: "Create a machine from a base, run its setup once, and prepare it.",
      input: CreateRequest,
      success: Machine,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("start", {
      description: "Start a machine. On a running machine, run preparation again.",
      input: ById,
      success: Machine,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("stop", {
      description:
        "Stop a machine. A stopped machine stays stopped, and the stop is still its last action.",
      input: ById,
      success: Machine,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("delete", {
      description: "Delete a machine and everything native it owns.",
      input: ById,
      success: Schema.Void,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("fork", {
      description: "Copy a machine to a new name on the same host.",
      input: FromMachine,
      success: Machine,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("restore", {
      description: "Create a machine on the checkpoint's host from that checkpoint.",
      input: Schema.Struct({ checkpoint: Id, name: Name }),
      success: Machine,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
  ],
  { prefix: "/api/machine" },
);

export const CheckpointHttp = ActionHttp.make(
  [
    Action.make("list", {
      description: "List the host's checkpoints.",
      success: Schema.Array(Checkpoint),
      readOnly: true,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("get", {
      description: "Read one checkpoint.",
      input: ById,
      success: Checkpoint,
      readOnly: true,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("capture", {
      description:
        "Capture a checkpoint of a machine. Its kind follows the runtime: ram on smolvm, which captures only a running machine, and disk on Tart and boat.",
      input: FromMachine,
      success: Checkpoint,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
    Action.make("delete", {
      description: "Delete a checkpoint.",
      input: ById,
      success: Schema.Void,
      readOnly: false,
      caller: Action.Anyone,
      error: hostErrors,
    }),
  ],
  { prefix: "/api/checkpoint" },
);

export const HostHttp = ActionHttp.make(
  [
    Action.make("get", {
      description: "Read the host: its runtime, versions and bases.",
      success: Host,
      readOnly: true,
      caller: Action.Anyone,
      error: hostErrors,
    }),
  ],
  { prefix: "/api/host" },
);
