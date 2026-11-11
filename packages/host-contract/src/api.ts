import {
  Conflict,
  Executed,
  ExecRequest,
  HostError,
  Internal,
  Invalid,
  Kind,
  Machine,
  Missing,
  Name,
  Port,
  PublicKeys,
  Reading,
  Setup,
  Sizing,
  TailnetStatus,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Schema } from "effect";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

const sizes = { cpu: Size, ramMib: Size, diskGib: Size };

/** A machine as a runtime knows it. `instance` tells it from an earlier machine of its name. */
export const MachineRef = Schema.Struct({
  name: Name,
  instance: Schema.String,
  ...sizes,
  port: Port,
});

export type MachineRef = typeof MachineRef.Type;

/** A machine still to be made: the host gives it its port. */
export const NewMachine = Schema.Struct({
  name: Name,
  instance: Schema.String,
  ...sizes,
});

export type NewMachine = typeof NewMachine.Type;

export const Native = Schema.Struct({
  name: Name,
  instance: Schema.String,
});

export type Native = typeof Native.Type;

export const CheckpointRef = MachineRef;

export type CheckpointRef = MachineRef;

export const MachineState = Machine.fields.state;

export type MachineState = typeof MachineState.Type;

const pinned = { pin: Schema.optionalKey(Schema.String) };

export const Source = Schema.Union([
  Schema.TaggedStruct("base", {
    base: Schema.String,
    setup: Schema.optionalKey(Setup),
  }),
  Schema.TaggedStruct("checkpoint", { checkpoint: CheckpointRef, ...pinned }),
  Schema.TaggedStruct("machine", { machine: MachineRef, ...pinned }),
]);

export type Source = typeof Source.Type;

const others = { machines: Schema.Array(MachineRef) };

const hooked = { hook: Schema.optionalKey(Schema.Literal(true)) };

/**
 * What a host runs. `pin` is the runtime pin a VM booted under, compared with the host's own, and
 * `machines` the host's other machines, which admission counts beside the one a step boots. A step
 * that acts by what its VM is doing reads it from the runtime as it begins. A make's
 * `authorizedKeys` go to the login user once the machine is made, after its setup if it has one,
 * beside the keys already there. A make's `join` puts the machine on the tailnet as `hostname` for
 * its setup, and logs it out after, so its copies carry no node. A copy's make then prepares it, as
 * a start does. A `publish` copies a checkpoint's files to the build store under its name, and a
 * `fetch` makes a checkpoint from what was published as `from`, of template build `build`,
 * downloading only what this host doesn't hold. A delete that will `unpublish` also removes the
 * checkpoint from the build store, with every key no other published checkpoint holds. A stop, pause
 * or remove with `hook` first runs the guest's hook for it, if its VM runs, and goes on whatever the
 * hook does; a pause that stops runs the stop hook.
 */
export const Step = Schema.Union([
  Schema.TaggedStruct("make", {
    machine: NewMachine,
    source: Source,
    authorizedKeys: Schema.optionalKey(PublicKeys),
    join: Schema.optionalKey(Schema.Struct({ hostname: Schema.String })),
    ports: Schema.Array(Port),
    ...others,
  }),
  Schema.TaggedStruct("start", {
    machine: MachineRef,
    ...pinned,
    ...others,
  }),
  Schema.TaggedStruct("stop", {
    machine: MachineRef,
    ...pinned,
    ...others,
    ...hooked,
  }),
  Schema.TaggedStruct("pause", { machine: MachineRef, ...pinned, ...hooked }),
  Schema.TaggedStruct("remove", { machine: Native, ...hooked }),
  Schema.TaggedStruct("resize", {
    machine: MachineRef,
    to: Sizing,
    ...others,
  }),
  Schema.TaggedStruct("capture", {
    machine: MachineRef,
    checkpoint: CheckpointRef,
    ...pinned,
  }),
  Schema.TaggedStruct("deleteCheckpoint", {
    checkpoint: CheckpointRef,
    unpublish: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("join", {
    machine: MachineRef,
    hostname: Schema.String,
  }),
  Schema.TaggedStruct("publish", { checkpoint: CheckpointRef }),
  Schema.TaggedStruct("fetch", {
    checkpoint: CheckpointRef,
    from: Schema.String,
    build: Schema.String,
  }),
]);

export type Step = typeof Step.Type;

/**
 * One whole step for a host to run to its end, whether or not the caller stays. `scope` names the
 * resource it changes. Delivering an `id` again returns that operation, a lower or equal `sequence`
 * in the scope is refused, and a higher one cuts short what still runs there, and forgets the one
 * before once it ended, collected or not. `boot` is the host process it was meant for: another
 * process refuses it, as the scopes it would be fenced by are gone. The host keeps no step past its
 * end, so a setup leaves its memory with the step that runs it.
 */
export const Operation = Schema.Struct({
  id: Schema.String,
  boot: Schema.String,
  scope: Schema.String,
  sequence: Schema.Int,
  step: Step,
});

export type Operation = typeof Operation.Type;

export const Outcome = Schema.Struct({
  port: Schema.optionalKey(Port),
  hostKey: Schema.optionalKey(Schema.String),
  sizes: Schema.optionalKey(Schema.Struct(sizes)),
  tailnet: Schema.optionalKey(TailnetStatus),
  /** A copy's make that gave it its own identity and prepared it, so it needs no start. */
  prepared: Schema.optionalKey(Schema.Literal(true)),
  /** A capture that failed and left nothing on its host, so a delete would find nothing. */
  cleared: Schema.optionalKey(Schema.Literal(true)),
});

export type Outcome = typeof Outcome.Type;

/**
 * `running` until the step ends; `cancelled` only once it has, so a step cut short holds its lease
 * until the VM is where its command took it. `absent` means this host's process doesn't hold the
 * operation, and `boot` tells a restart from a delivery that hasn't come.
 */
export const Report = Schema.Struct({
  id: Schema.String,
  boot: Schema.String,
  status: Schema.Literals(["running", "done", "failed", "cancelled", "absent"]),
  outcome: Outcome,
  error: Schema.optionalKey(HostError),
});

export type Report = typeof Report.Type;

/**
 * What the control plane needs to know of a host. `images` is the image each of `bases` names
 * there, `boot` is new each time its process starts, and `builds` tells a host that copies template
 * builds through the build store.
 */
export const HostInfo = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  version: Schema.String,
  runtimeVersion: Schema.String,
  bases: Schema.Array(Schema.String),
  images: Schema.Record(Schema.String, Schema.String),
  boot: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  publishAddress: Schema.String,
  joins: Schema.Boolean,
  builds: Schema.Boolean,
}).annotate({ identifier: "HostInfo" });

