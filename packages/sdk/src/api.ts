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
  ExecRequest,
  Executed,
  Host,
  Machine,
  PrebuildRequest,
  Prebuilt,
  ResizeRequest,
  Sizing,
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
        "Create a machine from a base, or on linux from an image reference, run its setup once, and prepare it. A create or setup that fails deletes the machine, again at each recheck while that delete fails, and the error is the answer; a preparation that fails keeps it.",
      input: CreateRequest,
      success: Machine,
    }),
    Action.make("startMachine", {
      ...write,
      error: converging,
      description:
        "Ask for a machine to run, and wait until it does: start it, or resume it when it is paused, and prepare it again, also when it runs already. A paused linux machine resumes only under the smolvm build that paused it, and a paused mac machine only while the Mac's session is unlocked, keeping its saved state when it can't.",
      input: ById,
      success: Machine,
    }),
    Action.make("stopMachine", {
      ...write,
      error: converging,
      description:
        "Ask for a machine to stay stopped, and wait until it is: a power-off that keeps its disk and ends its processes. A start under way is cut short; a machine still being made is made first, and its create answers Superseded. A paused linux machine is resumed to end its processes, so it needs room as a start does and the runtime build that paused it; a paused mac machine's saved state is discarded.",
      input: ById,
      success: Machine,
    }),
    Action.make("pauseMachine", {
      ...write,
      error: converging,
      description:
        "Ask for a machine to stay paused, and wait until it is: the runtime saves its RAM, processes and disks and stops its VM, and a start resumes it. A machine that is stopped stays stopped, and one whose VM the runtime can't save, booted under another smolvm build or by an older mac host, is stopped instead.",
      input: ById,
      success: Machine,
    }),
    Action.make("resizeMachine", {
      ...write,
      error: [
        Invalid,
        NotFound,
        NotMade,
        Missing,
        WrongState,
        Unsizable,
        Capacity,
        Internal,
      ] as const,
      description:
        "Give a machine other vCPUs, RAM or disk, and answer it with the sizes the runtime then holds. A stopped machine takes any vCPUs and RAM; a running linux machine only grows, live, needing room for its RAM as a start does; a running mac machine and a paused one are refused: stop it first. A disk only grows, and its guest grows its filesystem into it, at once on a running linux machine and at the next boot otherwise. It waits for a step under way, and the next request waits for it; a resize that fails part way keeps what the runtime gave.",
      input: ResizeRequest,
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
        "Copy a machine to a new name on the same host, with its sizes or the ones given. A linux machine is copied only when its VM booted under the smolvm build the host runs, and its copy holds the source's RAM, so its vCPUs and RAM only grow, live once it runs; a mac copy takes any. A disk only grows. A copy that fails deletes the new machine.",
      input: Schema.Struct({ ...FromMachine.fields, ...Sizing.fields }),
      success: Machine,
    }),
    Action.make("restoreMachine", {
      ...write,
      error: making,
      description:
        "Create a machine on the checkpoint's host from that checkpoint, with its sizes or the ones given. A linux checkpoint holds RAM, so a restore's vCPUs and RAM only grow, live once it runs; a mac restore takes any. A disk only grows. A restore that fails deletes the new machine.",
      input: Schema.Struct({ checkpoint: Id, name: Name, ...Sizing.fields }),
      success: Machine,
    }),
    Action.make("execMachine", {
      ...write,
      error: [Invalid, NotFound, NotMade, Missing, WrongState, Internal] as const,
      description:
        "Run a command in a running machine, as the user it names or root, with the image's environment on linux, and answer its exit code and output once it exits, whatever the code. It waits for a start or stop under way before it begins, and a stop or delete ends it, as does a pause on linux. It runs as long as the request does: ending the request ends the command, though on mac one that writes nothing runs on until it next writes.",
      input: ExecRequest,
      success: Executed,
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
        PinMismatch,
        Capacity,
        Internal,
      ] as const,
      description:
        "Capture a checkpoint of a machine. Its kind follows the host's: ram on linux, which captures only a running machine whose VM booted under the smolvm build the host runs, and disk on mac, which captures only a stopped one.",
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
