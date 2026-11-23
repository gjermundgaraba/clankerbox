import {
  Effect,
  Predicate,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from "effect";

import { Desired, HostError } from "./errors.ts";
import {
  CheckpointName,
  HostId,
  MachineName,
  Name,
  RuntimeName,
} from "./ids.ts";
import { Size, Sizes } from "./sizes.ts";

/**
 * The user a machine with an SSH login is logged in as: the user a host's preparation creates, or a
 * base ships, for whom the host installs the operator's keys; never root.
 */
export const loginUser = "admin";

export const maxLabels = 16;

const maxLabelLength = 63;

const recordKeyedBy = <V extends Schema.Top>(
  key: Schema.Codec<string>,
  keyIs: string,
  value: V
) => {
  const refusal = Schema.decodeUnknownResult(key);

  return Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record: Readonly<Record<string, V["Type"]>>) => {
      for (const name of Object.keys(record)) {
        const refused = refusal(name);

        if (Result.isFailure(refused)) {
          return `${JSON.stringify(name)} isn't a ${keyIs}: ${refused.failure.message}`;
        }
      }

      return true;
    })
  );
};

/**
 * What a caller tags a machine or checkpoint with, to find it again: at most `maxLabels` pairs,
 * each key a name and each value at most 63 characters. Set when the resource is made, and never
 * changed after.
 */
export const Labels = recordKeyedBy(
  Name,
  "label key",
  Schema.String.check(Schema.isMaxLength(maxLabelLength))
).check(
  Schema.makeFilter(
    (labels: Readonly<Record<string, string>>) =>
      Object.keys(labels).length <= maxLabels || `at most ${maxLabels} labels`
  )
);

export type Labels = typeof Labels.Type;

const labelled = { labels: Schema.optionalKey(Labels) };

const expiring = {
  expiresAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
};

/** `labels` that each resource listed must carry, with those values. */
export const ListFilter = Schema.Struct(labelled);

export type ListFilter = typeof ListFilter.Type;

export const labelledWith = (
  labels: Labels | undefined,
  wanted: Labels | undefined
): boolean =>
  wanted === undefined ||
  Object.entries(wanted).every(([key, value]) => labels?.[key] === value);

/**
 * What the control plane is doing about a machine. A client waits for a rest:
 * `settled`, at rest with what was asked; `failed`, after a step failed, or after its runtime
 * stopped a machine asked to run (`Machine.unasked`), until the next request, as nothing is retried.
 * A machine `failed` so, as a routine idle stop on boat or smol cloud leaves it, is intact, its
 * disk kept, and waits to be started: answer it with a start, never a delete and a create again,
 * which loses its disk;
 * and `lost`, one the runtime no longer has, which can only be deleted. `waiting` is no rest: the
 * control plane can't read the machine's host, so it tells nothing of a request, which stays saved
 * and acts when it can, and a wait reads on through it as through an outage. `creating` makes or
 * copies the machine, and a machine whose create fails is deleted, its row kept `failed` to say
 * why. `starting` starts the machine, also when it runs already, and prepares it.
 */
export const Phase = Schema.Literals([
  "observing",
  "waiting",
  "creating",
  "starting",
  "stopping",
  "resizing",
  "deleting",
  "settled",
  "failed",
  "lost",
]);

export type Phase = typeof Phase.Type;

/** Where a client's wait ends. */
export const isResting = (phase: Phase): boolean =>
  phase === "settled" || phase === "failed" || phase === "lost";

export const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);

export const SshEndpoint = Schema.Struct({
  host: Schema.String,
  port: Port,
});

export type SshEndpoint = typeof SshEndpoint.Type;

export const SshLogin = Schema.Struct({
  user: Schema.String,
  ...SshEndpoint.fields,
});

export type SshLogin = typeof SshLogin.Type;

/**
 * A running machine's place on the tailnet, as its host checked it: `joined` once `tailscaled` runs
 * signed in, with the MagicDNS name Tailscale gave it, if any; `failed` with why; or `missing` when
 * the guest has no `tailscaled`.
 */
export const TailnetStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("joined"),
    name: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ state: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ state: Schema.Literal("missing") }),
]).annotate({ identifier: "TailnetStatus" });

export type TailnetStatus = typeof TailnetStatus.Type;

