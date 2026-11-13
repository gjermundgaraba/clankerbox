import { Match, Predicate, Record, Schema } from "effect";

const located = {
  action: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  made: Schema.optionalKey(Schema.String),
};

export interface Where {
  readonly action?: string | undefined;
  readonly id?: string | undefined;
  readonly made?: string | undefined;
}

const at = (error: Where, where: Where) =>
  Record.filter(
    {
      action: error.action ?? where.action,
      id: error.id ?? where.id,
      made: error.made ?? where.made,
    },
    Predicate.isNotUndefined
  );

/**
 * The request is malformed, or a config or setup file couldn't be read or doesn't hold what it
 * should: then `file` names it.
 */
export class Invalid extends Schema.TaggedError<
  Invalid,
  { readonly brand: unique symbol }
>()(
  "Invalid",
  {
    message: Schema.String,
    ...located,
    file: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 400 }
) {
  located(where: Where): Invalid {
    const { file } = this;

    return new Invalid({
      ...at(this, where),
      ...(file === undefined ? {} : { file }),
      message: this.message,
    });
  }
}

/** The machine or checkpoint doesn't exist. A `delete` that meets it is done. */
export class NotFound extends Schema.TaggedError<
  NotFound,
  { readonly brand: unique symbol }
>()(
  "NotFound",
  { message: Schema.String, ...located },
  { httpApiStatus: 404 }
) {
  located(where: Where): NotFound {
    return new NotFound({ ...at(this, where), message: this.message });
  }
}

/** The name is taken. */
export class Conflict extends Schema.TaggedError<
  Conflict,
  { readonly brand: unique symbol }
>()(
  "Conflict",
  { message: Schema.String, ...located },
  { httpApiStatus: 409 }
) {
  located(where: Where): Conflict {
    return new Conflict({ ...at(this, where), message: this.message });
  }
}

/**
 * What the operator asked a machine to be. `paused` keeps its RAM, processes and disks, saved by
 * the runtime with the VM stopped, and a start resumes it; a machine that is stopped when a pause
 * comes stays stopped, and one the runtime can't save, such as a VM an older runtime booted, is
 * stopped instead.
 */
export const Desired = Schema.Literals([
  "running",
  "stopped",
  "paused",
  "deleted",
]);

export type Desired = typeof Desired.Type;

/**
 * A later request on the machine replaced this one before the host got there: `by` is what that
 * request asked for. The machine's own state says where it is now. The client makes it, from what
 * its wait reads; the control plane never answers it.
 */
export class Superseded extends Schema.TaggedError<
  Superseded,
  { readonly brand: unique symbol }
>()("Superseded", {
  message: Schema.String,
  ...located,
  by: Desired,
}) {
  located(where: Where): Superseded {
    return new Superseded({
      ...at(this, where),
      by: this.by,
      message: this.message,
    });
  }
}

/** No host offers `base`. */
export class NotOffered extends Schema.TaggedError<
  NotOffered,
  { readonly brand: unique symbol }
>()(
  "NotOffered",
  { message: Schema.String, ...located, base: Schema.String },
  { httpApiStatus: 412 }
) {
  located(where: Where): NotOffered {
    return new NotOffered({
      ...at(this, where),
      base: this.base,
      message: this.message,
    });
  }
}

/**
 * `template` has no ready build to clone: no build of it has succeeded, or none is kept of the one
 * pinned, or no host that could take its clone holds a current copy of it. A build of the template
 * on such a host makes one.
 */
export class NotBuilt extends Schema.TaggedError<
  NotBuilt,
  { readonly brand: unique symbol }
>()(
  "NotBuilt",
  { message: Schema.String, ...located, template: Schema.String },
  { httpApiStatus: 412 }
) {
  located(where: Where): NotBuilt {
    return new NotBuilt({
      ...at(this, where),
      template: this.template,
      message: this.message,
    });
  }
}

/** `machine` isn't made yet: its create or setup still runs, so it can't be copied or captured. */
export class NotMade extends Schema.TaggedError<
  NotMade,
  { readonly brand: unique symbol }
>()(
  "NotMade",
  { message: Schema.String, ...located, machine: Schema.String },
  { httpApiStatus: 412 }
) {
  located(where: Where): NotMade {
    return new NotMade({
      ...at(this, where),
      machine: this.machine,
      message: this.message,
    });
  }
}

/** The runtime no longer has `machine`: it can only be deleted. */
export class Missing extends Schema.TaggedError<
  Missing,
  { readonly brand: unique symbol }
>()(
  "Missing",
  { message: Schema.String, ...located, machine: Schema.String },
  { httpApiStatus: 412 }
) {
  located(where: Where): Missing {
    return new Missing({
      ...at(this, where),
      machine: this.machine,
      message: this.message,
    });
  }
}

/**
 * The checkpoint or paused machine `id` holds RAM state saved under another runtime pin than the
 * one the host runs, and restores or resumes only under that one; or machine `id` runs a VM booted
 * under another one, and is captured or forked only after a stop and a start.
 */
export class PinMismatch extends Schema.TaggedError<
  PinMismatch,
  { readonly brand: unique symbol }
