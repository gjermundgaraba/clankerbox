/** The resources a host reports: machines, checkpoints and the host itself. */
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

/**
 * A resource's last action: `running` while it holds the row, `failed` with its error
 * after a native failure, `done` after a success. The next action replaces it.
 */
export const ActionRecord = Schema.Struct({
  name: ActionName,
  status: Schema.Literals(["running", "failed", "done"]),
  error: Schema.optionalKey(Schema.Struct({ tag: HostErrorTag, message: Schema.String })),
});

export type ActionRecord = typeof ActionRecord.Type;

/** Where a machine's guest port 22 is reached. */
export const SshEndpoint = Schema.Struct({
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
});

export type SshEndpoint = typeof SshEndpoint.Type;

export const Machine = Schema.Struct({
  id: Id,
  runtime: Runtime,
  createdAt: Schema.DateTimeUtcFromString,
  base: Schema.String,
  /** The label the client passed at create, normally its profile's name. */
  profile: Schema.optionalKey(Schema.String),
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  /** Read from the runtime, never stored. */
  state: Schema.Literals(["running", "stopped", "missing"]),
  action: ActionRecord,
  ssh: Schema.optionalKey(SshEndpoint),
  /** The guest's SSH host public key, as `<type> <base64>`. */
  hostKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Machine" });

export type Machine = typeof Machine.Type;

export const Checkpoint = Schema.Struct({
  id: Id,
  createdAt: Schema.DateTimeUtcFromString,
  /** The ID of the machine it was captured from. */
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

export const Host = Schema.Struct({
  id: HostId,
  runtime: Runtime,
  /** The clankerbox version the host runs. */
  version: Schema.String,
  /** The runtime's version; for boat, its API version. */
  runtimeVersion: Schema.String,
  bases: Schema.Array(Schema.String),
}).annotate({ identifier: "Host" });

export type Host = typeof Host.Type;

/** A setup script and how long it may run. Nothing logs the script: it can carry secrets. */
export const Setup = Schema.Struct({ script: Schema.String, timeoutSeconds: Size });

export type Setup = typeof Setup.Type;

const specFields = {
  base: Schema.String,
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  setup: Schema.optionalKey(Setup),
  profile: Schema.optionalKey(Schema.String),
};

/**
 * What a new machine is made from: a base, its sizes, an optional setup script with its
 * timeout, and an optional `profile` label. A profile file fills these in; the host never
 * sees the profile itself.
 */
export const MachineSpec = Schema.Struct(specFields);

export type MachineSpec = typeof MachineSpec.Type;

/**
 * `machine.create`'s input: the spec and the new machine's full ID. The host checks that the ID
 * names it, so a create never lands under another host's ID.
 */
export const CreateRequest = Schema.Struct({ id: Id, ...specFields });

export type CreateRequest = typeof CreateRequest.Type;

/**
 * A profile file: a client-side file that fills in a create request. `setup.path` is a script
 * file or a recipe directory, relative to the profile file, and comes with its timeout: the
 * profile's author sets it, and there is no default. `host` places the create on that host
 * instead of by base.
 */
export const Profile = Schema.Struct({
  base: specFields.base,
  cpu: specFields.cpu,
  ramMib: specFields.ramMib,
  diskGib: specFields.diskGib,
  setup: Schema.optionalKey(Schema.Struct({ path: Schema.String, timeoutSeconds: Size })),
  host: Schema.optionalKey(HostId),
});

export type Profile = typeof Profile.Type;
