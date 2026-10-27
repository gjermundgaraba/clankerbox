import { Effect, Schema } from "effect";

import { Invalid } from "./errors.ts";

const separator = "_";

const maxIdLength = 62;

const idPattern = /^[A-Za-z0-9_-]{1,62}$/u;

const hostIdPattern = /^[a-z][a-z0-9-]{0,31}$/u;

const hostIdRule =
  "a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter";

const namePattern = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;

const nameRule =
  "a name starts with a letter, then letters, digits and '-', with no '--' and no '-' at the end";

export const HostId = Schema.String.check(
  Schema.isPattern(hostIdPattern, { message: hostIdRule })
);

/** Unique per host and per resource type. */
export const Name = Schema.String.check(
  Schema.isPattern(namePattern, { message: nameRule })
);

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

/** `<host>_<name>`: neither part contains `_`, so an ID has exactly one. */
export const Id = Schema.String.check(
  Schema.makeFilter((id: string) => describeId(id) ?? true)
);

export const parseId = (id: string): Effect.Effect<IdParts, Invalid> => {
  const problem = describeId(id);

  if (problem !== undefined) {
    return Effect.fail(new Invalid({ message: problem }));
  }

  const at = id.indexOf(separator);

  return Effect.succeed({ host: id.slice(0, at), name: id.slice(at + 1) });
};

export const parseName = (name: string): Effect.Effect<string, Invalid> =>
  namePattern.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new Invalid({ message: `name ${JSON.stringify(name)}: ${nameRule}` })
      );

/** Checks both parts and the whole. */
export const formatId = (
  host: string,
  name: string
): Effect.Effect<string, Invalid> => {
  if (!hostIdPattern.test(host)) {
    return Effect.fail(
      new Invalid({ message: `host ID ${JSON.stringify(host)}: ${hostIdRule}` })
    );
  }

  const id = `${host}${separator}${name}`;

  return parseName(name).pipe(Effect.andThen(parseId(id)), Effect.as(id));
};
