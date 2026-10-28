import { Match, Predicate, Record, Schema } from "effect";

const located = {
  host: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  made: Schema.optionalKey(Schema.String),
};

export interface Where {
  readonly host?: string | undefined;
  readonly action?: string | undefined;
  readonly id?: string | undefined;
  readonly made?: string | undefined;
}

const at = (error: Where, where: Where) =>
  Record.filter(
    {
      host: error.host ?? where.host,
      action: error.action ?? where.action,
      id: error.id ?? where.id,
      made: error.made ?? where.made,
    },
    Predicate.isNotUndefined
  );

/**
 * The request is malformed, or the host list is one a client can't route by, or a config,
 * profile or setup file couldn't be read or doesn't hold what it should: then `file` names it.
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
 * What the operator asked a machine to be; the host keeps moving the machine toward it. `paused`
 * keeps its RAM, processes and disks, saved by the runtime with the VM stopped, and a start
 * resumes it; a machine that is stopped when a pause comes stays stopped, and one the runtime
 * can't save, such as a VM an older runtime booted, is stopped instead.
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
 * request asked for. The machine's own state says where it is now.
 */
export class Superseded extends Schema.TaggedError<
  Superseded,
  { readonly brand: unique symbol }
>()(
  "Superseded",
  {
    message: Schema.String,
    ...located,
    by: Desired,
  },
  { httpApiStatus: 409 }
) {
  located(where: Where): Superseded {
    return new Superseded({
      ...at(this, where),
      by: this.by,
      message: this.message,
    });
  }
}

/** No host offers `base`: the host a create names, or any in the client's list. */
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
 * No reply: only the client library makes it. A mutation's request may have reached the host
 * and run, so it is retryable only when `readOnly`.
 */
export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", {
  message: Schema.String,
  readOnly: Schema.Boolean,
  ...located,
}) {
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

/** What a host may answer with; each action declares its own share. */
export const hostErrors = [
  Invalid,
  NotFound,
  Conflict,
  Superseded,
  NotOffered,
  NotMade,
  Missing,
  PinMismatch,
  WrongState,
  Unsizable,
  ScriptFailed,
  Capacity,
  Internal,
] as const;

export const HostError = Schema.Union(hostErrors);

export type HostError = typeof HostError.Type;

/**
 * Each carries, where known: `host` and `action`, which the client sets; `id`, the resource the
 * error is about, which a host sets on `NotFound` and `Conflict` and the client sets to the call's
 * subject otherwise; and `made`, the resource a create, fork, restore or capture makes. The host
 * deletes a machine whose copy or setup fails, again at each recheck while that delete fails, and
 * keeps one whose preparation fails; a call whose answer was lost, `Unavailable`, may leave
 * `made` behind unmade.
 */
export const ClankerboxError = Schema.Union([...hostErrors, Unavailable]);

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
