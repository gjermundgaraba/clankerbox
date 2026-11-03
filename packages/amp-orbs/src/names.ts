import { createHash } from "node:crypto";

import { Name } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";

const isName = (id: string): boolean => Schema.is(Name)(id);

const maxLength = 62;

const digestLength = 8;

/**
 * The clankerbox name for an Amp ID: the ID itself when it is one, such as `amp-T-…`; otherwise one
 * derived from it, its letters and digits with each other run as one `-`, cut to fit, then `-` and
 * eight hex digits of its SHA-256, so no two IDs share a name.
 */
export const nameFor = (id: string): string => {
  if (isName(id)) {
    return id;
  }

  const digest = createHash("sha256")
    .update(id)
    .digest("hex")
    .slice(0, digestLength);

  const plain = id
    .replaceAll(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");

  const head = (/^[A-Za-z]/u.test(plain) ? plain : `amp-${plain}`)
    .slice(0, maxLength - digestLength - 1)
    .replace(/-+$/u, "");

  return `${head}-${digest}`;
};
