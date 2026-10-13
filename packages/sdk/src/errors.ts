/**
 * The seven errors every clankerbox call can fail with. `retryable` is derived from the
 * tag, so callers never keep their own table of which failures to repeat.
 */
import { Schema } from "effect";

/**
 * Where a call through the client library met the error: the host, the contract's action, and
 * the ID it acted on or was making. A host sends none of them; the client sets them.
 */
const located = {
  host: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
};

/**
 * The request is malformed: a bad ID or name, an undeclared field, a value out of range, or a
 * host list a client can't route by.
 */
export class Invalid extends Schema.TaggedError<Invalid>()(
  "Invalid",
  { message: Schema.String, ...located },
  { httpApiStatus: 400 },
) {
  get retryable(): boolean {
    return false;
  }
}

/** The machine or checkpoint doesn't exist. A `delete` that meets it is done. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String, ...located },
  { httpApiStatus: 404 },
) {
  get retryable(): boolean {
    return false;
  }
}

export const ConflictKind = Schema.Literals(["exists", "busy"]);

export type ConflictKind = typeof ConflictKind.Type;

/** The name is taken (`exists`), or another action holds the resource (`busy`). */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String, kind: ConflictKind, ...located },
  { httpApiStatus: 409 },
) {
  get retryable(): boolean {
    return this.kind === "busy";
  }
}

/** The resource's state doesn't allow the action, or no host offers the requested base. */
export class Precondition extends Schema.TaggedError<Precondition>()(
  "Precondition",
  { message: Schema.String, ...located },
  { httpApiStatus: 412 },
) {
  get retryable(): boolean {
    return false;
  }
}

/** The host has no room now; room can free up, so a later call may succeed. */
export class Capacity extends Schema.TaggedError<Capacity>()(
  "Capacity",
  { message: Schema.String, ...located },
  { httpApiStatus: 503 },
) {
  get retryable(): boolean {
    return true;
  }
}

/**
 * The client couldn't reach the host, or lost its reply. Only the client library produces
 * it. `readOnly` is that of the action that met it: a mutation's request may have reached
 * the host and run, so it is never retryable.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  message: Schema.String,
  readOnly: Schema.Boolean,
  ...located,
}) {
  get retryable(): boolean {
    return this.readOnly;
  }
}

export class Internal extends Schema.TaggedError<Internal>()(
  "Internal",
  { message: Schema.String, ...located },
  { httpApiStatus: 500 },
) {
  get retryable(): boolean {
    return false;
  }
}

/**
 * A file the client reads, such as a config, a profile or a setup, couldn't be read, or what it
 * holds isn't what it should be. No host saw anything, and no call fails with it: only what
 * reads the file does.
 */
export class InvalidFile extends Schema.TaggedError<InvalidFile>()("InvalidFile", {
  message: Schema.String,
  /** The file or directory, as the reader was given it. */
  file: Schema.String,
}) {
  get retryable(): boolean {
    return false;
  }
}

/** What a host answers with; every action declares these. */
export const hostErrors = [Invalid, NotFound, Conflict, Precondition, Capacity, Internal] as const;

export type HostError = InstanceType<(typeof hostErrors)[number]>;

/** What a call through the client library fails with. */
export type ClankerboxError = HostError | Unavailable;

/** The tag a host records on a failed action: always one of the errors it answers with. */
export const HostErrorTag = Schema.Literals(
  hostErrors.map((error) => error.fields._tag.schema.literal),
);

export type HostErrorTag = typeof HostErrorTag.Type;

/** The tag of any error a call through the client library can fail with. */
export const ErrorTag = Schema.Literals([
  ...HostErrorTag.literals,
  Unavailable.fields._tag.schema.literal,
]);

export type ErrorTag = typeof ErrorTag.Type;