/**
 * The place on the tailnet of a machine that requests one: its `TailnetStatus` as its host last
 * checked it while it runs, or `pending` while it doesn't, or hasn't been checked since it last
 * started. Kept in the control plane's memory only: each start checks again, a joined machine is
 * checked again every half hour or so, and a failed one sooner, waiting longer after each failure.
 */
export const MachineTailnet = Schema.Union([
  ...TailnetStatus.members,
  Schema.Struct({ state: Schema.Literal("pending") }),
]).annotate({ identifier: "MachineTailnet" });

export type MachineTailnet = typeof MachineTailnet.Type;

const buildNumber = /^[1-9][0-9]*$/u;

const isName = Schema.is(Name);

/** One build of a template: its name, `@` and its number, such as `web@4`, the template's fourth. */
export const BuildId = Schema.String.check(
  Schema.makeFilter((id: string) => {
    const at = id.lastIndexOf("@");

    return (
      (at > 0 &&
        isName(id.slice(0, at)) &&
        buildNumber.test(id.slice(at + 1))) ||
      "a build ID is its template's name, @ and the build's number, such as web@4"
    );
  })
);

/** A template, which names its current build, or one build of it, by ID. */
export const TemplateRef = Schema.Union([Name, BuildId]);

export const buildId = (template: string, number: number): string =>
  `${template}@${number}`;

/** The template a `TemplateRef` names, and the number of the build it pins, if it pins one. */
export const templateRef = (
  ref: string
): { readonly template: string; readonly number: number | undefined } => {
  const at = ref.lastIndexOf("@");

  return at === -1
    ? { template: ref, number: undefined }
    : { template: ref.slice(0, at), number: Number(ref.slice(at + 1)) };
};

/**
 * A change to a machine that no request asked for, as a read of its runtime found it. A stop is
 * asked for, so it is never one.
 * - `stopped`: a machine asked to run that its runtime stopped, its memory and processes gone. The
 *   control plane doesn't start it again: it rests `failed`, its `error` a `WrongState` saying so,
 *   until a request asks it to run, and a start boots it cold.
 * - `started`: one asked to stay stopped that runs, which the control plane stops again.
 * - `rebooted`: one its runtime reports booted again in place while it ran.
 * - `lost`: one its runtime no longer has, which can only be deleted.
 *
 * A disk its runtime put back to older files, or a `/workspace` it emptied, as smol cloud may to a
 * machine that loses its node, is none of these, and nothing detects it: a machine the loss left
 * stopped where it ran records `stopped` alone, and one that comes back running records nothing at
 * all.
 *
 * `at` is the read that found it, so the change came at or before it. `why` is the cause, on a
 * `stopped` or `lost` machine, in its runtime's own words where it names one, such as an idle stop
 * or an out-of-memory kill, and without it the runtime didn't say.
 */
