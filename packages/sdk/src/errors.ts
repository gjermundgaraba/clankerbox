import { Match, Schema } from "effect";

const located = {
  host: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  made: Schema.optionalKey(Schema.String),
};

/**
 * The request is malformed, or the host list is one a client can't route by, or a config,
 * profile or setup file couldn't be read or doesn't hold what it should: then `file` names it.
 */
export class Invalid extends Schema.TaggedError<Invalid>()(
  "Invalid",
  { message: Schema.String, ...located, file: Schema.optionalKey(Schema.String) },
  { httpApiStatus: 400 },
) {}

/** The machine or checkpoint doesn't exist. A `delete` that meets it is done. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String, ...located },
  { httpApiStatus: 404 },
) {}

/** The name is taken. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String, ...located },
  { httpApiStatus: 409 },
) {}

/**
 * A later request on the machine replaced this one before the host got there: `by` is what that
 * request asked for. The machine's own state says where it is now.
 */
export class Superseded extends Schema.TaggedError<Superseded>()(
  "Superseded",
  { message: Schema.String, ...located, by: Schema.Literals(["running", "stopped", "deleted"]) },
  { httpApiStatus: 409 },
) {}

/** No host offers `base`: the host a create names, or any in the client's list. */
export class NotOffered extends Schema.TaggedError<NotOffered>()(
  "NotOffered",
  { message: Schema.String, ...located, base: Schema.String },
  { httpApiStatus: 412 },
) {}

/** `machine` isn't made yet: its create or setup still runs, so it can't be copied or captured. */
export class NotMade extends Schema.TaggedError<NotMade>()(
  "NotMade",
  { message: Schema.String, ...located, machine: Schema.String },
  { httpApiStatus: 412 },
) {}

/** The runtime no longer has `machine`: it can only be deleted. */
export class Missing extends Schema.TaggedError<Missing>()(
  "Missing",
  { message: Schema.String, ...located, machine: Schema.String },
  { httpApiStatus: 412 },
) {}

/** `checkpoint` holds RAM state saved under another runtime pin than the one the host runs. */
export class PinMismatch extends Schema.TaggedError<PinMismatch>()(
  "PinMismatch",
  { message: Schema.String, ...located, checkpoint: Schema.String },
  { httpApiStatus: 412 },
) {}

/** `machine` is in `state`, which the action doesn't act from. */
export class WrongState extends Schema.TaggedError<WrongState>()(
  "WrongState",
  { message: Schema.String, ...located, machine: Schema.String, state: Schema.String },
  { httpApiStatus: 412 },
) {}

/** The runtime can't give the requested sizes, such as a disk below the base's. */
export class Unsizable extends Schema.TaggedError<Unsizable>()(
  "Unsizable",
  { message: Schema.String, ...located },
  { httpApiStatus: 422 },
) {}

/**
 * A guest script exited non-zero or ran past its timeout; the message says which, with its
 * output's tail, and `script` names it: a failed `setup` deletes the machine, and a failed
 * `preparation` runs again on the next start.
 */
export class ScriptFailed extends Schema.TaggedError<ScriptFailed>()(
  "ScriptFailed",
  {
    message: Schema.String,
    ...located,
    script: Schema.String,
  },
  { httpApiStatus: 422 },
) {}

/** The provider under the runtime refused the call for good, such as for its plan or API key. */
export class Refused extends Schema.TaggedError<Refused>()(
  "Refused",
  { message: Schema.String, ...located },
  { httpApiStatus: 403 },
) {}

/** The host has no room now; room can free up, so a later call may succeed. */
export class Capacity extends Schema.TaggedError<Capacity>()(
  "Capacity",
  { message: Schema.String, ...located },
  { httpApiStatus: 503 },
) {}

/**
 * No reply: only the client library makes it. A mutation's request may have reached the host
 * and run, so it is retryable only when `readOnly`.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  message: Schema.String,
  readOnly: Schema.Boolean,
  ...located,
}) {}

export class Internal extends Schema.TaggedError<Internal>()(
  "Internal",
  { message: Schema.String, ...located },
  { httpApiStatus: 500 },
) {}

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
  Refused,
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
      Refused: () => false,
      Capacity: () => true,
      Unavailable: ({ readOnly }) => readOnly,
      Internal: () => false,
    }),
  );
