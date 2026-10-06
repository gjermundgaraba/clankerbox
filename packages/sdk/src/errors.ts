/**
 * The seven errors every clankerbox call can fail with. `retryable` is derived from the
 * tag, so callers never keep their own table of which failures to repeat.
 */
import type * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

/** The request is malformed: a bad ID or name, an undeclared field, a value out of range. */
export class Invalid extends Schema.TaggedError<Invalid>()(
  "Invalid",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {
  get retryable(): boolean {
    return false;
  }
}

/** The machine or checkpoint doesn't exist. A `delete` that meets it is done. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
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
  { message: Schema.String, kind: ConflictKind },
  { httpApiStatus: 409 },
) {
  get retryable(): boolean {
    return this.kind === "busy";
  }
}

/** The resource's state doesn't allow the action, or no host offers the requested base. */
export class Precondition extends Schema.TaggedError<Precondition>()(
  "Precondition",
  { message: Schema.String },
  { httpApiStatus: 412 },
) {
  get retryable(): boolean {
    return false;
  }
}

/** The host has no room now; room can free up, so a later call may succeed. */
export class Capacity extends Schema.TaggedError<Capacity>()(
  "Capacity",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {
  get retryable(): boolean {
    return true;
  }
}

/**
 * The client couldn't reach the host, or lost its reply. Only the client library produces
 * it. `access` is the access of the action that met it: a mutation's request may have
 * reached the host and run, so it is never retryable.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  message: Schema.String,
  access: Schema.Literals(["read", "write"] satisfies ReadonlyArray<Action.Access>),
}) {
  get retryable(): boolean {
    return this.access === "read";
  }
}

export class Internal extends Schema.TaggedError<Internal>()(
  "Internal",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {
  get retryable(): boolean {
    return false;
  }
}

/** What a host answers with; every action group declares these. */
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
