import { Effect, Schema } from "effect";

import { Invalid } from "./errors.ts";

const hostIdPattern = /^[a-z][a-z0-9-]{0,31}$/u;

const hostIdRule =
  "a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter";

const maxNameLength = 62;

const namePattern = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;

const nameRule = `a name is 1 to ${maxNameLength} characters: it starts with a letter, then letters, digits and '-', with no '--' and no '-' at the end`;

const isName = (name: string): boolean =>
  name.length <= maxNameLength && namePattern.test(name);

export const HostId = Schema.String.check(
  Schema.isPattern(hostIdPattern, { message: hostIdRule })
);

/** Unique per resource type, across every host. A machine's ID is its name. */
export const Name = Schema.String.check(
  Schema.makeFilter((name: string) => isName(name) || nameRule)
);

export const parseName = (name: string): Effect.Effect<string, Invalid> =>
  isName(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new Invalid({ message: `name ${JSON.stringify(name)}: ${nameRule}` })
      );