export const Unasked = Schema.Struct({
  what: Schema.Literals(["stopped", "started", "rebooted", "lost"]),
  at: Schema.DateTimeUtcFromString,
  why: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Unasked" });

export type Unasked = typeof Unasked.Type;

/**
 * `state` is what the runtime reports: `missing` when it doesn't have the machine, and `unknown` when it couldn't be read. `desired` is
 * what the last request asked for, `phase` what the control plane is doing about it, and `error`
 * why the last step failed, until the next request. A request takes the row out of rest in the
 * write that records it, so a resting `phase` read after a request has seen it. `template` is the
 * build a create cloned. `runtime` names the runtime it was made on. `hostKey`,
 * `<type> <base64>`, is on a machine once preparation has read one from its sshd, which a machine
 * made from a base its host doesn't prepare may lack. `ssh` is the login sshd answers: it is only
 * on a machine with a `hostKey` and an endpoint, while it runs, or while its host can't be read
 * (`state` `unknown`) and it was last read running and is asked to run still. `tailnet` is on a
 * machine that requests the tailnet, as a create from a base asks, its template's build asked, or
 * the source of its fork or restore asked. `boots` counts the cold boots the machine ran in that the
 * control plane knows of: its first, each start that booted it from stopped, each reboot in place
 * its runtime reported, and each read that found it running while asked to stay stopped. While it
 * holds, its memory and processes are those of one boot, but for a stop and start its runtime made
 * by itself between two reads, which only a runtime that reports its reboots shows. A reboot in
 * place between a start's boot and the next read isn't counted either, as that read takes the
 * runtime's reboot mark afresh. A runtime that reports reboots reports
 * a machine that never rebooted in place as such, so its first reboot counts as each later one does.
 * A boot a host makes inside another step
 * that leaves the machine stopped, as a fork may, counts none, as nothing ran in it for the
 * machine's owner. A copy counts its own from its first.
 * `unasked` is the last change no request asked for, kept until another replaces it.
 */
export const Machine = Schema.Struct({
  id: Name,
  runtime: RuntimeName,
  createdAt: Schema.DateTimeUtcFromString,
  base: Schema.String,
  template: Schema.optionalKey(BuildId),
  ...labelled,
  ...Sizes.fields,
  state: Schema.Literals(["running", "stopped", "missing", "unknown"]),
  desired: Desired,
  phase: Phase,
  error: Schema.optionalKey(HostError),
  boots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unasked: Schema.optionalKey(Unasked),
  ssh: Schema.optionalKey(SshLogin),
  hostKey: Schema.optionalKey(Schema.String),
  tailnet: Schema.optionalKey(MachineTailnet),
}).annotate({ identifier: "Machine" });

export type Machine = typeof Machine.Type;

/** A create that failed and was undone: its row stays until a delete, or a create of its name replaces it. */
export const isUndone = ({
  phase,
  state,
  desired,
}: Pick<Machine, "phase" | "state" | "desired">): boolean =>
  phase === "failed" && state === "missing" && desired !== "deleted";

/**
 * The state as people read it: `running` at rest, `running (failed)` where it is but not at rest,
 * and `stopped, wants running (starting)` on the way.
 */
export const stateLabel = ({ state, desired, phase }: Machine): string => {
  if (phase === "settled") {
    return state;
  }

  return state === desired
    ? `${state} (${phase})`
    : `${state}, wants ${desired} (${phase})`;
};

/**
 * A copy of a machine's disk, as a fork takes one. A client waits on `phase`: a checkpoint is
 * usable only `ready`, and never changes after. A capture that failed stays `failed` to say why, holding no copy. One
 * with `expiresAt` is deleted by the control plane once that time has passed.
 */
export const Checkpoint = Schema.Struct({
  id: Name,
  createdAt: Schema.DateTimeUtcFromString,
  machine: Name,
  phase: Schema.Literals(["capturing", "ready", "deleting", "failed"]),
  error: Schema.optionalKey(HostError),
  base: Schema.String,
  ...labelled,
  ...expiring,
  ...Sizes.fields,
}).annotate({ identifier: "Checkpoint" });

export type Checkpoint = typeof Checkpoint.Type;

const BuildPhase = Schema.Literals(["building", "ready", "failed"]);

/**
 * A build's copy on one host. A host of the build's runtime that copies builds fetches each ready
 * build: the copy is `fetching` until it holds it, then `ready` for a create, or `failed` with its
 * error, which the next recheck fetches again. It is `outdated`, and takes no create, while its host
 * runs another runtime pin or names another image for the base than the build was made under, as
 * `reason` says. It is `excluded`, and takes no create, while its host joins no machine to the
 * tailnet and the build requests it, as `reason` says.
 */
export const BuildCopy = Schema.Struct({
  host: Schema.String,
  phase: Schema.Literals([
    "fetching",
    "ready",
    "failed",
    "outdated",
    "excluded",
  ]),
  reason: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(HostError),
}).annotate({ identifier: "BuildCopy" });

export type BuildCopy = typeof BuildCopy.Type;

/**
 * One build of a template: a machine made from `base` on `host` at the sizes given, its setup run
 * within `setupTimeoutSeconds`, on the tailnet with `tailnet`, captured under the runtime `pin`, and
 * deleted. `image` is what the base named on that host. With `tailnet`, each machine cloned from it
 * joins the tailnet too. A create clones a build only `ready`, at its sizes, or at larger ones
 * where its host's runtime gives a copy other sizes than its source's, and a ready build never
 * changes. A failed one, also one a restart of the control plane ended, keeps
 * its `error` until a later build ends. `copies` are where it is, by
 * host: a create clones it on a host whose copy is ready.
 */
export const Build = Schema.Struct({
  id: BuildId,
  createdAt: Schema.DateTimeUtcFromString,
  phase: BuildPhase,
  error: Schema.optionalKey(HostError),
  host: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  image: Schema.String,
  base: Schema.String,
  ...Sizes.fields,
  setupTimeoutSeconds: Schema.optionalKey(Size),
  tailnet: Schema.optionalKey(Schema.Literal(true)),
  copies: Schema.Array(BuildCopy),
}).annotate({ identifier: "Build" });

export type Build = typeof Build.Type;

/** How many ready builds a template keeps: one more deletes the oldest. */
export const keptBuilds = 2;

/**
 * A setup the control plane builds, each time from the base and sizes its build asks, and that a
 * create clones with no setup run. Each build is sent its own setup, which is never kept. `current`
 * is the newest ready build, which a create clones unless it pins another. `state` is `building`
 * while a build runs, else `ready` while the current build has a copy ready or being fetched, and
 * `failed` while no build is ready or none of the current one's copies is, as when the hosts lost
 * them, until a build ends ready.
 */
export const Template = Schema.Struct({
  id: Name,
  createdAt: Schema.DateTimeUtcFromString,
  current: Schema.optionalKey(BuildId),
  state: BuildPhase,
  builds: Schema.Array(Build),
}).annotate({ identifier: "Template" });

export type Template = typeof Template.Type;

/** A template's `current` build and its `state`, as its builds, oldest first, tell them. */
export const builtFrom = (
  builds: ReadonlyArray<Pick<Build, "id" | "phase" | "copies">>
): Pick<Template, "current" | "state"> => {
  const built = builds.findLast(({ phase }) => phase === "ready");
  const current = built?.id;

  if (builds.some(({ phase }) => phase === "building")) {
    return current === undefined
      ? { state: "building" }
      : { current, state: "building" };
  }

  if (built === undefined) {
    return { state: "failed" };
  }

  return {
    current: built.id,
    state: built.copies.some(
      ({ phase }) => phase === "ready" || phase === "fetching"
    )
      ? "ready"
      : "failed",
  };
};

/**
 * An operator's view of a host: `up` with what it reported, `draining` when placement passes it
 * over, `unreachable` with why, or `incompatible`, one that answers but of another release or in
 * another contract, with why, which the control plane uses for nothing. `runtime` names what it
 * drives, and `runtimeVersion` is that runtime's own version.
 */
export const Host = Schema.Struct({
  id: HostId,
  state: Schema.Literals(["up", "draining", "unreachable", "incompatible"]),
  runtime: Schema.optionalKey(RuntimeName),
  version: Schema.optionalKey(Schema.String),
  runtimeVersion: Schema.optionalKey(Schema.String),
  bases: Schema.Array(Schema.String),
  problem: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Host" });

export type Host = typeof Host.Type;

/** A resource a host counts, named by its runtime, such as `cpu`, `ramMib` or `runningVms`. */
export const ResourceName = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9]{0,31}$/u)
);

const usageFields = {
  host: HostId,
  resource: ResourceName,
  limit: Schema.optionalKey(Schema.Int),
};

/**
 * A resource of a host and how much of it is in use, counted as a refusal counts it, so it
 * needn't match the host's own machines. When a machine the sum counts couldn't be read, the
 * sum would be a guess, so the row names those machines instead.
 *
 * `cpu` and `ramMib` are what the host's running machines were given; a runtime may count more,
 * such as `runningVms`, Apple's two VMs per Mac.
 * `limit` is there only where the host refuses an action that would pass it.
 */
export const Usage = Schema.Union([
  Schema.Struct({ ...usageFields, used: Schema.Int }),
  Schema.Struct({ ...usageFields, unread: Schema.Array(Name) }),
]).annotate({ identifier: "Usage" });

export type Usage = typeof Usage.Type;

/** A host that reported no usage: `unreachable` when it didn't answer, or `incompatible`, and why. */
export const Unreported = Schema.Struct({
  host: HostId,
  state: Schema.Literals(["unreachable", "incompatible"]),
  problem: Schema.String,
}).annotate({ identifier: "Unreported" });

export type Unreported = typeof Unreported.Type;

export const CapacityReport = Schema.Struct({
  usage: Schema.Array(Usage),
  unreported: Schema.Array(Unreported),
}).annotate({ identifier: "CapacityReport" });

export type CapacityReport = typeof CapacityReport.Type;

const { host: _host, ...readingFields } = usageFields;

export const Reading = Schema.Union([
  Schema.Struct({ ...readingFields, used: Schema.Int }),
  Schema.Struct({ ...readingFields, unread: Schema.Array(Name) }),
]);

export type Reading = typeof Reading.Type;

const publicKeyLine =
  /^(?:ssh|ecdsa|sk)-[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}(?: .*)?$/u;

const blankLine = /^\s*$/u;

/**
 * Public keys, as `.pub` files hold them: each line that isn't blank is `<type> <base64>
 * [comment]`, the type an OpenSSH key's, its certificate's or a hardware key's, and at least one
 * line is. Anything else, a private key included, is refused.
 */
export const PublicKeys = Schema.String.check(
  Schema.makeFilter((text: string) => {
    const lines = text.split("\n").filter((line) => !blankLine.test(line));

    return (
      (lines.length > 0 && lines.every((line) => publicKeyLine.test(line))) ||
      "each line that isn't blank is a public key, <type> <base64> [comment], as a .pub file holds it"
    );
  })
);

/** Nothing logs the script: it can carry secrets. */
export const Setup = Schema.Struct({
  script: Schema.String,
  timeoutSeconds: Schema.optionalKey(Size),
});

export type Setup = typeof Setup.Type;

/** Sizes to give a machine, each optional: one left out stays as it is, or as its source's. */
export const Sizing = Schema.Struct({
  cpu: Schema.optional(Size),
  ramMib: Schema.optional(Size),
  diskGib: Schema.optional(Size),
});

export type Sizing = typeof Sizing.Type;

export const sizedBy = (from: Sizes, sizing: Sizing | undefined): Sizes => ({
  cpu: sizing?.cpu ?? from.cpu,
  ramMib: sizing?.ramMib ?? from.ramMib,
  diskGib: sizing?.diskGib ?? from.diskGib,
});

const placed = { host: Schema.optionalKey(HostId) };

const fromTemplate = { template: TemplateRef, ...Sizing.fields, ...placed };

const fromBase = {
  base: Schema.String,
  runtime: RuntimeName,
  ...Sizes.fields,
  ...placed,
  tailnet: Schema.optionalKey(Schema.Literal(true)),
};

/**
 * A template's build, at its sizes or the larger ones given, with no setup run. Its clone runs on
 * the build's runtime, as only hosts of that runtime hold a copy of the build.
 */
export const TemplateSpec = Schema.Struct(fromTemplate);

/**
 * A base on `runtime`, at the sizes given, with no setup run: only a template's build runs one.
 * Only a host of that runtime takes it, a host a full one moves it on to included. With `tailnet`,
 * the machine joins the control plane's tailnet, and only a host that joins machines to it takes
 * it.
 */
export const BaseSpec = Schema.Struct(fromBase);

/**
 * What a machine is made from. A spec that names a template is read as one, whatever else it
 * holds.
 */
export const MachineSpec = Schema.Union([TemplateSpec, BaseSpec]);

export type MachineSpec = typeof MachineSpec.Type;

const TemplateCreate = Schema.Struct({
  id: MachineName,
  ...fromTemplate,
  ...labelled,
});

const BaseCreate = Schema.Struct({
  id: MachineName,
  ...fromBase,
  ...labelled,
});

type Create = typeof TemplateCreate.Type | typeof BaseCreate.Type;

const unnamed = "a create names a template or a base";

const isCreate = (input: unknown): input is Create => Predicate.isObject(input);

/**
 * A create from a template or from a base, read as the one it names: a template whatever else it
 * holds, else a base. A refusal is that one's alone.
 */
export const CreateRequest = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.declare(isCreate),
    SchemaTransformation.transformEffect({
      decode: (request, options): Effect.Effect<Create, SchemaIssue.Issue> => {
        if ("template" in request) {
          return SchemaParser.decodeUnknownEffect(TemplateCreate)(
            request,
            options
          );
        }

        return "base" in request
          ? SchemaParser.decodeUnknownEffect(BaseCreate)(request, options)
          : Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: unnamed },
                request,
                options
              )
            );
      },
      encode: (create, options) =>
        "template" in create
          ? SchemaParser.encodeEffect(TemplateCreate)(create, options)
          : SchemaParser.encodeEffect(BaseCreate)(create, options),
    })
  )
);

