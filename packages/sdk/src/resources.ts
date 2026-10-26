import { Schema } from "effect";
import { Desired, HostError } from "./errors.ts";
import { HostId, Id } from "./ids.ts";

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

/**
 * What the host is doing about a machine. A request waits for a rest: `settled`, at rest with what
 * was asked; `failed`, after a step failed, until the next request; `lost`, one the runtime no
 * longer has, which can only be deleted; and `waiting`, one the runtime can't read, which fails the
 * request and is read again at the host's next recheck. `creating` copies the machine and runs its
 * setup, and a machine whose create or setup fails is deleted. `starting` starts the machine, also
 * when it runs already, resumes a paused one, and prepares it.
 */
export const Phase = Schema.Literals([
  "observing",
  "waiting",
  "creating",
  "starting",
  "stopping",
  "pausing",
  "deleting",
  "settled",
  "failed",
  "lost",
]);

export type Phase = typeof Phase.Type;

export const SshEndpoint = Schema.Struct({
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
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
  Schema.Struct({ state: Schema.Literal("joined"), name: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ state: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ state: Schema.Literal("missing") }),
]).annotate({ identifier: "TailnetStatus" });

export type TailnetStatus = typeof TailnetStatus.Type;

/**
 * `state` is what the runtime reports: `paused` while it holds the machine's saved execution,
 * `missing` when it doesn't have the machine, and `unknown` when it couldn't be read. `desired` is
 * what the last request asked for, `phase` what the host is doing about it, and `error` why the
 * last step failed, until the next request. `ssh` is only on a running machine whose runtime gives
 * it an endpoint, and `hostKey`, `<type> <base64>`, once preparation has recorded it. `tailnet` is
 * on a running machine of a host that joins its machines to a tailnet, once the host has checked
 * it.
 */
export const Machine = Schema.Struct({
  id: Id,
  kind: Kind,
  createdAt: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
  state: Schema.Literals(["running", "stopped", "paused", "missing", "unknown"]),
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
export const stateLabel = ({ state, desired, phase }: Machine): string =>
  phase === "settled"
    ? state
    : state === desired
      ? `${state} (${phase})`
      : `${state}, wants ${desired} (${phase})`;

/**
 * `kind` follows its host's: `ram` (RAM and disks) on linux, captured from a running machine, and
 * `disk` on mac, from a stopped one. A checkpoint exists only once its capture is done, and never
 * changes after.
 */
export const Checkpoint = Schema.Struct({
  id: Id,
  createdAt: Schema.DateTimeUtcFromString,
  machine: Id,
  kind: CheckpointKind,
  base: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
}).annotate({ identifier: "Checkpoint" });

export type Checkpoint = typeof Checkpoint.Type;

/** `runtimeVersion` is the version of smolvm on linux, and of Tart on mac. */
export const Host = Schema.Struct({
  id: HostId,
  kind: Kind,
  version: Schema.String,
  runtimeVersion: Schema.String,
  bases: Schema.Array(Schema.String),
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
  Schema.Struct({ ...usageFields, unread: Schema.Array(Id) }),
]).annotate({ identifier: "Usage" });

export type Usage = typeof Usage.Type;

type WithoutHost<Row> = Row extends unknown ? Omit<Row, "host"> : never;

/** A `Usage` row as a runtime reads it, before the host names itself on it. */
export type Reading = WithoutHost<Usage>;

const publicKeyLine = /^(?:ssh|ecdsa|sk)-[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}(?: .*)?$/u;

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
  }),
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

/** A profile file fills these in; the host sees only the `profile` label. */
export const MachineSpec = Schema.Struct(specFields);

export type MachineSpec = typeof MachineSpec.Type;

/** The host checks that `id` names it, so a create never lands under another host's ID. */
export const CreateRequest = Schema.Struct({ id: Id, ...specFields });

export type CreateRequest = typeof CreateRequest.Type;

/** Sizes to give a machine, each optional: one left out stays as it is, or as its source's. */
export const Sizing = Schema.Struct({
  cpu: Schema.optional(Size),
  ramMib: Schema.optional(Size),
  diskGib: Schema.optional(Size),
});

export type Sizing = typeof Sizing.Type;

/** The sizes to give machine `id`, at least one. */
export const ResizeRequest = Schema.Struct({ id: Id, ...Sizing.fields }).check(
  Schema.makeFilter(
    ({ cpu, ramMib, diskGib }) =>
      cpu !== undefined ||
      ramMib !== undefined ||
      diskGib !== undefined ||
      "a resize gives at least one of vCPUs, RAM and disk",
  ),
);

export type ResizeRequest = typeof ResizeRequest.Type;

/**
 * A base holding a `/` is an image reference, such as `registry.example/team/image:tag`, which a
 * linux host boots as smolvm resolves it at the create; a host's own base names hold none.
 */
export const isImageReference = (base: string): boolean => base.includes("/");

/** Whether `host` creates from `base`: a base it names, or an image reference on linux. */
export const offers = (host: Pick<Host, "kind" | "bases">, base: string): boolean =>
  host.bases.includes(base) || (host.kind === "linux" && isImageReference(base));

/** What `host` creates from, as a refusal names it. */
export const offered = ({ kind, bases }: Pick<Host, "kind" | "bases">): string =>
  [
    bases.length > 0 ? bases.join(", ") : "no bases",
    ...(kind === "linux" ? ["and any image reference"] : []),
  ].join(", ");

/**
 * A command run in a running machine as `user`, root when it is left out, with `stdin` written
 * whole. It runs as long as the request does: ending the request ends it, though on mac a command
 * that writes nothing runs on until it next writes.
 */
export const ExecRequest = Schema.Struct({
  id: Id,
  argv: Schema.NonEmptyArray(Schema.String),
  user: Schema.optional(Schema.NonEmptyString),
  stdin: Schema.optional(Schema.String),
});

export type ExecRequest = typeof ExecRequest.Type;

/** How many characters of a command's output `Executed` keeps, the last ones. */
export const outputLimit = 65_536;

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

/** A prebuild is the checkpoint `id` of a machine made from the spec, setup and all. */
export const PrebuildRequest = Schema.Struct({ id: Id, ...specFields, setup: Setup });

export type PrebuildRequest = typeof PrebuildRequest.Type;
