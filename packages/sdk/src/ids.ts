import { Schema } from "effect";

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

/** How the control plane begins the name of a template build's copy, made or fetched. */
export const copyPrefixes = { built: "built-", fetched: "fetched-" } as const;

const prefixes = Object.values(copyPrefixes);

const buildCopyPattern = new RegExp(
  `^(?:${prefixes.join("|")})[0-9a-f]{16}$`,
  "u"
);

/** Whether a checkpoint's name is one the control plane mints for a template build's copy. */
export const isBuildCopy = (name: string): boolean =>
  buildCopyPattern.test(name);

/** A name a client gives a checkpoint, which never begins as a build's copy does. */
export const CheckpointName = Name.check(
  Schema.makeFilter(
    (name: string) =>
      !prefixes.some((prefix) => name.startsWith(prefix)) ||
      `a checkpoint's name doesn't begin ${prefixes.join(" or ")}, which name template builds' copies`
  )
);