export type CreateRequest = typeof CreateRequest.Type;

/** A copy of a machine, `machine`, to a new `name`, with the sizes given or its source's. */
export const ForkRequest = Schema.Struct({
  machine: Name,
  name: MachineName,
  ...labelled,
});

export type ForkRequest = typeof ForkRequest.Type;

/** A machine `name` made from a checkpoint, with the sizes given or the checkpoint's. */
export const RestoreRequest = Schema.Struct({
  checkpoint: Name,
  name: MachineName,
  ...labelled,
});

export type RestoreRequest = typeof RestoreRequest.Type;

/** A checkpoint `name` of `machine`, deleted once `expiresAt` has passed, if given. */
export const CaptureRequest = Schema.Struct({
  machine: Name,
  name: CheckpointName,
  ...labelled,
  ...expiring,
});

export type CaptureRequest = typeof CaptureRequest.Type;

/**
 * A stop of machine `id`. With `capture`, a checkpoint of that name is captured too, before or after
 * the stop as `stopMachine`'s description says.
 */
export const StopRequest = Schema.Struct({
  id: Name,
  capture: Schema.optionalKey(
    Schema.Struct({ name: CheckpointName, ...labelled, ...expiring })
  ),
});

export type StopRequest = typeof StopRequest.Type;

const ArgumentText = Schema.String.check(
  Schema.makeFilter(
    (text: string) =>
      !text.includes("\0") ||
      "holds no NUL byte, which no program's argument or environment can carry"
  )
);

