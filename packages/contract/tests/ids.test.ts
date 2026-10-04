import { Effect, Exit, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { formatId, Id, isId, parseId } from "../src/index.ts";

const parse = (id: string) => Effect.runSyncExit(parseId(id));

test("an ID splits at its first '_'", () => {
  expect(Effect.runSync(parseId("linux_dev"))).toEqual({ host: "linux", name: "dev" });
  expect(Effect.runSync(parseId("linux_dev_2"))).toEqual({ host: "linux", name: "dev_2" });
  expect(Effect.runSync(parseId("boat-1_a-b"))).toEqual({ host: "boat-1", name: "a-b" });
});

test("an ID is refused without a host, a name, or a name that starts with a letter", () => {
  for (const id of ["", "linux", "_dev", "linux_", "linux_2dev", "linux__dev", "linux_-dev"]) {
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

test("the Id schema accepts exactly what parseId accepts", () => {
  const isValid = Schema.is(Id);

  for (const id of ["linux_dev", "linux", "linux_2dev", `h_${"a".repeat(61)}`, "a_b"]) {
    expect(isValid(id), id).toBe(Exit.isSuccess(parse(id)));
  }
});

test("a create target with '_' is a full ID, and one without is a name", () => {
  expect(isId("linux_dev")).toBe(true);
  expect(isId("dev")).toBe(false);
});
