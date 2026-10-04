import { expect, test } from "vite-plus/test";
import {
  Capacity,
  Conflict,
  Internal,
  Invalid,
  NotFound,
  Precondition,
  Unavailable,
} from "../src/index.ts";

test("retryable follows the tag", () => {
  const message = "m";

  expect(new Invalid({ message }).retryable).toBe(false);
  expect(new NotFound({ message }).retryable).toBe(false);
  expect(new Precondition({ message }).retryable).toBe(false);
  expect(new Capacity({ message }).retryable).toBe(true);
  expect(new Internal({ message }).retryable).toBe(false);
});

test("a busy conflict is retryable and a name that exists is not", () => {
  expect(new Conflict({ message: "m", kind: "busy" }).retryable).toBe(true);
  expect(new Conflict({ message: "m", kind: "exists" }).retryable).toBe(false);
});

test("Unavailable is retryable for a read and not for a mutation", () => {
  expect(new Unavailable({ message: "m", access: "read" }).retryable).toBe(true);
  expect(new Unavailable({ message: "m", access: "write" }).retryable).toBe(false);
});