/**
 * A command run in a running machine as `user`, root when it is left out, with `env` set for it,
 * `stdin`, which is text, written whole, and ended with exit code 124 after `timeoutSeconds`.
 * Nothing logs or stores `env` or `stdin`: they can carry secrets. The command runs as long as the
 * request does, and its end or its timeout ends what it started. No argument, `user` or value of
 * `env` holds a NUL byte, and each name in `env` is a variable's name; the host answers `Invalid` to
 * `CLANKERBOX_EXEC`, its mark of the command.
 */
export const ExecRequest = Schema.Struct({
  id: Name,
  argv: Schema.NonEmptyArray(ArgumentText),
  user: Schema.optionalKey(ArgumentText.check(Schema.isNonEmpty())),
  env: Schema.optionalKey(
    recordKeyedBy(
      Schema.String.check(
        Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, {
          message: "it is a letter or '_', then letters, digits and '_'",
        })
      ),
      "variable's name",
      ArgumentText
    )
  ),
  stdin: Schema.optionalKey(Schema.String),
  timeoutSeconds: Schema.optionalKey(Size),
});

export type ExecRequest = typeof ExecRequest.Type;

/** How many characters of a command's output `Executed` keeps, the last ones. */
export const outputLimit = 65_536;

/** The exit code a command ended for running past its `timeoutSeconds` answers, as `timeout(1)`. */
export const timedOutExitCode = 124;

