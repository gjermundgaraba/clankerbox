import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { loadProfile, Profile } from "../src/index.ts";

const temporary: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const decode = Schema.decodeUnknownResult(Profile);

const sizes = { base: "ubuntu", cpu: 2, ramMib: 4096, diskGib: 20 };

test("a profile decodes with or without setup", () => {
  expect(decode(sizes)._tag).toBe("Success");
  expect(
    decode({ ...sizes, setup: { path: "recipe", timeoutSeconds: 600 }, host: "linux" })._tag,
  ).toBe("Success");
});

test("a profile's setup comes with its timeout", () => {
  expect(decode({ ...sizes, setup: { path: "recipe" } })._tag).toBe("Failure");
  expect(decode({ ...sizes, setup: { timeoutSeconds: 600 } })._tag).toBe("Failure");
});

test("a profile's host is a host ID", () => {
  expect(decode({ ...sizes, host: "li_nux" })._tag).toBe("Failure");
});

const profileDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-profile-"));

  temporary.push(dir);

  return dir;
};

const load = (file: string) =>
  loadProfile(file).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

const loadError = (file: string) =>
  loadProfile(file).pipe(Effect.flip, Effect.provide(NodeServices.layer), Effect.runPromise);

test("a profile file's name is the label, and its setup path is resolved against the file", async () => {
  const dir = await profileDir();

  await writeFile(
    join(dir, "dev.json"),
    JSON.stringify({
      ...sizes,
      setup: { path: "scripts/dev.sh", timeoutSeconds: 300 },
      host: "mac",
    }),
  );

  const profile = await load(join(dir, "dev.json"));

  expect(profile).toEqual({
    ...sizes,
    setup: { path: join(dir, "scripts", "dev.sh"), timeoutSeconds: 300 },
    host: "mac",
    label: "dev",
  });
});

test("a profile without setup has no setup", async () => {
  const dir = await profileDir();

  await writeFile(join(dir, "bare.json"), JSON.stringify(sizes));

  expect(await load(join(dir, "bare.json"))).toEqual({ ...sizes, label: "bare" });
});

test("a profile with an unknown key, or setup without its timeout, is Invalid", async () => {
  const dir = await profileDir();

  await writeFile(join(dir, "typo.json"), JSON.stringify({ ...sizes, ram: 4096 }));
  await writeFile(join(dir, "half.json"), JSON.stringify({ ...sizes, setup: { path: "x.sh" } }));

  expect((await loadError(join(dir, "typo.json")))._tag).toBe("Invalid");
  expect((await loadError(join(dir, "half.json")))._tag).toBe("Invalid");
});
