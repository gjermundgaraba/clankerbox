/**
 * The host's names and IDs: an ID's name on this host, a row's ID, a new row's `instance`, and
 * the NotFound a missing row is. The store and the actions both use them.
 */
import { randomBytes } from "node:crypto";
import { Invalid, NotFound, parseId } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

/** The bytes of a row's `instance`: 32 hex characters. */
const instanceBytes = 16;

/** A new row's `instance`, which its native names carry. */
export const newInstance = (): string => randomBytes(instanceBytes).toString("hex");

/**
 * The name an ID gives on host `host`: the whole ID is checked, and an ID for another host is
 * the caller's mistake. A new machine's ID goes through here too, so the ID a row's machine
 * reports always fits clankercreds' pattern.
 */
export const nameOn =
  (host: string) =>
  (id: string): Effect.Effect<string, Invalid> =>
    Effect.flatMap(parseId(id), (parts) =>
      parts.host === host
        ? Effect.succeed(parts.name)
        : Effect.fail(
            new Invalid({ message: `${id} names host ${parts.host}, and this is host ${host}` }),
          ),
    );

/** The ID of the resource named `name` on host `host`, a name that is already checked. */
export const idOn =
  (host: string) =>
  (name: string): string =>
    `${host}_${name}`;

/** What each kind of row is called in errors. */
export type Kind = "machine" | "checkpoint";

/** The error for a missing row on host `host`. */
export const notFoundOn =
  (host: string) =>
  (kind: Kind, name: string): NotFound =>
    new NotFound({ message: `no ${kind} ${idOn(host)(name)}` });
