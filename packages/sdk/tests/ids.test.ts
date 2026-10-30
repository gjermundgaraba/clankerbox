import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { describe, expect } from "vite-plus/test";

import { HostId, Name, parseName } from "../src/index.ts";

// https://github.com/smol-machines/smolvm/blob/v1.32.1/src/data/mod.rs#L58
const smolvmAccepts = (name: string): boolean =>
  name.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name) &&
  !name.includes("--") &&
  !name.endsWith("-");

describe("ids", () => {
  it("a host ID is a lowercase letter, then up to 31 lowercase letters, digits and '-'", () => {
    const isHostId = Schema.is(HostId);

    for (const host of ["linux", "linux-2", "h", "h".repeat(32)]) {
      expect(isHostId(host), host).toBe(true);
    }

    for (const host of [
      "",
      "Linux",
      "1linux",
      "-linux",
      "li_nux",
      "h".repeat(33),
    ]) {
      expect(isHostId(host), host).toBe(false);
    }
  });

  it.effect("a name has no '_', no '--' and doesn't end in '-'", () =>
    Effect.gen(function* () {
      const isName = Schema.is(Name);

      for (const name of ["dev", "a-b", "Dev2", "A1-b2-c3"]) {
        expect(isName(name), name).toBe(true);
        expect(Exit.isSuccess(yield* Effect.exit(parseName(name))), name).toBe(
          true
        );
      }

      for (const name of [
        "a--b",
        "box-",
        "2dev",
        "-dev",
        "_dev",
        "a_b",
        "dev_",
        "",
        "d.v",
      ]) {
        expect(isName(name), name).toBe(false);
        expect(Exit.isFailure(yield* Effect.exit(parseName(name))), name).toBe(
          true
        );
      }
    })
  );

  it("a name is at most 62 characters", () => {
    const isName = Schema.is(Name);

    expect(isName("a".repeat(62))).toBe(true);
    expect(isName("a".repeat(63))).toBe(false);
  });

  it.effect("a refused name fails with Invalid, naming it and the rule", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseName("2dev"));

      expect(error._tag).toBe("Invalid");
      expect(error.message).toContain('name "2dev"');
      expect(error.message).toContain("starts with a letter");
    })
  );

  it("smolvm accepts <name>-<inst> for valid names, and would refuse the names Name rules out", () => {
    const instance = "0f3a9c1e";
    const isName = Schema.is(Name);

    for (const name of ["dev", "a-b", "Dev-2", "a".repeat(62)]) {
      expect(isName(name), name).toBe(true);
      expect(smolvmAccepts(`${name}-${instance}`), name).toBe(true);
    }

    for (const name of ["a--b", "box-"]) {
      expect(isName(name), name).toBe(false);
      expect(smolvmAccepts(`${name}-${instance}`), name).toBe(false);
    }
  });
});
