/**
 * Machine and checkpoint IDs, `<host>_<name>`: the one place that parses and formats them.
 * Neither part contains `_`, so an ID has exactly one. The whole ID matches
 * `^[A-Za-z0-9_-]{1,62}$` because it is written to `/var/lib/clankerbox/machine-id`, and
 * clankercreds accepts only that pattern.
 */
import { Effect, Schema } from "effect";
import { Invalid } from "./errors.ts";

const separator = "_";

const maxIdLength = 62;

const idPattern = /^[A-Za-z0-9_-]{1,62}$/u;

/**
 * boat's named snapshots are `cbx-<host>-<inst>`, and boat allows `^[a-z0-9][a-z0-9-]{0,62}$`:
 * a lowercase host ID of at most 32 characters keeps the name within 63.
 */
const hostIdPattern = /^[a-z][a-z0-9-]{0,31}$/u;

const hostIdRule = "a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter";

/**
 * smolvm names a machine `<name>-<inst>` and refuses consecutive hyphens, so a name has no
 * `--` and doesn't end in `-`.
 */
const namePattern = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;

const nameRule =
  "a name starts with a letter, then letters, digits and '-', with no '--' and no '-' at the end";

/** A host's part of every ID it holds. */
export const HostId = Schema.String.check(Schema.isPattern(hostIdPattern, { message: hostIdRule }));

/** A machine's or checkpoint's name, unique per host and per resource type. */
export const Name = Schema.String.check(Schema.isPattern(namePattern, { message: nameRule }));

/** The parts of an ID: the host that holds the resource and the resource's name there. */
export interface IdParts {
  readonly host: string;
  readonly name: string;
}

const describeId = (id: string): string | undefined => {
  if (!idPattern.test(id)) {
    return `ID ${JSON.stringify(id)} must be 1 to ${maxIdLength} letters, digits, '_' or '-'`;
  }

  const at = id.indexOf(separator);

  if (at <= 0 || at === id.length - 1) {
    return `ID ${JSON.stringify(id)} must be <host>_<name>`;
  }

  if (!hostIdPattern.test(id.slice(0, at))) {
    return `ID ${JSON.stringify(id)} has an invalid host: ${hostIdRule}`;
  }

  if (!namePattern.test(id.slice(at + 1))) {
    return `ID ${JSON.stringify(id)} has an invalid name: ${nameRule}`;
  }

  return undefined;
};

/** A full `<host>_<name>` ID. */
export const Id = Schema.String.check(Schema.makeFilter((id: string) => describeId(id) ?? true));

/** Splits an ID at its `_` into host and name. */
export const parseId = (id: string): Effect.Effect<IdParts, Invalid> => {
  const problem = describeId(id);

  if (problem !== undefined) {
    return Effect.fail(new Invalid({ message: problem }));
  }

  const at = id.indexOf(separator);

  return Effect.succeed({ host: id.slice(0, at), name: id.slice(at + 1) });
};

/** Checks a name on its own, before it is joined to a host. */
export const parseName = (name: string): Effect.Effect<string, Invalid> =>
  namePattern.test(name)
    ? Effect.succeed(name)
    : Effect.fail(new Invalid({ message: `name ${JSON.stringify(name)}: ${nameRule}` }));

/** Joins a host ID and a name into the resource's ID, checking both parts and the whole. */
export const formatId = (host: string, name: string): Effect.Effect<string, Invalid> => {
  if (!hostIdPattern.test(host)) {
    return Effect.fail(new Invalid({ message: `host ID ${JSON.stringify(host)}: ${hostIdRule}` }));
  }

  const id = `${host}${separator}${name}`;

  return parseName(name).pipe(Effect.andThen(parseId(id)), Effect.as(id));
};
