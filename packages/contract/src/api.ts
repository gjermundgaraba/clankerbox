/**
 * The host API: three effect-actions groups, served as JSON POST routes under `/api`.
 * A mutation replies when its action has finished.
 */
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Schema } from "effect";
import type { HttpApiError } from "effect/http-api";
import { hostErrors, Internal, Invalid } from "./errors.ts";
import { Id, Name } from "./ids.ts";
import { Checkpoint, CreateRequest, Host, Machine } from "./resources.ts";

/**
 * Without a policy, effect-actions answers undeclared or malformed input with an empty 400.
 * Schema issues never carry the rejected values, so a setup script never reaches a message.
 */
const schemaError: ActionGroup.SchemaErrorPolicy<typeof Invalid, typeof Internal> = {
  invalid: {
    schema: Invalid,
    make: (failure: HttpApiError.HttpApiSchemaError) =>
      new Invalid({
        message: `the request doesn't match the action's input: ${failure.cause.message}`,
      }),
  },
  internal: {
    schema: Internal,
    make: () => new Internal({ message: "the host's reply did not encode" }),
  },
};

const ById = Schema.Struct({ id: Id });

/** Input of the actions that make a new resource from a machine: its ID and the new name. */
const FromMachine = Schema.Struct({ machine: Id, name: Name });

export const MachineGroup = ActionGroup.make(
  { name: "machine", errors: hostErrors, schemaError },
  Action.make("list", {
    description: "List the host's machines.",
    success: Schema.Array(Machine),
    access: "read",
  }),
  Action.make("get", {
    description: "Read one machine.",
    input: ById,
    success: Machine,
    access: "read",
  }),
  Action.make("create", {
    description: "Create a machine from a base, run its setup once, and prepare it.",
    input: CreateRequest,
    success: Machine,
    access: "write",
  }),
  Action.make("start", {
    description: "Start a machine. On a running machine, run preparation again.",
    input: ById,
    success: Machine,
    access: "write",
  }),
  Action.make("stop", {
    description: "Stop a machine. Stopping a stopped machine does nothing.",
    input: ById,
    success: Machine,
    access: "write",
  }),
  Action.make("delete", {
    description: "Delete a machine and everything native it owns.",
    input: ById,
    success: Schema.Void,
    access: "write",
  }),
  Action.make("fork", {
    description: "Copy a machine to a new name on the same host.",
    input: FromMachine,
    success: Machine,
    access: "write",
  }),
  Action.make("restore", {
    description: "Create a machine on the checkpoint's host from that checkpoint.",
    input: Schema.Struct({ checkpoint: Id, name: Name }),
    success: Machine,
    access: "write",
  }),
);

export const CheckpointGroup = ActionGroup.make(
  { name: "checkpoint", errors: hostErrors, schemaError },
  Action.make("list", {
    description: "List the host's checkpoints.",
    success: Schema.Array(Checkpoint),
    access: "read",
  }),
  Action.make("get", {
    description: "Read one checkpoint.",
    input: ById,
    success: Checkpoint,
    access: "read",
  }),
  Action.make("capture", {
    description:
      "Capture a checkpoint of a machine. Its kind follows the runtime: ram on smolvm, which captures only a running machine, and disk on Tart and boat.",
    input: FromMachine,
    success: Checkpoint,
    access: "write",
  }),
  Action.make("delete", {
    description: "Delete a checkpoint.",
    input: ById,
    success: Schema.Void,
    access: "write",
  }),
);

export const HostGroup = ActionGroup.make(
  { name: "host", errors: hostErrors, schemaError },
  Action.make("get", {
    description: "Read the host: its runtime, versions and bases.",
    success: Host,
    access: "read",
  }),
);

export const Http = ActionHttp.make({ apiPath: "/api" }, MachineGroup, CheckpointGroup, HostGroup);
