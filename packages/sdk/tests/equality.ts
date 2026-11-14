import { expect } from "vite-plus/test";

const tagged = (value: unknown): value is Error & { readonly _tag: unknown } =>
  value instanceof Error && "_tag" in value;

/**
 * Tells two tagged errors apart by their messages, which every package's tests register as a setup
 * file. An Effect error is iterable, so vitest compares two by their enumerable fields alone, and
 * `message` isn't one: without this, an assertion that two errors are equal passes whatever each
 * says.
 */
export const messagesCompared = (a: unknown, b: unknown): false | undefined =>
  tagged(a) && tagged(b) && a.message !== b.message ? false : undefined;

expect.addEqualityTesters([messagesCompared]);
