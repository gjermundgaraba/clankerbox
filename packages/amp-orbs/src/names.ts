import { createHash } from "node:crypto";

import { maxNameLength, Name } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";

const isName = (id: string): boolean => Schema.is(Name)(id);

const digestLength = 8;

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
    .slice(0, maxNameLength - digestLength - 1)
    .replace(/-+$/u, "");

  return `${head}-${digest}`;
};
