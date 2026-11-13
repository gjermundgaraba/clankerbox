import {
  Conflict,
  Executed,
  ExecRequest,
  HostError,
  Internal,
  Invalid,
  RuntimeTraits,
  Machine,
  Missing,
  Name,
  Port,
  PublicKeys,
  Reading,
  Setup,
  Sizing,
  SshEndpoint,
  TailnetStatus,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Schema } from "effect";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

const sizes = { cpu: Size, ramMib: Size, diskGib: Size };

/** A runtime's own ID for a machine or a checkpoint, which the control plane keeps and sends back. */
export const Handle = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("Handle")
);

export type Handle = typeof Handle.Type;

const identity = {
  name: Name,
  instance: Schema.String,
  handle: Schema.optionalKey(Handle),
};

/**
 * A machine or checkpoint as a runtime knows it. `instance` tells it from an earlier one of its
 * name. `handle` is absent until a report that carries it is stored, and the host then finds it by
 * `instance`.
 */
export const Ref = Schema.Struct(identity);

export type Ref = typeof Ref.Type;

/**
 * Where a client reaches a machine's sshd: a port of its host, at the address its host answers. A
 * row from a store that kept only the port has no `host` until its host's next adopt answers it.
 */
export const Endpoint = Schema.Struct({
  host: Schema.optionalKey(Schema.String),
  port: Port,
});

export type Endpoint = typeof Endpoint.Type;

export const MachineRef = Schema.Struct({
  ...identity,
  ...sizes,
  endpoint: Schema.optionalKey(Endpoint),
});

export type MachineRef = typeof MachineRef.Type;

export const CheckpointRef = Schema.Struct({ ...identity, ...sizes });

export type CheckpointRef = typeof CheckpointRef.Type;

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

const hooked = {
  hook: Schema.optionalKey(Schema.Struct({ timeoutSeconds: Size })),
};

/**
 * What a host runs. `pin` is the runtime pin a VM booted under, compared with the host's own, and
 * `machines` the host's other machines, which admission counts beside the one a step boots. A step
 * acts on the machine or checkpoint its ref's `handle` names, or the one the runtime finds by its
 * `instance`; a remove or a delete of a checkpoint that finds none is done. A make that finds its
 * instance made answers that machine, keeps an endpoint its ref has, and gives a new one a port off
 * `taken`, every port the host's other machines hold. A step
 * that acts by what its VM is doing reads it from the runtime as it begins. A make's
 * `authorizedKeys` go to the login user once the machine is made, after its setup if it has one,
 * beside the keys already there. A make's `join` puts the machine on the tailnet as `hostname` for
 * its setup, and logs it out after, so its copies carry no node. A copy's make then prepares it, as
 * a start does. A `publish` copies a checkpoint's files to the build store under its name, and a
 * `fetch` makes a checkpoint from what was published as `from`, of template build `build`,
 * downloading only what this host doesn't hold. A delete that will `unpublish` also removes the
 * checkpoint from the build store, with every key no other published checkpoint holds. A stop, pause
 * or remove with `hook` first runs the guest's hook for it, if its VM runs and its guest has taken the
 * machine's identity, for at most `timeoutSeconds`, and goes on whatever the hook does. A start's and
 * a remove's `keep` is every checkpoint handle the rows hold for its host: a runtime that holds a
 * checkpoint through its machine deletes each of the machine's checkpoints `keep` lacks, with the
 * machine on a remove, and once it runs on a start.
 */
