import { expect } from "vite-plus/test";

const tagged = (value: unknown): value is Error & { readonly _tag: unknown } =>
  value instanceof Error && "_tag" in value;

export const messagesCompared = (a: unknown, b: unknown): false | undefined =>
  tagged(a) && tagged(b) && a.message !== b.message ? false : undefined;

expect.addEqualityTesters([messagesCompared]);