/**
 * `output` is stdout and stderr together, as they arrived, cut to the last `outputLimit`
 * characters, and `truncated` when that dropped any. A runtime that fails to run the command answers
 * its own exit code, with its message in `output`. `mayStillRun` comes only with a timeout's 124,
 * when the host couldn't confirm that the command and what it started had ended in the guest, and
 * says why: some of it may still run there.
 */
export const Executed = Schema.Struct({
  exitCode: Schema.Int,
  output: Schema.String,
  truncated: Schema.Boolean,
  mayStillRun: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Executed" });

export type Executed = typeof Executed.Type;

export const ResizeRequest = Schema.Struct({
  id: Name,
  ...Sizing.fields,
}).check(
  Schema.makeFilter(
    ({ cpu, ramMib, diskGib }) =>
      cpu !== undefined ||
      ramMib !== undefined ||
      diskGib !== undefined ||
      "a resize gives at least one of vCPUs, RAM and disk"
  )
);

export type ResizeRequest = typeof ResizeRequest.Type;

/**
 * A build of `template` from `base` on `runtime` at its sizes, with `setup`, on `host` if one is
 * named. Each build gives them all, and a setup without a timeout takes the host's. Only a host of
 * that runtime takes the build, so each of its clones runs on it too. With `tailnet`, its setup
 * runs on the control plane's tailnet and each machine cloned from it joins it.
 */
export const BuildRequest = Schema.Struct({
  template: Name,
  setup: Setup,
  ...fromBase,
});

export type BuildRequest = typeof BuildRequest.Type;
