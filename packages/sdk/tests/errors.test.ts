import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf } from "vite-plus/test";

import {
  Capacity,
  ClankerboxError,
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
import type { Desired } from "../src/index.ts";
import { machine } from "./stub-server.ts";

const failed = (error: ClankerboxError) => ({
  ...machine("dev"),
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

  it("Superseded is the client's own answer: no row's error is one, and every call may fail with it", () => {
    const superseded = new Superseded({ message: "m", by: "stopped" });

    expect(Schema.is(Machine)(failed(superseded))).toBe(false);
    expect(Schema.is(ClankerboxError)(superseded)).toBe(true);
  });

  it("a machine's last error can be any error a step ends with, Unavailable included", () => {
    const isMachine = Schema.is(Machine);

    expect(isMachine(failed(new Capacity({ message: "" })))).toBe(true);
    expect(
      isMachine(failed(new Unavailable({ message: "", readOnly: false })))
    ).toBe(true);
  });

  it("located keeps what an error already names and adds what it doesn't", () => {
    const error = new NotFound({ message: "m", id: "dev" });

    expect(
      error.located({ action: "getMachine", id: "other", made: "new" })
    ).toMatchObject({ action: "getMachine", id: "dev", made: "new" });
  });

  it("located keeps an error's own fields", () => {
    const error = new Unavailable({ message: "m", readOnly: true });

    expect(error.located({ action: "getMachine" })).toMatchObject({
      message: "m",
      readOnly: true,
      action: "getMachine",
    });
    expect(error.located({})).not.toHaveProperty("id");
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
