import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Schema } from "effect";

import {
  Conflict,
  Internal,
  Invalid,
  NotFound,
  NotMade,
  NotOffered,
  Unavailable,
  Unsizable,
} from "./errors.ts";
import { Name } from "./ids.ts";
import {
  Build,
  CapacityReport,
  Checkpoint,
  CreateRequest,
  Host,
  Machine,
  PrebuildRequest,
  ResizeRequest,
  Sizing,
} from "./resources.ts";

/** How long the control plane waits on a host. */
export const readTimeout = Duration.seconds(10);

/** How long a client waits on the control plane, past `readTimeout`, so a silent host gets named. */
export const replyTimeout = Duration.seconds(15);

const ById = Schema.Struct({ id: Name });

const FromMachine = Schema.Struct({ machine: Name, name: Name });

const read = { caller: Action.Anyone, readOnly: true } as const;

const write = { caller: Action.Anyone, readOnly: false } as const;

const listing = [Invalid, Internal] as const;

const reading = [Invalid, NotFound, Internal] as const;

const making = [
  Invalid,
  NotFound,
  NotMade,
  Unsizable,
  Conflict,
  Unavailable,
  Internal,
] as const;

const creating = [...making, NotOffered] as const;

export const Http = ActionHttp.make(
  [
    Action.make("listMachines", {
      ...read,
      error: listing,
      description: "List every machine.",
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
        "Create a machine from a base, or on linux from an image reference, on a host with room. It runs its setup once, or restores the setup's prebuild when a host holds one, and prepares it. A create or setup that fails deletes the VM, again at each recheck while that delete fails, and keeps the row, failed, to say why; a preparation that fails keeps the machine.",
      input: CreateRequest,
      success: Machine,
    }),
    Action.make("startMachine", {
      ...write,
      error: reading,
      description:
        "Ask for a machine to run: start it, or resume it when it is paused, and prepare it again, also when it runs already. A paused linux machine resumes only under the smolvm build that paused it, and a paused mac machine only while the Mac's session is unlocked, keeping its saved state when it can't.",
      input: ById,
      success: Machine,
    }),
    Action.make("stopMachine", {
      ...write,
      error: reading,
      description:
        "Ask for a machine to stay stopped: a power-off that keeps its disk and ends its processes. A start under way is cut short; a machine still being made is made first, and its create answers Superseded. A paused linux machine is resumed to end its processes, so it needs room as a start does and the runtime build that paused it; a paused mac machine's saved state is discarded.",
      input: ById,
      success: Machine,
    }),
    Action.make("pauseMachine", {
      ...write,
      error: reading,
      description:
        "Ask for a machine to stay paused: the runtime saves its RAM, processes and disks and stops its VM, and a start resumes it. A machine that is stopped stays stopped, and one whose VM the runtime can't save, booted under another smolvm build or by an older mac host, is stopped instead.",
      input: ById,
      success: Machine,
    }),
    Action.make("resizeMachine", {
      ...write,
      error: [Invalid, NotFound, NotMade, Internal] as const,
      description:
        "Give a machine other vCPUs, RAM or disk. A stopped machine takes any vCPUs and RAM; a running linux machine only grows, live, needing room for its RAM as a start does; a running mac machine and a paused one are refused: stop it first. A disk only grows, and its guest grows its filesystem into it, at once on a running linux machine and at the next boot otherwise. It waits for a step under way, and the next step waits for it; a resize that fails part way keeps what the runtime gave.",
      input: ResizeRequest,
      success: Machine,
    }),
    Action.make("deleteMachine", {
      ...write,
      error: reading,
      description:
        "Delete a machine and everything native it owns, whatever it is doing.",
      input: ById,
    }),
    Action.make("forkMachine", {
      ...write,
      error: making,
      description:
        "Copy a machine to a new name, with its sizes or the ones given. A linux machine is copied only when its VM booted under the smolvm build its host runs, and its copy holds the source's RAM, so its vCPUs and RAM only grow, live once it runs; a mac copy takes any. A disk only grows. A copy that fails deletes the new VM and keeps its row, failed, to say why.",
      input: Schema.Struct({ ...FromMachine.fields, ...Sizing.fields }),
      success: Machine,
    }),
    Action.make("restoreMachine", {
      ...write,
      error: making,
      description:
        "Create a machine from a checkpoint, with its sizes or the ones given. A linux checkpoint holds RAM, so a restore's vCPUs and RAM only grow, live once it runs; a mac restore takes any. A disk only grows. A restore that fails deletes the new VM and keeps its row, failed, to say why.",
      input: Schema.Struct({ checkpoint: Name, name: Name, ...Sizing.fields }),
      success: Machine,
    }),
    Action.make("listCheckpoints", {
      ...read,
      error: listing,
      description: "List every ready checkpoint.",
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
      error: [Invalid, NotFound, Conflict, NotMade, Internal] as const,
      description:
        "Capture a checkpoint of a machine. Its kind follows the machine's: ram on linux, which captures only a running machine whose VM booted under the smolvm build its host runs, and disk on mac, which captures only a stopped one.",
      input: FromMachine,
      success: Checkpoint,
    }),
    Action.make("deleteCheckpoint", {
      ...write,
      error: reading,
      description:
        "Delete a checkpoint, once the restores that read it are done.",
      input: ById,
    }),
    Action.make("prebuildCheckpoint", {
      ...write,
      error: creating,
      description:
        "Make a checkpoint from a machine built from the spec, setup and all, and delete the machine after. A checkpoint of that spec that exists is replaced once the build's setup has run.",
      input: PrebuildRequest,
      success: Build,
    }),
    Action.make("getPrebuild", {
      ...read,
      error: reading,
      description: "Read a prebuild under way, or how it ended.",
      input: ById,
      success: Build,
    }),
    Action.make("listHosts", {
      ...read,
      error: listing,
      description: "List the hosts, for an operator: what each reports.",
      success: Schema.Array(Host),
    }),
    Action.make("getCapacity", {
      ...read,
      error: listing,
      description:
        "Read each host's resources, how much of each is in use, and their limits, for an operator. A machine whose state can't be read leaves the rows that count it unread; a host that can't be read is named.",
      success: CapacityReport,
    }),
  ],
  { prefix: "/api" }
);

export const actionsByName = Action.byName(Http.actions);

/** What the control plane may answer action `N` with: the errors the contract declares for it. */
export type Declared<N extends keyof typeof actionsByName> =
  (typeof actionsByName)[N]["error"][number]["Type"];
