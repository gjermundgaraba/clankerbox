import { Schema } from "effect";
import { Hex } from "effect/encoding";

const hostIdPattern = /^[a-z][a-z0-9-]{0,31}$/u;

const hostIdRule =
  "a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter";

export const maxNameLength = 62;

const namePattern = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;

const nameRule = `a name is 1 to ${maxNameLength} characters: it starts with a letter, then letters, digits and '-', with no '--' and no '-' at the end`;

const isName = (name: string): boolean =>
  name.length <= maxNameLength && namePattern.test(name);

/** A runtime's name, as its host's config and its registry entry give it. */
export const RuntimeName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u, {
    message:
      "a runtime's name is 1 to 32 lowercase letters, digits and '-', starting with a letter",
  })
).pipe(Schema.brand("RuntimeName"));

export type RuntimeName = typeof RuntimeName.Type;

export const HostId = Schema.String.check(
  Schema.isPattern(hostIdPattern, { message: hostIdRule })
);

/** Unique per resource type, across every host. A machine's ID is its name. */
export const Name = Schema.String.check(
  Schema.makeFilter((name: string) => isName(name) || nameRule)
);

export const copyPrefixes = { built: "built-", fetched: "fetched-" } as const;

const prefixes = Object.values(copyPrefixes);

const copyDigits = 16;

const buildCopyPattern = new RegExp(
  `^(?:${prefixes.join("|")})[0-9a-f]{${copyDigits}}$`,
  "u"
);

/** A new name for a template build's copy, made on the build's host or fetched to another. */
export const buildCopyName = (kind: keyof typeof copyPrefixes): string =>
  `${copyPrefixes[kind]}${Hex.encode(
    globalThis.crypto.getRandomValues(new Uint8Array(copyDigits / 2))
  )}`;

export const isBuildCopy = (name: string): boolean =>
  buildCopyPattern.test(name);

// smolvm takes a VM whose name begins so for a builder of its own, and a smolvm host names a
// machine's VM `<name>-<instance>`, so the bare word is taken too. Every runtime refuses them, so
// such a name is refused before its row is recorded and a name means the same on every host:
// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/image_seed.rs#L1263-L1277
const builderWords = ["image-seed", "init-bake"];

/** A name a client gives a new machine, which is never smolvm's builders'. */
export const MachineName = Name.check(
  Schema.makeFilter(
    (name: string) =>
      !builderWords.some(
        (word) => name === word || name.startsWith(`${word}-`)
      ) ||
      `a machine's name isn't ${builderWords.join(" or ")} and doesn't begin ${builderWords.map((word) => `${word}-`).join(" or ")}, which smolvm takes for its own builders`
  )
);

/** A name a client gives a checkpoint, which never begins as a build's copy does. */
export const CheckpointName = Name.check(
  Schema.makeFilter(
    (name: string) =>
      !prefixes.some((prefix) => name.startsWith(prefix)) ||
      `a checkpoint's name doesn't begin ${prefixes.join(" or ")}, which name template builds' copies`
  )
);
