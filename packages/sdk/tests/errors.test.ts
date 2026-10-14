import { Result, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import {
  ActionRecord,
  Capacity,
  Conflict,
  Internal,
  Invalid,
  NotFound,
  Precondition,
  retryable,
  Unavailable,
} from "../src/index.ts";

test("retryable follows the tag", () => {
  const message = "m";

  expect(retryable(new Invalid({ message }))).toBe(false);
  expect(retryable(new NotFound({ message }))).toBe(false);
  expect(retryable(new Precondition({ message }))).toBe(false);
  expect(retryable(new Capacity({ message }))).toBe(true);
  expect(retryable(new Internal({ message }))).toBe(false);
});

test("a busy conflict is retryable and a name that exists is not", () => {
  expect(retryable(new Conflict({ message: "m", kind: "busy" }))).toBe(true);
  expect(retryable(new Conflict({ message: "m", kind: "exists" }))).toBe(false);
});

test("Unavailable is retryable for a read and not for a mutation", () => {
  expect(retryable(new Unavailable({ message: "m", readOnly: true }))).toBe(true);
  expect(retryable(new Unavailable({ message: "m", readOnly: false }))).toBe(false);
});

test("a recorded action's error is a host error, never Unavailable", () => {
  const isRecord = Schema.is(ActionRecord);

  const failed = (tag: string) => ({
    name: "createMachine",
    status: "failed",
    error: { tag, message: "" },
  });

  expect(isRecord(failed("Capacity"))).toBe(true);
  expect(isRecord(failed("Unavailable"))).toBe(false);
});

test("a recorded action carries an error exactly when it failed", () => {
  const decodes = (record: Record<string, string | Record<string, string>>) =>
    Result.isSuccess(
      Schema.decodeUnknownResult(ActionRecord)(record, { onExcessProperty: "error" }),
    );

  const error = { tag: "Internal", message: "m" };

  expect(decodes({ name: "createMachine", status: "done" })).toBe(true);
  expect(decodes({ name: "createMachine", status: "failed", error })).toBe(true);
  expect(decodes({ name: "createMachine", status: "failed" })).toBe(false);
  expect(decodes({ name: "createMachine", status: "done", error })).toBe(false);
});
