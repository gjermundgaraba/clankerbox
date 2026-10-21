import { Arbitrary, Effect, Exit, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { formatId, HostId, Id, Name, parseId, parseName } from "../src/index.ts";

const parse = (id: string) => Effect.exit(parseId(id));

it.effect("an ID splits at its '_'", () =>
  Effect.gen(function* () {
    expect(yield* parseId("linux_dev")).toEqual({ host: "linux", name: "dev" });
    expect(yield* parseId("linux-2_a-b")).toEqual({ host: "linux-2", name: "a-b" });
    expect(yield* parseId("mac_Dev2")).toEqual({ host: "mac", name: "Dev2" });
  }),
);

it.effect("an ID is refused without a host, a name, or a valid name", () =>
  Effect.gen(function* () {
    for (const id of [
      "",
      "linux",
      "_dev",
      "linux_",
      "linux_2dev",
      "linux__dev",
      "linux_-dev",
      "linux_a--b",
      "linux_box-",
      "linux_dev_2",
      "Linux_dev",
      "1linux_dev",
      `${"h".repeat(33)}_dev`,
    ]) {
      expect(Exit.isFailure(yield* parse(id)), id).toBe(true);
    }
  }),
);

it.effect("an ID is at most 62 characters of [A-Za-z0-9_-]", () =>
  Effect.gen(function* () {
    const longest = `h_${"a".repeat(60)}`;

    expect(longest).toHaveLength(62);
    expect(Exit.isSuccess(yield* parse(longest))).toBe(true);
    expect(Exit.isFailure(yield* parse(`${longest}a`))).toBe(true);
    expect(Exit.isFailure(yield* parse("linux_dév"))).toBe(true);
    expect(Exit.isFailure(yield* parse("linux_d.v"))).toBe(true);
    expect(Exit.isFailure(yield* parse("linux_d v"))).toBe(true);
  }),
);

it.effect("a refused ID fails with Invalid", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(parseId("linux"));

    expect(error._tag).toBe("Invalid");
    expect(error.message).toContain("<host>_<name>");
  }),
);

it.effect("formatting checks the host, the name and the whole ID", () =>
  Effect.gen(function* () {
    expect(yield* formatId("mac", "xcode")).toBe("mac_xcode");

    for (const [host, name] of [
      ["li_nux", "dev"],
      ["Linux", "dev"],
      ["", "dev"],
      ["linux", "dev_box"],
      ["linux", "2dev"],
      ["linux", ""],
      ["linux", "a".repeat(57)],
    ] as const) {
      expect(Exit.isFailure(yield* Effect.exit(formatId(host, name))), `${host} ${name}`).toBe(
        true,
      );
    }
  }),
);

it.effect("formatting and parsing round-trip", () =>
  Effect.gen(function* () {
    const id = yield* formatId("linux", "dev-box");

    expect(yield* parseId(id)).toEqual({ host: "linux", name: "dev-box" });
  }),
);

const longName = Arbitrary.map(
  Arbitrary.all([
    Arbitrary.schema(Name),
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))),
  ]),
  ([name, padding]) => `${name}${"a".repeat(padding)}`,
);

it.effect.prop(
  "a valid host and name format into <host>_<name> exactly when it is at most 62 characters, and parse back",
  { host: HostId, name: longName },
  ({ host, name }) =>
    Effect.gen(function* () {
      const id = `${host}_${name}`;
      const formatted = yield* Effect.exit(formatId(host, name));

      if (id.length > 62) {
        expect(Exit.isFailure(formatted)).toBe(true);
      } else {
        expect(formatted).toEqual(Exit.succeed(id));
        expect(yield* parseId(id)).toEqual({ host, name });
      }
    }),
);

it("a host ID is a lowercase letter, then up to 31 lowercase letters, digits and '-'", () => {
  const isHostId = Schema.is(HostId);

  for (const host of ["linux", "linux-2", "h", "h".repeat(32)]) {
    expect(isHostId(host), host).toBe(true);
  }

  for (const host of ["", "Linux", "1linux", "-linux", "li_nux", "h".repeat(33)]) {
    expect(isHostId(host), host).toBe(false);
  }
});

it("the Id schema accepts full IDs and refuses the rest", () => {
  const isValid = Schema.is(Id);

  for (const id of ["linux_dev", "a_b", "mac_Dev-2", `h_${"a".repeat(60)}`]) {
    expect(isValid(id), id).toBe(true);
  }

  for (const id of ["linux", "linux_2dev", "linux_a--b", "mac_dev_2", `h_${"a".repeat(61)}`]) {
    expect(isValid(id), id).toBe(false);
  }
});

it.effect("a name has no '_', no '--' and doesn't end in '-'", () =>
  Effect.gen(function* () {
    const isName = Schema.is(Name);

    for (const name of ["dev", "a-b", "Dev2", "A1-b2-c3"]) {
      expect(isName(name), name).toBe(true);
      expect(Exit.isSuccess(yield* Effect.exit(parseName(name))), name).toBe(true);
    }

    for (const name of ["a--b", "box-", "2dev", "-dev", "_dev", "a_b", "dev_", "", "d.v"]) {
      expect(isName(name), name).toBe(false);
      expect(Exit.isFailure(yield* Effect.exit(parseName(name))), name).toBe(true);
    }
  }),
);

// Source: smolvm src/data/mod.rs validate_vm_name
const smolvmAccepts = (name: string): boolean =>
  name.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name) &&
  !name.includes("--") &&
  !name.endsWith("-");

it("smolvm accepts <name>-<inst> for valid names, and would refuse the names Name rules out", () => {
  const instance = "0f3a9c1e";
  const isName = Schema.is(Name);

  for (const name of ["dev", "a-b", "Dev-2", "a".repeat(60)]) {
    expect(isName(name), name).toBe(true);
    expect(smolvmAccepts(`${name}-${instance}`), name).toBe(true);
  }

  for (const name of ["a--b", "box-"]) {
    expect(isName(name), name).toBe(false);
    expect(smolvmAccepts(`${name}-${instance}`), name).toBe(false);
  }
});
