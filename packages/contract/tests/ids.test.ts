import { Effect, Exit, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { formatId, Id, isId, Name, parseId, parseName } from "../src/index.ts";

const parse = (id: string) => Effect.runSyncExit(parseId(id));

test("an ID splits at its first '_'", () => {
  expect(Effect.runSync(parseId("linux_dev"))).toEqual({ host: "linux", name: "dev" });
  expect(Effect.runSync(parseId("linux_dev_2"))).toEqual({ host: "linux", name: "dev_2" });
  expect(Effect.runSync(parseId("boat-1_a-b"))).toEqual({ host: "boat-1", name: "a-b" });
});

test("an ID is refused without a host, a name, or a valid name", () => {
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
  ]) {
    expect(Exit.isFailure(parse(id)), id).toBe(true);
  }
});

test("an ID is at most 62 characters of [A-Za-z0-9_-]", () => {
  const longest = `h_${"a".repeat(60)}`;

  expect(longest).toHaveLength(62);
  expect(Exit.isSuccess(parse(longest))).toBe(true);
  expect(Exit.isFailure(parse(`${longest}a`))).toBe(true);
  expect(Exit.isFailure(parse("linux_dév"))).toBe(true);
  expect(Exit.isFailure(parse("linux_d.v"))).toBe(true);
  expect(Exit.isFailure(parse("linux_d v"))).toBe(true);
});

test("a refused ID fails with Invalid", () => {
  const error = Effect.runSync(Effect.flip(parseId("linux")));

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain("<host>_<name>");
});

test("formatting checks the host, the name and the whole ID", () => {
  expect(Effect.runSync(formatId("mac", "xcode"))).toBe("mac_xcode");

  for (const [host, name] of [
    ["li_nux", "dev"],
    ["", "dev"],
    ["linux", "2dev"],
    ["linux", ""],
    ["linux", "a".repeat(57)],
  ] as const) {
    expect(Exit.isFailure(Effect.runSyncExit(formatId(host, name))), `${host} ${name}`).toBe(true);
  }
});

test("formatting and parsing round-trip", () => {
  const id = Effect.runSync(formatId("linux", "dev_box"));

  expect(Effect.runSync(parseId(id))).toEqual({ host: "linux", name: "dev_box" });
});

test("the Id schema accepts full IDs and refuses the rest", () => {
  const isValid = Schema.is(Id);

  for (const id of ["linux_dev", "a_b", "mac_dev_2", `h_${"a".repeat(60)}`]) {
    expect(isValid(id), id).toBe(true);
  }

  for (const id of ["linux", "linux_2dev", "linux_a--b", `h_${"a".repeat(61)}`]) {
    expect(isValid(id), id).toBe(false);
  }
});

test("a name has no '--' and doesn't end in '-'", () => {
  const isName = Schema.is(Name);

  for (const name of ["dev", "a-b", "a_b", "dev_", "a-_b", "a_-b", "A1-b2-c3"]) {
    expect(isName(name), name).toBe(true);
    expect(Exit.isSuccess(Effect.runSyncExit(parseName(name))), name).toBe(true);
  }

  for (const name of ["a--b", "box-", "2dev", "-dev", "_dev", "", "d.v"]) {
    expect(isName(name), name).toBe(false);
    expect(Exit.isFailure(Effect.runSyncExit(parseName(name))), name).toBe(true);
  }
});

/**
 * smolvm 1.22.2's `validate_vm_name` (src/data/mod.rs:58-98): at most 128 characters,
 * starting with a letter or digit, of letters, digits, '_' and '-', with no consecutive
 * hyphens and no hyphen at the end.
 */
const smolvmAccepts = (name: string): boolean =>
  name.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name) &&
  !name.includes("--") &&
  !name.endsWith("-");

test("smolvm accepts <name>-<inst> for valid names, and would refuse the names Name rules out", () => {
  const instance = "0f3a9c1e";
  const isName = Schema.is(Name);

  for (const name of ["dev", "a-b", "a_b", "dev_", "a-_b", "Dev-2", "a".repeat(60)]) {
    expect(isName(name), name).toBe(true);
    expect(smolvmAccepts(`${name}-${instance}`), name).toBe(true);
  }

  for (const name of ["a--b", "box-"]) {
    expect(isName(name), name).toBe(false);
    expect(smolvmAccepts(`${name}-${instance}`), name).toBe(false);
  }
});

test("a create target with '_' is a full ID, and one without is a name", () => {
  expect(isId("linux_dev")).toBe(true);
  expect(isId("dev")).toBe(false);
});
