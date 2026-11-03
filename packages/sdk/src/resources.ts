import { Schema } from "effect";

import { Desired, HostError } from "./errors.ts";
import { HostId, Name } from "./ids.ts";

/** What a host's machines are: `linux` guests on smolvm, or `mac` guests on Tart. */
export const Kind = Schema.Literals(["linux", "mac"]);

export type Kind = typeof Kind.Type;

const CheckpointKind = Schema.Literals(["ram", "disk"]);

/**
 * The user a machine is logged in as, on either kind: the user a setup, run as root, leaves in the
 * guest, for whom the host installs the operator's keys. Tart's bases ship it; never root.
 */
export const loginUser = "admin";

const Size = Schema.Int.check(Schema.isGreaterThan(0));

export const maxLabels = 16;

const maxLabelLength = 63;

/**
 * What a caller tags a machine or checkpoint with, to find it again: at most `maxLabels` pairs,
 * each key a name and each value at most 63 characters. Set when the resource is made, and never
 * changed after.
 */
export const Labels = Schema.Record(
  Name,
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

/** Whether `labels` carries every pair of `wanted`. */
export const labelledWith = (
  labels: Labels | undefined,
  wanted: Labels | undefined
): boolean =>
  wanted === undefined ||
  Object.entries(wanted).every(([key, value]) => labels?.[key] === value);

/**
 * What the control plane is doing about a machine. A client waits for a rest:
 * `settled`, at rest with what was asked; `failed`, after a step failed, until the next request;
 * and `lost`, one the runtime no longer has, which can only be deleted. `waiting` is no rest: the
 * control plane can't read the machine's host, so it tells nothing of a request, which stays saved
 * and acts when it can, and a wait reads on through it as through an outage. `creating` copies the
 * machine and runs its setup, and a machine whose create or setup fails is deleted, its row kept
 * `failed` to say why. `starting` starts the machine, also when it runs already, resumes a paused
 * one, and prepares it.
 */
export const Phase = Schema.Literals([
  "observing",
  "waiting",
  "creating",
  "starting",
  "stopping",
  "pausing",
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
 * A running machine's place on the tailnet, as the host last checked it: `joined` once
 * `tailscaled` runs signed in, with the MagicDNS name Tailscale gave it, if any; `failed` with
 * why; or `missing` when the guest has no `tailscaled`. Kept in the host's memory only: each start
 * checks again, a joined machine is checked again every half hour or so, and a failed one sooner,
 * waiting longer after each failure.
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
 * `state` is what the runtime reports: `paused` while it holds the machine's saved execution,
 * `missing` when it doesn't have the machine, and `unknown` when it couldn't be read. `desired` is
 * what the last request asked for, `phase` what the control plane is doing about it, and `error`
 * why the last step failed, until the next request. A request takes the row out of rest in the
 * write that records it, so a resting `phase` read after a request has seen it. `prebuild` names the checkpoint a create restored instead of running its setup. `ssh` is only on a running machine whose runtime gives
 * it an endpoint, and `hostKey`, `<type> <base64>`, once preparation has recorded it. `tailnet` is
 * on a running machine of a host that joins its machines to a tailnet, once the host has checked
 * it.
 */
export const Machine = Schema.Struct({
  id: Name,
  kind: Kind,
  createdAt: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  prebuild: Schema.optionalKey(Name),
  ...labelled,
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  state: Schema.Literals([
    "running",
    "stopped",
    "paused",
    "missing",
    "unknown",
  ]),
  desired: Desired,
  phase: Phase,
  error: Schema.optionalKey(HostError),
  ssh: Schema.optionalKey(SshLogin),
  hostKey: Schema.optionalKey(Schema.String),
  tailnet: Schema.optionalKey(TailnetStatus),
}).annotate({ identifier: "Machine" });

export type Machine = typeof Machine.Type;

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
 * `kind` follows its host's: `ram` (RAM and disks) on linux, captured from a running machine, and
 * `disk` on mac, from a stopped one. A client waits on `phase`: a checkpoint is usable only `ready`,
 * and never changes after. A capture that failed stays `failed` to say why, holding no copy. One
 * with `expiresAt` is deleted by the control plane once that time has passed.
 */
export const Checkpoint = Schema.Struct({
  id: Name,
  createdAt: Schema.DateTimeUtcFromString,
  machine: Name,
  kind: CheckpointKind,
  phase: Schema.Literals(["capturing", "ready", "deleting", "failed"]),
  error: Schema.optionalKey(HostError),
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  ...labelled,
  ...expiring,
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
}).annotate({ identifier: "Checkpoint" });

export type Checkpoint = typeof Checkpoint.Type;

export const checkpointKinds = {
  linux: "ram",
  mac: "disk",
} as const satisfies Record<Kind, Checkpoint["kind"]>;

/** A prebuild under way, until the control plane's process ends. */
export const Build = Schema.Struct({
  id: Name,
  phase: Schema.Literals(["building", "built", "failed"]),
  error: Schema.optionalKey(HostError),
}).annotate({ identifier: "Build" });

export type Build = typeof Build.Type;

/**
 * An operator's view of a host: `up` with what it reported, `draining` when placement passes it
 * over, or `unreachable` with why. `runtimeVersion` is the version of smolvm on linux, and of Tart
 * on mac.
 */
export const Host = Schema.Struct({
  id: HostId,
  state: Schema.Literals(["up", "draining", "unreachable"]),
  kind: Schema.optionalKey(Kind),
  version: Schema.optionalKey(Schema.String),
  runtimeVersion: Schema.optionalKey(Schema.String),
  bases: Schema.Array(Schema.String),
  problem: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Host" });

export type Host = typeof Host.Type;

const usageFields = {
  host: HostId,
  resource: Schema.Literals(["cpu", "ramMib", "runningVms"]),
  limit: Schema.optionalKey(Schema.Int),
};

/**
 * A resource of a host and how much of it is in use, counted as a refusal counts it, so it
 * needn't match the host's own machines. When a machine the sum counts couldn't be read, the
 * sum would be a guess, so the row names those machines instead.
 *
 * `cpu` and `ramMib` are what the host's running machines were given, and `runningVms`, on mac,
 * Apple's two VMs per Mac.
 * `limit` is there only where the host refuses an action that would pass it.
 */
export const Usage = Schema.Union([
  Schema.Struct({ ...usageFields, used: Schema.Int }),
  Schema.Struct({ ...usageFields, unread: Schema.Array(Name) }),
]).annotate({ identifier: "Usage" });

export type Usage = typeof Usage.Type;

export const CapacityReport = Schema.Struct({
  usage: Schema.Array(Usage),
  unreachable: Schema.Array(HostId),
}).annotate({ identifier: "CapacityReport" });

export type CapacityReport = typeof CapacityReport.Type;

const { host: _host, ...readingFields } = usageFields;

/** A `Usage` row as a runtime reads it, before the control plane names its host on it. */
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

/**
 * Nothing logs the script: it can carry secrets. `authorizedKeys` is appended to the login user's
 * `~/.ssh/authorized_keys` once the script exits 0, through the guest's `sudo`.
 */
export const Setup = Schema.Struct({
  script: Schema.String,
  timeoutSeconds: Schema.optionalKey(Size),
  authorizedKeys: Schema.optionalKey(PublicKeys),
});

export type Setup = typeof Setup.Type;

const specFields = {
  base: Schema.String,
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  setup: Schema.optionalKey(Setup),
  profile: Schema.optionalKey(Schema.String),
};

/** A profile file fills these in; the server sees only the `profile` label. */
export const MachineSpec = Schema.Struct(specFields);

export type MachineSpec = typeof MachineSpec.Type;

/** `fresh` runs the setup even when a host holds a prebuild of the spec. */
export const CreateRequest = Schema.Struct({
  id: Name,
  ...specFields,
  fresh: Schema.optionalKey(Schema.Boolean),
  ...labelled,
});

export type CreateRequest = typeof CreateRequest.Type;

const FromMachine = { machine: Name, name: Name };

/** A copy of a machine, `machine`, to a new `name`, with the sizes given or its source's. */
export const ForkRequest = Schema.Struct({
  ...FromMachine,
  ...labelled,
});

export type ForkRequest = typeof ForkRequest.Type;

/** A machine `name` made from a checkpoint, with the sizes given or the checkpoint's. */
export const RestoreRequest = Schema.Struct({
  checkpoint: Name,
  name: Name,
  ...labelled,
});

export type RestoreRequest = typeof RestoreRequest.Type;

/** A checkpoint `name` of `machine`, deleted once `expiresAt` has passed, if given. */
export const CaptureRequest = Schema.Struct({
  ...FromMachine,
  ...labelled,
  ...expiring,
});

export type CaptureRequest = typeof CaptureRequest.Type;

/**
 * A pause of machine `id`. With `capture`, a checkpoint of that name is captured first, and the
 * pause begins once the capture has ended, however it ended: the checkpoint's row says how.
 */
export const PauseRequest = Schema.Struct({
  id: Name,
  capture: Schema.optionalKey(
    Schema.Struct({ name: Name, ...labelled, ...expiring })
  ),
});

export type PauseRequest = typeof PauseRequest.Type;

/**
 * A command run in a running machine as `user`, root when it is left out, with `env` set for it,
 * `stdin` written whole, and ended with exit code 124 after `timeoutSeconds`. Nothing logs or
 * stores `env` or `stdin`: they can carry secrets. The command runs as long as the request does.
 */
export const ExecRequest = Schema.Struct({
  id: Name,
  argv: Schema.NonEmptyArray(Schema.String),
  user: Schema.optionalKey(Schema.NonEmptyString),
  env: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
      Schema.String
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
 * its own exit code, with its message in `output`.
 */
export const Executed = Schema.Struct({
  exitCode: Schema.Int,
  output: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Executed" });

export type Executed = typeof Executed.Type;

/** Sizes to give a machine, each optional: one left out stays as it is, or as its source's. */
export const Sizing = Schema.Struct({
  cpu: Schema.optional(Size),
  ramMib: Schema.optional(Size),
  diskGib: Schema.optional(Size),
});

export type Sizing = typeof Sizing.Type;

/** The sizes to give machine `id`, at least one. */
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
 * A base holding a `/` is an image reference, such as `registry.example/team/image:tag`, which a
 * linux host boots as smolvm resolves it at the create; a host's own base names hold none.
 */
export const isImageReference = (base: string): boolean => base.includes("/");

/** Whether `host` creates from `base`: a base it names, or an image reference on linux. */
export const offers = (
  host: Pick<Host, "kind" | "bases">,
  base: string
): boolean =>
  host.bases.includes(base) ||
  (host.kind === "linux" && isImageReference(base));

/** What `host` creates from, as a refusal names it. */
export const offered = ({
  kind,
  bases,
}: Pick<Host, "kind" | "bases">): string =>
  [
    bases.length > 0 ? bases.join(", ") : "no bases",
    ...(kind === "linux" ? ["and any image reference"] : []),
  ].join(", ");

/** A prebuild is a checkpoint of a machine made from the spec, setup and all. */
export const PrebuildRequest = Schema.Struct({ ...specFields, setup: Setup });

export type PrebuildRequest = typeof PrebuildRequest.Type;