export type HostInfo = typeof HostInfo.Type;

const ById = Schema.Struct({ id: Schema.String });

const Machines = Schema.Struct({ machines: Schema.Array(MachineRef) });

const { id: _machine, ...command } = ExecRequest.fields;

export const ExecCommand = Schema.Struct({ machine: MachineRef, ...command });

export type ExecCommand = typeof ExecCommand.Type;

const read = { caller: Action.Anyone, readOnly: true } as const;

const write = { caller: Action.Anyone, readOnly: false } as const;

export const HostHttp = ActionHttp.make(
  [
    Action.make("readHost", {
      ...read,
      error: [Invalid] as const,
      description: "Read what the control plane needs to know of this host.",
      success: HostInfo,
    }),
    Action.make("readMachines", {
      ...read,
      error: [Invalid, Internal] as const,
      description:
        "Read each machine's state from the runtime. A machine it couldn't read is unknown.",
      input: Schema.Struct({ machines: Schema.Array(Native) }),
      success: Schema.Array(Schema.Struct({ name: Name, state: MachineState })),
    }),
    Action.make("readSizes", {
      ...read,
      error: [Invalid, Internal] as const,
      description: "Read back the sizes the runtime holds for a machine.",
      input: Schema.Struct({ machine: MachineRef }),
      success: Sizing,
    }),
    Action.make("readCapacity", {
      ...read,
      error: [Invalid, Internal] as const,
      description:
        "Read this host's resources, counting the machines given and the ones booting.",
      input: Machines,
      success: Schema.Array(Reading),
    }),
    Action.make("adoptMachines", {
      ...write,
      error: [Invalid, Internal] as const,
      description:
        "Give a host that started the machines it holds, for what its runtime keeps beside each VM.",
      input: Machines,
    }),
    Action.make("runOperation", {
      ...write,
      error: [Invalid, Conflict] as const,
      description:
        "Start an operation and answer at once. Conflict refuses a sequence the scope has seen, or another host process's operation.",
      input: Operation,
      success: Report,
    }),
    Action.make("waitOperation", {
      ...read,
      error: [Invalid] as const,
      description:
        "Report an operation, waiting a few seconds for it to end when it still runs.",
      input: ById,
      success: Report,
    }),
    Action.make("cancelOperation", {
      ...write,
      error: [Invalid] as const,
      description:
        "Cut an operation short. Its report turns cancelled only once its step has ended.",
      input: ById,
    }),
    Action.make("collectOperation", {
      ...write,
      error: [Invalid] as const,
      description:
        "Forget a finished operation, once its report is safely stored.",
      input: ById,
    }),
    Action.make("execMachine", {
      ...write,
      error: [Invalid, Missing, WrongState, Internal] as const,
      description:
        "Run a command in a running machine, once any step on it has ended, and answer its exit code and output. It runs as long as the request does, or until its timeout, which answers exit code 124. Nothing of it is kept.",
      input: ExecCommand,
      success: Executed,
    }),
  ],
  { prefix: "/host" }
);

export const hostActionsByName = Action.byName(HostHttp.actions);

export type HostAction = keyof typeof hostActionsByName;
