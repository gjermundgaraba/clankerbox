import {
  Conflict,
  HostError,
  Internal,
  Invalid,
  Kind,
  Machine,
  Name,
  Reading,
  Setup,
  Sizing,
  TailnetStatus,
} from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Schema } from "effect";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);

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

/** What a delete needs of a machine, which may never have got a port. */
export const Native = Schema.Struct({
  name: Name,
  instance: Schema.String,
});

export type Native = typeof Native.Type;

export const CheckpointRef = Schema.Struct({
  name: Name,
  instance: Schema.String,
  ...sizes,
  port: Port,
});

export type CheckpointRef = typeof CheckpointRef.Type;

export const MachineState = Machine.fields.state;

export type MachineState = typeof MachineState.Type;

const pinned = { pin: Schema.optionalKey(Schema.String) };

export const Source = Schema.Union([
  Schema.TaggedStruct("base", { base: Schema.String }),
  Schema.TaggedStruct("checkpoint", { checkpoint: CheckpointRef, ...pinned }),
  Schema.TaggedStruct("machine", { machine: MachineRef, ...pinned }),
]);

export type Source = typeof Source.Type;

const others = { machines: Schema.Array(MachineRef) };

/**
 * What a host runs. `pin` is the runtime pin a VM booted under, compared with the host's own, and
 * `machines` the host's other machines, which admission counts beside the one a step boots.
 */
export const Step = Schema.Union([
  Schema.TaggedStruct("make", {
    machine: NewMachine,
    source: Source,
    setup: Schema.optionalKey(Setup),
    ports: Schema.Array(Port),
    ...others,
  }),
  Schema.TaggedStruct("start", {
    machine: MachineRef,
    seen: MachineState,
    ...pinned,
    ...others,
  }),
  Schema.TaggedStruct("stop", {
    machine: MachineRef,
    seen: MachineState,
    ...pinned,
    ...others,
  }),
  Schema.TaggedStruct("pause", { machine: MachineRef, ...pinned }),
  Schema.TaggedStruct("remove", { machine: Native }),
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
  Schema.TaggedStruct("deleteCheckpoint", { checkpoint: CheckpointRef }),
  Schema.TaggedStruct("join", {
    machine: MachineRef,
    hostname: Schema.String,
  }),
]);

export type Step = typeof Step.Type;

/**
 * One whole step for a host to run to its end, whether or not the caller stays. `scope` names the
 * resource it changes. Delivering an `id` again returns that operation, a lower or equal `sequence`
 * in the scope is refused, and a higher one cuts short what still runs there. `boot` is the host
 * process it was meant for: another process refuses it, as the scopes it would be fenced by are gone.
 */
export const Operation = Schema.Struct({
  id: Schema.String,
  boot: Schema.String,
  scope: Schema.String,
  sequence: Schema.Int,
  step: Step,
});

export type Operation = typeof Operation.Type;

/** What a step leaves that only the host can tell. */
export const Outcome = Schema.Struct({
  port: Schema.optionalKey(Port),
  hostKey: Schema.optionalKey(Schema.String),
  sizes: Schema.optionalKey(Schema.Struct(sizes)),
  tailnet: Schema.optionalKey(TailnetStatus),
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

/** What the control plane needs to know of a host. `boot` is new each time its process starts. */
export const HostInfo = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  version: Schema.String,
  runtimeVersion: Schema.String,
  bases: Schema.Array(Schema.String),
  boot: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  publishAddress: Schema.String,
  joins: Schema.Boolean,
}).annotate({ identifier: "HostInfo" });

export type HostInfo = typeof HostInfo.Type;

const ById = Schema.Struct({ id: Schema.String });

const Machines = Schema.Struct({ machines: Schema.Array(MachineRef) });

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
    Action.make("listOperations", {
      ...read,
      error: [Invalid] as const,
      description: "Report every operation this process holds.",
      success: Schema.Array(Report),
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
  ],
  { prefix: "/host" }
);

export const hostActionsByName = Action.byName(HostHttp.actions);

export type HostAction = keyof typeof hostActionsByName;
