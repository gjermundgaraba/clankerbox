import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Duration, Schema } from "effect";

import {
  Conflict,
  Internal,
  Invalid,
  Missing,
  NotBuilt,
  NotFound,
  NotMade,
  NotOffered,
  Unavailable,
  Unsizable,
  WrongState,
} from "./errors.ts";
import { Name } from "./ids.ts";
import {
  Build,
  BuildRequest,
  CapacityReport,
  CaptureRequest,
  Checkpoint,
  CreateRequest,
  Executed,
  ExecRequest,
  ForkRequest,
  Host,
  keptBuilds,
  ListFilter,
  Machine,
  PauseRequest,
  ResizeRequest,
  RestoreRequest,
  Sizing,
  Template,
} from "./resources.ts";

/** How long the control plane waits on a host. */
export const readTimeout = Duration.seconds(10);

/** How long a client waits on the control plane, past `readTimeout`, so a silent host gets named. */
export const replyTimeout = Duration.seconds(15);

/** The longest a read of a machine may be held for it to rest. */
export const longestHold = Duration.seconds(5);

const ById = Schema.Struct({ id: Name });

const MachineRead = Schema.Struct({
  id: Name,
  holdSeconds: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1,
        maximum: Duration.toSeconds(longestHold),
      })
    )
  ),
});

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
      description: "List every machine, or those carrying every label given.",
      input: ListFilter,
      success: Schema.Array(Machine),
    }),
    Action.make("getMachine", {
      ...read,
      error: reading,
      description:
        "Read one machine. With `holdSeconds`, the read is held until the machine rests, is deleted or is made again, or that many seconds pass, and answers then.",
      input: MachineRead,
      success: Machine,
    }),
    Action.make("createMachine", {
      ...write,
      error: [...creating, NotBuilt] as const,
      description:
        "Create a machine on a host with room, and prepare it: from a template's current build, or the build it pins, cloned at the build's sizes or larger ones; or from a base, or an image reference where the host's runtime takes one, its traits' `images`. With `host`, only that host is tried, as if it were the only one, and NotOffered answers a host the control plane doesn't know. NotOffered answers a base no host offers, and Unsizable sizes that no host offering the base, or holding a current copy of the template's build, gives, each saying why it passed over each host. A create runs no setup: a template's build runs one. NotBuilt answers a template with no ready build, or none a host that could take its clone holds a current copy of, saying why it passed over each host, and to build the template again, on `host` when given, where a host lacks a copy or holds an outdated one. A create that fails deletes the VM, again at each recheck while that delete fails, and keeps the row, failed, to say why. A template's clone is prepared as part of its create, so one whose preparation fails goes the same way; a base's preparation that fails keeps the machine.",
      input: CreateRequest,
      success: Machine,
    }),
    Action.make("startMachine", {
      ...write,
      error: reading,
      description:
        "Ask for a machine to run: start it, or resume it when it is paused, and prepare it again, also when it runs already. A paused machine resumes only under the runtime pin it booted under; a start that can't resume it fails, saying why, and leaves it paused with its saved state.",
      input: ById,
      success: Machine,
    }),
    Action.make("stopMachine", {
      ...write,
      error: reading,
      description:
        "Ask for a machine to stay stopped: a power-off that keeps its disk and ends its processes. A start under way is cut short; a machine still being made is made first, and its create answers Superseded. A paused machine is resumed to end its processes where its traits' `stop` is `resumes`, and then needs room as a start does and the runtime pin it booted under, and has its saved state discarded where it is `discards`.",
      input: ById,
      success: Machine,
    }),
    Action.make("pauseMachine", {
      ...write,
      error: [
        Invalid,
        NotFound,
        NotMade,
        Conflict,
        WrongState,
        Unavailable,
        Internal,
      ] as const,
      description:
        "Ask for a machine to stay paused: the runtime saves its RAM, processes and disks and stops its VM, and a start resumes it. A machine that is stopped stays stopped, and one whose VM the runtime can't save, booted under another runtime pin or in a way its runtime can't suspend, is stopped instead; where its traits' `pause` is `stops`, every pause stops it. With `capture`, a checkpoint of that name is captured too, as captureCheckpoint would, in the state its traits' `captureFrom` names. Where that is `running`, the running machine is captured first and the pause begins once the capture has ended, however it ended, and a machine that isn't running is refused before anything is recorded. Where it is `stopped` and the traits' `pause` is `stops`, the pause comes first and the capture takes the stopped machine it leaves. Where it is `stopped` and the `pause` is `saves`, a pause leaves no machine a capture takes, so the request is refused with WrongState before anything is recorded.",
      input: PauseRequest,
      success: Machine,
    }),
    Action.make("resizeMachine", {
      ...write,
      error: [Invalid, NotFound, NotMade, Internal] as const,
      description:
        "Give a machine other vCPUs, RAM or disk. Its traits' `resize` says what a running and what a stopped machine take of vCPUs and RAM: `any`; `grow`, only larger ones, live on a running machine, needing room for its RAM as a start does; or `none`, which refuses a machine in that state, so stop a running one or start a stopped one first where the other state takes a resize. A paused machine is refused. A disk only grows, and its guest grows its filesystem into it, at once on a machine resized while it runs and at the next boot otherwise. It waits for a step under way, and the next step waits for it; a resize that fails part way keeps what the runtime gave.",
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
        "Copy a machine to a new name, with its sizes or the ones given. A machine is copied only in the state its traits' `captureFrom` names, as a capture is, and only when its VM booted under the runtime pin its host runs. Its copy's vCPUs and RAM follow its traits' `copies`: `grow` takes the source's or larger ones, grown live once the copy runs; `any` takes any; `same` takes only the source's sizes, its disk's included. A disk otherwise only grows. A copy that fails deletes the new VM and keeps its row, failed, to say why.",
      input: Schema.Struct({ ...ForkRequest.fields, ...Sizing.fields }),
      success: Machine,
    }),
    Action.make("restoreMachine", {
      ...write,
      error: making,
      description:
        "Create a machine from a checkpoint, with its sizes or the ones given. A checkpoint is restored only under the runtime pin it was captured under. A restore's vCPUs and RAM follow its runtime's traits' `copies`, as a fork's do. A disk otherwise only grows. A restore that fails deletes the new VM and keeps its row, failed, to say why.",
      input: Schema.Struct({ ...RestoreRequest.fields, ...Sizing.fields }),
      success: Machine,
    }),
    Action.make("execMachine", {
      ...write,
      error: [
        Invalid,
        NotFound,
        NotMade,
        Missing,
        WrongState,
        Unavailable,
        Internal,
      ] as const,
      description:
        "Run a command in a running machine, as the user it names or root, with the environment given, and answer its exit code and output once it exits, whatever the code. It waits for a step under way on the machine before it begins, and a stop, pause or delete ends it. It runs as long as the request does: ending the request ends the command, and so does its timeout, which answers exit code 124. Nothing of it is stored or logged.",
      input: ExecRequest,
      success: Executed,
    }),
    Action.make("listCheckpoints", {
      ...read,
      error: listing,
      description:
        "List every checkpoint, or those carrying every label given, in any phase, as getCheckpoint reads each: one capturing, ready, failed with its error, or deleting. Only a `ready` one can be restored.",
      input: ListFilter,
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
        "Capture a checkpoint of a machine. Its kind is the machine's traits' `checkpoint`, `ram` or `disk`. A machine is captured only in the state its traits' `captureFrom` names, `running` or `stopped`, and only when its VM booted under the runtime pin its host runs; otherwise the checkpoint ends `failed`, its `error` saying why. One given `expiresAt` is deleted once that time has passed.",
      input: CaptureRequest,
      success: Checkpoint,
    }),
    Action.make("deleteCheckpoint", {
      ...write,
      error: reading,
      description:
        "Delete a checkpoint, once the restores that read it are done.",
      input: ById,
    }),
    Action.make("buildTemplate", {
      ...write,
      error: [
        Invalid,
        Conflict,
        NotOffered,
        Unsizable,
        Unavailable,
        Internal,
      ] as const,
      description: `Build a template: a machine made from its base, its setup run, then copied and deleted. Each build gives the base and the sizes, which the template then shows, and a setup without a timeout takes the host's. With \`host\`, only that host is tried, as if it were the only one, and NotOffered answers a host the control plane doesn't know. NotOffered answers a base no host offers, and Unsizable sizes no host that offers it gives, each saying why it passed over each host. The template's current build moves to this one only once its setup has run, and it keeps its last ${keptBuilds} ready builds. Conflict refuses a build of a template whose build still runs.`,
      input: BuildRequest,
      success: Build,
    }),
    Action.make("listTemplates", {
      ...read,
      error: listing,
      description: "List every template, with its builds.",
      success: Schema.Array(Template),
    }),
    Action.make("getTemplate", {
      ...read,
      error: reading,
      description: "Read one template, with its builds.",
      input: ById,
      success: Template,
    }),
    Action.make("deleteTemplate", {
      ...write,
      error: [Invalid, NotFound, Conflict, Internal] as const,
      description:
        "Delete a template and its builds, once the creates that clone them are done. Conflict refuses one whose build still runs. The machines cloned from it stay.",
      input: ById,
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
