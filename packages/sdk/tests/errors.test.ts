import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf } from "vite-plus/test";

import {
  Capacity,
  Conflict,
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
import type { ClankerboxError, Desired } from "../src/index.ts";
import { machine } from "./stub-host.ts";

const failed = (error: ClankerboxError) => ({
  ...machine("linux_dev"),
  phase: "failed",
  error,
});

const wire = Schema.fromJsonString(HostError);

const encode = Schema.encodeEffect(HostError);

describe("errors", () => {
  it("a request superseded names what the later one asked for: a desired state", () => {
    expectTypeOf<Superseded["by"]>().toEqualTypeOf<Desired>();
  });

  it("retryable follows the tag", () => {
    const message = "m";

    expect(retryable(new Invalid({ message }))).toBe(false);
    expect(retryable(new NotFound({ message }))).toBe(false);
    expect(retryable(new NotOffered({ message, base: "fedora" }))).toBe(false);
    expect(retryable(new Capacity({ message }))).toBe(true);
    expect(retryable(new Internal({ message }))).toBe(false);
  });

  it("a taken name and a superseded request are not retryable", () => {
    expect(retryable(new Conflict({ message: "m" }))).toBe(false);
    expect(retryable(new Superseded({ message: "m", by: "stopped" }))).toBe(
      false
    );
  });

  it("Unavailable is retryable for a read and not for a mutation", () => {
    expect(retryable(new Unavailable({ message: "m", readOnly: true }))).toBe(
      true
    );
    expect(retryable(new Unavailable({ message: "m", readOnly: false }))).toBe(
      false
    );
  });

  it("a machine's last error is a host error, never Unavailable", () => {
    const isMachine = Schema.is(Machine);

    expect(isMachine(failed(new Capacity({ message: "" })))).toBe(true);
    expect(
      isMachine(failed(new Unavailable({ message: "", readOnly: false })))
    ).toBe(false);
  });

  it.effect.prop(
    "every host error survives the wire and a row's JSON with each of its fields",
    { error: HostError },
    ({ error }) =>
      Effect.gen(function* () {
        const sent = yield* Schema.encodeEffect(wire)(error);
        const received = yield* Schema.decodeEffect(wire)(sent);

        expect(received).toBeInstanceOf(error.constructor);
        expect(yield* encode(received)).toStrictEqual(yield* encode(error));
      })
  );
});