export const Step = Schema.Union([
  Schema.TaggedStruct("make", {
    machine: MachineRef,
    source: Source,
    authorizedKeys: Schema.optionalKey(PublicKeys),
    join: Schema.optionalKey(Schema.Struct({ hostname: Schema.String })),
    taken: Schema.Array(Port),
    ...others,
  }),
  Schema.TaggedStruct("start", {
    machine: MachineRef,
    keep: Schema.Array(Handle),
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
  Schema.TaggedStruct("remove", {
    machine: Ref,
    keep: Schema.Array(Handle),
    ...hooked,
  }),
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
    checkpoint: Ref,
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

export const Scope = Schema.Struct({
  resource: Schema.Literals(["machine", "checkpoint"]),
  name: Schema.String,
});

export type Scope = typeof Scope.Type;

/**
 * One whole step for a host to run to its end, whether or not the caller stays. `scope` is the
 * resource it changes. Delivering an `id` again returns that operation, a lower or equal `sequence`
 * in the scope is refused, and a higher one cuts short what still runs there, and forgets the one
 * before once it ended, collected or not. `boot` is the host process it was meant for: another
 * process refuses it, as the scopes it would be fenced by are gone. The host keeps no step past its
 * end, so a setup leaves its memory with the step that runs it.
 */
export const Operation = Schema.Struct({
  id: Schema.String,
  boot: Schema.String,
  scope: Scope,
  sequence: Schema.Int,
  step: Step,
});

export type Operation = typeof Operation.Type;

/**
 * What a step leaves that only its host can tell. A make answers its machine's `handle`, the
 * `endpoint` it gave it as soon as it has one, and the `sizes` the runtime gave it; a capture and a
 * fetch answer their checkpoint's `handle`.
 */
export const Outcome = Schema.Struct({
  handle: Schema.optionalKey(Handle),
  endpoint: Schema.optionalKey(SshEndpoint),
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
 * What the control plane needs to know of a host. `traits` are its runtime's, which the control
 * plane stamps on each row it makes there, `images` is the image each of `bases` names there, `boot` is new each time its process starts, and `builds` tells a host that copies template
 * builds through the build store.
 */
export const HostInfo = Schema.Struct({
  id: Schema.String,
  traits: RuntimeTraits,
  version: Schema.String,
  runtimeVersion: Schema.String,
  bases: Schema.Array(Schema.String),
  images: Schema.Record(Schema.String, Schema.String),
  boot: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  joins: Schema.Boolean,
  builds: Schema.Boolean,
}).annotate({ identifier: "HostInfo" });

export type HostInfo = typeof HostInfo.Type;

const ById = Schema.Struct({ id: Schema.String });

const Machines = Schema.Struct({ machines: Schema.Array(MachineRef) });

/** What a restarted host holds of a machine it was given: the handle it was given, or else the one the runtime finds by instance, and its endpoint. */
export const Adopted = Schema.Struct({
  ...identity,
  endpoint: Schema.optionalKey(SshEndpoint),
});

export type Adopted = typeof Adopted.Type;

/** What an adopt answers: each machine it resolved, and those whose search failed, which a later adopt tries again. */
export const Adoption = Schema.Struct({
  adopted: Schema.Array(Adopted),
  unresolved: Schema.Array(Name),
});

export type Adoption = typeof Adoption.Type;

/**
 * What a sweep may delete on a host: the instances of the machines and checkpoints the control
 * plane's store retired there, each one a make, a capture or a fetch it began on that host that ended
 * with no row keeping it. No row takes a retired instance again, so a set read at any time, by any
 * store, names nothing a row wants.
 */
export const Retired = Schema.Struct({
  machines: Schema.Array(Schema.String),
  checkpoints: Schema.Array(Schema.String),
});

export type Retired = typeof Retired.Type;

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
      input: Schema.Struct({ machines: Schema.Array(Ref) }),
      success: Schema.Array(Schema.Struct({ name: Name, state: MachineState })),
    }),
    Action.make("readSizes", {
      ...read,
      error: [Invalid, Missing, Internal] as const,
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
        "Give a host that started the machines it holds, so it reaches each again, and answer what it holds of each it could resolve.",
      input: Machines,
      success: Adoption,
    }),
    Action.make("sweepRetired", {
      ...write,
      error: [Invalid, Internal] as const,
      description:
        "Delete what carries this host's mark at its provider whose instance is retired and named by no step the host holds. A machine goes alone, and every checkpoint it holds stays, since a row may still want one. A host whose runtime marks nothing answers at once.",
      input: Retired,
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
