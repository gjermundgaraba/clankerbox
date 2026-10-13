import { Schema } from "effect";
import { HostErrorTag } from "./errors.ts";
import { HostId, Id } from "./ids.ts";

export const Runtime = Schema.Literals(["smolvm", "tart", "boat"]);

export type Runtime = typeof Runtime.Type;

const Size = Schema.Int.check(Schema.isGreaterThan(0));

/** The mutations that record themselves on a resource's `action`. */
export const ActionName = Schema.Literals([
  "create",
  "start",
  "stop",
  "delete",
  "fork",
  "restore",
  "capture",
]);

export type ActionName = typeof ActionName.Type;

export const ActionStatus = Schema.Literals(["running", "failed", "done"]);

export type ActionStatus = typeof ActionStatus.Type;

/** A resource's last action; the next action replaces it. */
export const ActionRecord = Schema.Union([
  Schema.Struct({ name: ActionName, status: Schema.Literals(["running", "done"]) }),
  Schema.Struct({
    name: ActionName,
    status: Schema.Literal("failed"),
    error: Schema.Struct({ tag: HostErrorTag, message: Schema.String }),
  }),
]);

export type ActionRecord = typeof ActionRecord.Type;

export const SshEndpoint = Schema.Struct({
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
});

export type SshEndpoint = typeof SshEndpoint.Type;

export const SshLogin = Schema.Struct({
  user: Schema.String,
  ...SshEndpoint.fields,
});

export type SshLogin = typeof SshLogin.Type;

export const Machine = Schema.Struct({
  id: Id,
  runtime: Runtime,
  createdAt: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  /** `missing`: the runtime doesn't have it; `unknown`: it couldn't be read. */
  state: Schema.Literals(["running", "stopped", "missing", "unknown"]),
  /** Until its create, fork or restore has made it, it can only be read, stopped or deleted. */
  made: Schema.Boolean,
  action: ActionRecord,
  /** Only on a running machine whose runtime gives it an endpoint. */
  ssh: Schema.optionalKey(SshLogin),
  /** `<type> <base64>`, once preparation has recorded it. */
  hostKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Machine" });

export type Machine = typeof Machine.Type;

export const Checkpoint = Schema.Struct({
  id: Id,
  createdAt: Schema.DateTimeUtcFromString,
  machine: Id,
  /** `ram` (RAM and disks) on smolvm, `disk` on Tart and boat. */
  kind: Schema.Literals(["ram", "disk"]),
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  action: ActionRecord,
}).annotate({ identifier: "Checkpoint" });

export type Checkpoint = typeof Checkpoint.Type;

export const Host = Schema.Struct({
  id: HostId,
  runtime: Runtime,
  version: Schema.String,
  /** For boat, its API version. */
  runtimeVersion: Schema.String,
  /** The state a machine must be in to be captured: Tart's is `stopped`. */
  captureFrom: Schema.Literals(["running", "stopped"]),
  bases: Schema.Array(Schema.String),
}).annotate({ identifier: "Host" });

export type Host = typeof Host.Type;

/**
 * `used` is counted as a `Capacity` refusal counts it, so it needn't match the host's own
 * machines.
 */
export const Limit = Schema.Struct({
  host: HostId,
  /**
   * `ramMib`: smolvm's RAM budget. `runningVms`: Tart's, Apple's two VMs per Mac.
   * `activeSandboxes` and the `starts` of each rolling window: the boat account's.
   */
  resource: Schema.Literals([
    "ramMib",
    "runningVms",
    "activeSandboxes",
    "startsPerMinute",
    "startsPerHour",
    "startsPerDay",
  ]),
  limit: Schema.Int,
  used: Schema.Int,
}).annotate({ identifier: "Limit" });

export type Limit = typeof Limit.Type;

/** Nothing logs the script: it can carry secrets. */
export const Setup = Schema.Struct({
  script: Schema.String,
  timeoutSeconds: Schema.optionalKey(Size),
});

export type Setup = typeof Setup.Type;

const specFields = {
  base: Schema.String,
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  setup: Schema.optionalKey(Setup),
  profile: Schema.optionalKey(Schema.String),
};

/** A profile file fills these in; the host sees only the `profile` label. */
export const MachineSpec = Schema.Struct(specFields);

export type MachineSpec = typeof MachineSpec.Type;

/** The host checks that `id` names it, so a create never lands under another host's ID. */
export const CreateRequest = Schema.Struct({ id: Id, ...specFields });

export type CreateRequest = typeof CreateRequest.Type;
