import { Schema } from "effect";
import { HostError } from "./errors.ts";
import { HostId, Id } from "./ids.ts";

export const Runtime = Schema.Literals(["smolvm", "tart", "boat"]);

export type Runtime = typeof Runtime.Type;

const Size = Schema.Int.check(Schema.isGreaterThan(0));

/** What the operator asked a machine to be; the host keeps moving the machine toward it. */
export const Desired = Schema.Literals(["running", "stopped", "deleted"]);

export type Desired = typeof Desired.Type;

/** The contract's mutations, which record themselves on a resource's `action`. */
export const ActionName = Schema.Literals([
  "createMachine",
  "startMachine",
  "stopMachine",
  "deleteMachine",
  "forkMachine",
  "restoreMachine",
  "captureCheckpoint",
  "deleteCheckpoint",
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
    error: HostError,
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

/**
 * `state` is `missing` when the runtime doesn't have the machine, and `unknown` when it couldn't
 * be read. Until its create, fork or restore has `made` it, a machine can only be read, stopped or
 * deleted. `ssh` is only on a running machine whose runtime gives it an endpoint, and `hostKey`,
 * `<type> <base64>`, once preparation has recorded it.
 */
export const Machine = Schema.Struct({
  id: Id,
  runtime: Runtime,
  createdAt: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  state: Schema.Literals(["running", "stopped", "missing", "unknown"]),
  made: Schema.Boolean,
  action: ActionRecord,
  ssh: Schema.optionalKey(SshLogin),
  hostKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Machine" });

export type Machine = typeof Machine.Type;

/** The state as people read it: `running`, or `stopped (unmade)` for one never made. */
export const stateLabel = ({ state, made }: Machine): string =>
  made ? state : `${state} (unmade)`;

/** `kind` is `ram` (RAM and disks) on smolvm, and `disk` on Tart and boat. */
export const Checkpoint = Schema.Struct({
  id: Id,
  createdAt: Schema.DateTimeUtcFromString,
  machine: Id,
  kind: Schema.Literals(["ram", "disk"]),
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  action: ActionRecord,
}).annotate({ identifier: "Checkpoint" });

export type Checkpoint = typeof Checkpoint.Type;

/** A checkpoint restores once its capture is done; it never changes after. */
export const isReady = (checkpoint: Pick<Checkpoint, "action">): boolean =>
  checkpoint.action.status === "done";

/**
 * `runtimeVersion` is boat's API version on boat. `captureFrom` is the state a machine must be in
 * to be captured: Tart's is `stopped`.
 */
export const Host = Schema.Struct({
  id: HostId,
  runtime: Runtime,
  version: Schema.String,
  runtimeVersion: Schema.String,
  captureFrom: Schema.Literals(["running", "stopped"]),
  bases: Schema.Array(Schema.String),
}).annotate({ identifier: "Host" });

export type Host = typeof Host.Type;

const usageFields = {
  host: HostId,
  resource: Schema.Literals([
    "cpu",
    "ramMib",
    "runningVms",
    "activeSandboxes",
    "startsPerMinute",
    "startsPerHour",
    "startsPerDay",
  ]),
  limit: Schema.optionalKey(Schema.Int),
};

/**
 * A resource of a host and how much of it is in use, counted as a refusal counts it, so it
 * needn't match the host's own machines. When a machine the sum counts couldn't be read, the
 * sum would be a guess, so the row names those machines instead.
 *
 * `cpu` and `ramMib` are what the host's running machines were given, `runningVms` Apple's two
 * VMs per Mac, and `activeSandboxes` and the `starts` of each rolling window the boat account's.
 * `limit` is there only where the host refuses an action that would pass it.
 */
export const Usage = Schema.Union([
  Schema.Struct({ ...usageFields, used: Schema.Int }),
  Schema.Struct({ ...usageFields, unread: Schema.Array(Id) }),
]).annotate({ identifier: "Usage" });

export type Usage = typeof Usage.Type;

type WithoutHost<Row> = Row extends unknown ? Omit<Row, "host"> : never;

/** A `Usage` row as a runtime reads it, before the host names itself on it. */
export type Reading = WithoutHost<Usage>;

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
