import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  Capacity,
  type ClankerboxError,
  Conflict,
  type Desired,
  HostError,
  Internal,
  Invalid,
  Machine,
  NotFound,
  NotOffered,
  retryable,
  Superseded,
  Unavailable,
} from "../src/index.ts";
import { machine } from "./stub-host.ts";

test("a request superseded names what the later one asked for: a desired state", () => {
  expectTypeOf<Superseded["by"]>().toEqualTypeOf<Desired>();
});

test("retryable follows the tag", () => {
  const message = "m";

  expect(retryable(new Invalid({ message }))).toBe(false);
  expect(retryable(new NotFound({ message }))).toBe(false);
  expect(retryable(new NotOffered({ message, base: "fedora" }))).toBe(false);
  expect(retryable(new Capacity({ message }))).toBe(true);
  expect(retryable(new Internal({ message }))).toBe(false);
});

test("a taken name and a superseded request are not retryable", () => {
  expect(retryable(new Conflict({ message: "m" }))).toBe(false);
  expect(retryable(new Superseded({ message: "m", by: "stopped" }))).toBe(false);
});

test("Unavailable is retryable for a read and not for a mutation", () => {
  expect(retryable(new Unavailable({ message: "m", readOnly: true }))).toBe(true);
  expect(retryable(new Unavailable({ message: "m", readOnly: false }))).toBe(false);
});

test("a machine's last error is a host error, never Unavailable", () => {
  const isMachine = Schema.is(Machine);

  const failed = (error: ClankerboxError) => ({ ...machine("linux_dev"), phase: "failed", error });

  expect(isMachine(failed(new Capacity({ message: "" })))).toBe(true);
  expect(isMachine(failed(new Unavailable({ message: "", readOnly: false })))).toBe(false);
});

it.effect.prop(
  "every host error survives the wire and a row's JSON with each of its fields",
  { error: HostError },
  ({ error }) =>
    Effect.sync(() => {
      const encode = Schema.encodeSync(HostError);
      const sent = JSON.parse(JSON.stringify(encode(error)));
      const received = Schema.decodeUnknownSync(HostError)(sent);

      expect(received).toBeInstanceOf(error.constructor);
      expect(encode(received)).toEqual(encode(error));
    }),
);
