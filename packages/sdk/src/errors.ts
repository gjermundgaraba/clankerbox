import { Schema } from "effect";

/** A host sends none of these; the client library sets them. */
const located = {
  host: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
};

/** The request is malformed, or the host list is one a client can't route by. */
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
 * No reply: only the client library makes it. A mutation's request may have reached the host
 * and run, so it is retryable only when `readOnly`.
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
 * A config, profile or setup file couldn't be read or doesn't hold what it should. No host saw
 * it.
 */
export class InvalidFile extends Schema.TaggedError<InvalidFile>()("InvalidFile", {
  message: Schema.String,
  file: Schema.String,
}) {
  get retryable(): boolean {
    return false;
  }
}

/** Every action declares these. */
export const hostErrors = [Invalid, NotFound, Conflict, Precondition, Capacity, Internal] as const;

export type HostError = InstanceType<(typeof hostErrors)[number]>;

export type ClankerboxError = HostError | Unavailable;

export const HostErrorTag = Schema.Literals(
  hostErrors.map((error) => error.fields._tag.schema.literal),
);

export type HostErrorTag = typeof HostErrorTag.Type;

export const ErrorTag = Schema.Literals([
  ...HostErrorTag.literals,
  Unavailable.fields._tag.schema.literal,
]);

export type ErrorTag = typeof ErrorTag.Type;
