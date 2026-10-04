/**
 * Machine and checkpoint IDs, `<host>_<name>`: the one place that parses and formats them.
 * The whole ID matches `^[A-Za-z0-9_-]{1,62}$` because it is written to
 * `/var/lib/clankerbox/machine-id`, and clankercreds accepts only that pattern.
 */
import { Effect, Schema } from "effect";
import { Invalid } from "./errors.ts";

const separator = "_";

const maxIdLength = 62;

const idPattern = /^[A-Za-z0-9_-]{1,62}$/u;

const hostIdPattern = /^[A-Za-z0-9-]+$/u;

/**
 * smolvm names a machine `<name>-<inst>` and refuses consecutive hyphens, so a name has no
 * `--` and doesn't end in `-`.
 */
const namePattern = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*$/u;

const nameRule =
  "a name starts with a letter, then letters, digits, '_' and '-', with no '--' and no '-' at the end";

/** A host's part of every ID it holds. It can't contain `_`, where IDs split. */
export const HostId = Schema.String.check(
  Schema.isPattern(hostIdPattern, {
    message: "a host ID is letters, digits and '-', without '_'",
  }),
);

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

  if (!namePattern.test(id.slice(at + 1))) {
    return `ID ${JSON.stringify(id)} has an invalid name: ${nameRule}`;
  }

  return undefined;
};

/** A full `<host>_<name>` ID. */
export const Id = Schema.String.check(Schema.makeFilter((id: string) => describeId(id) ?? true));

/**
 * Whether `create`'s target is a full ID rather than a bare name. Anything with a `_` is an
 * ID, split at its first `_`; a name that contains `_` is created through its full ID.
 */
export const isId = (target: string): boolean => target.includes(separator);

/** Splits an ID at its first `_` into host and name. */
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
    return Effect.fail(
      new Invalid({
        message: `host ID ${JSON.stringify(host)} must be letters, digits and '-', without '_'`,
      }),
    );
  }

  const id = `${host}${separator}${name}`;

  return parseName(name).pipe(Effect.andThen(parseId(id)), Effect.as(id));
};
