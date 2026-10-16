import { Schema } from "effect";
import { HostError } from "./errors.ts";
import { HostId, Id } from "./ids.ts";

export const Runtime = Schema.Literals(["smolvm", "tart", "boat"]);

export type Runtime = typeof Runtime.Type;

const Size = Schema.Int.check(Schema.isGreaterThan(0));

/** What the operator asked a machine to be; the host keeps moving the machine toward it. */
export const Desired = Schema.Literals(["running", "stopped", "deleted"]);

export type Desired = typeof Desired.Type;

/**
 * What the host is doing about a machine. A request waits for a rest: `settled`, at rest with what
 * was asked; `failed`, after a step failed, until the next request; `lost`, one the runtime no
 * longer has, which can only be deleted; and `waiting`, one the runtime can't read, which fails the
 * request and is read again at the host's next recheck. `creating` copies the machine and runs its
 * setup, and a machine whose create or setup fails is deleted. `starting` starts the machine, also
 * when it runs already, and prepares it.
 */
export const Phase = Schema.Literals([
  "observing",
  "waiting",
  "creating",
  "starting",
  "stopping",
  "deleting",
  "settled",
  "failed",
  "lost",
]);

export type Phase = typeof Phase.Type;

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
 * `state` is what the runtime reports: `missing` when it doesn't have the machine, and `unknown`
 * when it couldn't be read. `desired` is what the last request asked for, `phase` what the host is
 * doing about it, and `error` why the last step failed, until the next request. `ssh` is only
 * on a running machine whose runtime gives it an endpoint, and `hostKey`, `<type> <base64>`, once
 * preparation has recorded it.
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
  desired: Desired,
  phase: Phase,
  error: Schema.optionalKey(HostError),
  ssh: Schema.optionalKey(SshLogin),
  hostKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Machine" });

export type Machine = typeof Machine.Type;

/**
 * The state as people read it: `running` at rest, `running (failed)` where it is but not at rest,
 * and `stopped, wants running (starting)` on the way.
 */
export const stateLabel = ({ state, desired, phase }: Machine): string =>
  phase === "settled"
    ? state
    : state === desired
      ? `${state} (${phase})`
      : `${state}, wants ${desired} (${phase})`;

/**
 * `kind` is `ram` (RAM and disks) on smolvm, and `disk` on Tart and boat. A checkpoint exists only
 * once its capture is done, and never changes after.
 */
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
}).annotate({ identifier: "Checkpoint" });

export type Checkpoint = typeof Checkpoint.Type;

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

/** A prebuild is the checkpoint `id` of a machine made from the spec, setup and all. */
export const PrebuildRequest = Schema.Struct({ id: Id, ...specFields, setup: Setup });

export type PrebuildRequest = typeof PrebuildRequest.Type;

/** `built` is false when the host already had the checkpoint. */
export const Prebuilt = Schema.Struct({ checkpoint: Checkpoint, built: Schema.Boolean });

export type Prebuilt = typeof Prebuilt.Type;