>()(
  "PinMismatch",
  { message: Schema.String, ...located },
  { httpApiStatus: 412 }
) {
  located(where: Where): PinMismatch {
    return new PinMismatch({ ...at(this, where), message: this.message });
  }
}

/** `machine` is in `state`, which the action doesn't act from. */
export class WrongState extends Schema.TaggedError<
  WrongState,
  { readonly brand: unique symbol }
>()(
  "WrongState",
  {
    message: Schema.String,
    ...located,
    machine: Schema.String,
    state: Schema.String,
  },
  { httpApiStatus: 412 }
) {
  located(where: Where): WrongState {
    return new WrongState({
      ...at(this, where),
      machine: this.machine,
      state: this.state,
      message: this.message,
    });
  }
}

/**
 * The runtime can't give the requested sizes, such as a disk below the base's or below the
 * machine's, or a running machine's vCPUs or RAM below what it has.
 */
export class Unsizable extends Schema.TaggedError<
  Unsizable,
  { readonly brand: unique symbol }
>()(
  "Unsizable",
  { message: Schema.String, ...located },
  { httpApiStatus: 422 }
) {
  located(where: Where): Unsizable {
    return new Unsizable({ ...at(this, where), message: this.message });
  }
}

/**
 * A guest script exited non-zero or ran past its timeout; the message says which, with its
 * output's tail, and `script` names it: a failed `setup` deletes the machine, and a failed
 * `preparation` runs again on the next start.
 */
export class ScriptFailed extends Schema.TaggedError<
  ScriptFailed,
  { readonly brand: unique symbol }
>()(
  "ScriptFailed",
  {
    message: Schema.String,
    ...located,
    script: Schema.String,
  },
  { httpApiStatus: 422 }
) {
  located(where: Where): ScriptFailed {
    return new ScriptFailed({
      ...at(this, where),
      script: this.script,
      message: this.message,
    });
  }
}

/** The host has no room now; room can free up, so a later call may succeed. */
export class Capacity extends Schema.TaggedError<
  Capacity,
  { readonly brand: unique symbol }
>()(
  "Capacity",
  { message: Schema.String, ...located },
  { httpApiStatus: 503 }
) {
  located(where: Where): Capacity {
    return new Capacity({ ...at(this, where), message: this.message });
  }
}

/**
 * No answer. The client makes it when the control plane gives no reply, or when a wait stops with
 * the request saved, and the control plane when no host it could place on answers. A mutation may
 * have been recorded and may yet run, so it is retryable only when `readOnly`.
 */
export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()(
  "Unavailable",
  {
    message: Schema.String,
    readOnly: Schema.Boolean,
    ...located,
  },
  { httpApiStatus: 503 }
) {
  located(where: Where): Unavailable {
    return new Unavailable({
      ...at(this, where),
      readOnly: this.readOnly,
      message: this.message,
    });
  }
}

export class Internal extends Schema.TaggedError<
  Internal,
  { readonly brand: unique symbol }
>()(
  "Internal",
  { message: Schema.String, ...located },
  { httpApiStatus: 500 }
) {
  located(where: Where): Internal {
    return new Internal({ ...at(this, where), message: this.message });
  }
}

export const hostErrors = [
  Invalid,
  NotFound,
  Conflict,
  NotOffered,
  NotBuilt,
  NotMade,
  Missing,
  PinMismatch,
  WrongState,
  Unsizable,
  ScriptFailed,
  Capacity,
  Unavailable,
  Internal,
] as const;

export const HostError = Schema.Union(hostErrors);

export type HostError = typeof HostError.Type;

export const clankerboxErrors = [...hostErrors, Superseded] as const;

/**
 * What a client's call fails with: what the control plane answers, and `Superseded`, which the
 * client makes. Each carries, where known: `action`, which the client sets; `id`, the resource the
 * error is about, which the control plane sets on `NotFound` and `Conflict` and the client sets to
 * the call's subject otherwise; and `made`, the resource a create, fork, restore or capture made
 * or may have made: set on a failure after the control plane recorded the request, and on an
 * `Unavailable` whose answer was lost, which may leave it behind, but never on a refusal, which
 * made nothing. A machine whose copy or setup fails is deleted, again at each recheck while that
 * delete fails, and one whose preparation fails is kept.
 */
export const ClankerboxError = Schema.Union(clankerboxErrors);

export type ClankerboxError = typeof ClankerboxError.Type;

/**
 * Whether the same call may succeed later: a full host may free up, and a read that got no reply
 * may get one.
 */
export const retryable = (error: ClankerboxError): boolean =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      Invalid: () => false,
      NotFound: () => false,
      Conflict: () => false,
      Superseded: () => false,
      NotOffered: () => false,
      NotBuilt: () => false,
      NotMade: () => false,
      Missing: () => false,
      PinMismatch: () => false,
      WrongState: () => false,
      Unsizable: () => false,
      ScriptFailed: () => false,
      Capacity: () => true,
      Unavailable: ({ readOnly }) => readOnly,
      Internal: () => false,
    })
  );
