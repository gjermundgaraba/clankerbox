import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Schema } from "effect";
import { Capacity, Conflict, Internal, Invalid, NotFound, Precondition } from "./errors.ts";
import { Id, Name } from "./ids.ts";
import { Checkpoint, CreateRequest, Host, Machine, Usage } from "./resources.ts";

/** A host bounds its own reads of runtime state under it, so a list answers in time. */
export const readTimeout = Duration.seconds(10);

const ById = Schema.Struct({ id: Id });

const FromMachine = Schema.Struct({ machine: Id, name: Name });

/** Every action is public, as a host listens only on the tailnet or loopback. */
const read = { caller: Action.Anyone, readOnly: true } as const;

const write = { caller: Action.Anyone, readOnly: false } as const;

/** What each action fails with; each has `Invalid`, which the host's version check answers. */
const listing = [Invalid, Internal] as const;

const reading = [Invalid, NotFound, Internal] as const;

const changing = [Invalid, NotFound, Conflict, Precondition, Internal] as const;

const takingRoom = [...changing, Capacity] as const;

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
      error: takingRoom,
      description: "Create a machine from a base, run its setup once, and prepare it.",
      input: CreateRequest,
      success: Machine,
    }),
    Action.make("startMachine", {
      ...write,
      error: takingRoom,
      description: "Start a machine. On a running machine, run preparation again.",
      input: ById,
      success: Machine,
    }),
    Action.make("stopMachine", {
      ...write,
      error: changing,
      description:
        "Stop a machine: a power-off that keeps its disk and ends its processes. A stopped machine stays stopped, and the stop is still its last action.",
      input: ById,
      success: Machine,
    }),
    Action.make("deleteMachine", {
      ...write,
      error: changing,
      description: "Delete a machine and everything native it owns.",
      input: ById,
    }),
    Action.make("forkMachine", {
      ...write,
      error: takingRoom,
      description: "Copy a machine to a new name on the same host.",
      input: FromMachine,
      success: Machine,
    }),
    Action.make("restoreMachine", {
      ...write,
      error: takingRoom,
      description: "Create a machine on the checkpoint's host from that checkpoint.",
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
      error: takingRoom,
      description:
        "Capture a checkpoint of a machine. Its kind follows the runtime: ram on smolvm, which captures only a running machine, and disk on Tart and boat.",
      input: FromMachine,
      success: Checkpoint,
    }),
    Action.make("deleteCheckpoint", {
      ...write,
      error: changing,
      description: "Delete a checkpoint.",
      input: ById,
    }),
    Action.make("getHost", {
      ...read,
      error: [Invalid] as const,
      description: "Read the host: its runtime, versions and bases.",
      success: Host,
    }),
    Action.make("getCapacity", {
      ...read,
      error: [Invalid, Precondition, Internal] as const,
      description:
        "Read the host's resources, how much of each is in use, and their limits. A machine whose state can't be read leaves the rows that count it unread; it fails when the runtime can't be read at all.",
      success: Schema.Array(Usage),
    }),
  ],
  { prefix: "/api" },
);

export const actionsByName = Action.byName(Http.actions);
