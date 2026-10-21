import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Schema } from "effect";
import {
  Capacity,
  Conflict,
  Internal,
  Invalid,
  Missing,
  NotFound,
  NotMade,
  NotOffered,
  PinMismatch,
  ScriptFailed,
  Superseded,
  Unsizable,
  WrongState,
} from "./errors.ts";
import { Id, Name } from "./ids.ts";
import {
  Checkpoint,
  CreateRequest,
  Host,
  Machine,
  PrebuildRequest,
  Prebuilt,
  Usage,
} from "./resources.ts";

/** A host bounds its own reads of runtime state under it, so a list answers in time. */
export const readTimeout = Duration.seconds(10);

const ById = Schema.Struct({ id: Id });

const FromMachine = Schema.Struct({ machine: Id, name: Name });

const read = { caller: Action.Anyone, readOnly: true } as const;

const write = { caller: Action.Anyone, readOnly: false } as const;

const listing = [Invalid, Internal] as const;

const reading = [Invalid, NotFound, Internal] as const;

const converging = [
  Invalid,
  NotFound,
  NotMade,
  Missing,
  WrongState,
  PinMismatch,
  Unsizable,
  ScriptFailed,
  Capacity,
  Superseded,
  Internal,
] as const;

const making = [...converging, Conflict] as const;

const creating = [...making, NotOffered] as const;

export const Http = ActionHttp.make(
  [
    Action.make("listMachines", {
      ...read,
      error: listing,
      description: "List the host's machines.",
      success: Schema.Array(Machine),
    }),
    Action.make("getMachine", {
      ...read,
      error: reading,
      description: "Read one machine.",
      input: ById,
      success: Machine,
    }),
    Action.make("createMachine", {
      ...write,
      error: creating,
      description:
        "Create a machine from a base, run its setup once, and prepare it. A create or setup that fails deletes the machine, again at each recheck while that delete fails, and the error is the answer; a preparation that fails keeps it.",
      input: CreateRequest,
      success: Machine,
    }),
    Action.make("startMachine", {
      ...write,
      error: converging,
      description:
        "Ask for a machine to run, and wait until it does: start it and prepare it again, also when it runs already.",
      input: ById,
      success: Machine,
    }),
    Action.make("stopMachine", {
      ...write,
      error: converging,
      description:
        "Ask for a machine to stay stopped, and wait until it is: a power-off that keeps its disk and ends its processes. A start under way is cut short; a machine still being made is made first, and its create answers Superseded.",
      input: ById,
      success: Machine,
    }),
    Action.make("deleteMachine", {
      ...write,
      error: converging,
      description: "Delete a machine and everything native it owns, whatever it is doing.",
      input: ById,
    }),
    Action.make("forkMachine", {
      ...write,
      error: making,
      description:
        "Copy a machine to a new name on the same host. A copy that fails deletes the new machine.",
      input: FromMachine,
      success: Machine,
    }),
    Action.make("restoreMachine", {
      ...write,
      error: making,
      description:
        "Create a machine on the checkpoint's host from that checkpoint. A restore that fails deletes the new machine.",
      input: Schema.Struct({ checkpoint: Id, name: Name }),
      success: Machine,
    }),
    Action.make("listCheckpoints", {
      ...read,
      error: listing,
      description: "List the host's checkpoints.",
      success: Schema.Array(Checkpoint),
    }),
    Action.make("getCheckpoint", {
      ...read,
      error: reading,
      description: "Read one checkpoint.",
      input: ById,
      success: Checkpoint,
    }),
    Action.make("captureCheckpoint", {
      ...write,
      error: [
        Invalid,
        NotFound,
        Conflict,
        NotMade,
        Missing,
        WrongState,
        Capacity,
        Internal,
      ] as const,
      description:
        "Capture a checkpoint of a machine. Its kind follows the host's: ram on linux, which captures only a running machine, and disk on mac, which captures only a stopped one.",
      input: FromMachine,
      success: Checkpoint,
    }),
    Action.make("deleteCheckpoint", {
      ...write,
      error: reading,
      description: "Delete a checkpoint, once the restores that read it are done.",
      input: ById,
    }),
    Action.make("prebuildCheckpoint", {
      ...write,
      error: creating,
      description:
        "Make checkpoint id from a machine the host builds from the spec, setup and all, and deletes after. A checkpoint id that exists is the answer, and two prebuilds of one id share one build.",
      input: PrebuildRequest,
      success: Prebuilt,
    }),
    Action.make("getHost", {
      ...read,
      error: [Invalid] as const,
      description: "Read the host: its kind, versions and bases.",
      success: Host,
    }),
    Action.make("getCapacity", {
      ...read,
      error: listing,
      description:
        "Read the host's resources, how much of each is in use, and their limits. A machine whose state can't be read leaves the rows that count it unread; it fails when the runtime can't be read at all.",
      success: Schema.Array(Usage),
    }),
  ],
  { prefix: "/api" },
);

export const actionsByName = Action.byName(Http.actions);

/** What a host may answer action `N` with: the errors the contract declares for it. */
export type Declared<N extends keyof typeof actionsByName> =
  (typeof actionsByName)[N]["error"][number]["Type"];
