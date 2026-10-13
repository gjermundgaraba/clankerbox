import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { loadProfile, Profile, specRequest } from "../src/index.ts";

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

test("a profile's setup needs its path, and may leave its timeout to the host", () => {
  expect(decode({ ...sizes, setup: { path: "recipe" } })._tag).toBe("Success");
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

test("a profile with an unknown key, or setup without its path, is InvalidFile", async () => {
  const dir = await profileDir();

  await writeFile(join(dir, "typo.json"), JSON.stringify({ ...sizes, ram: 4096 }));
  await writeFile(
    join(dir, "half.json"),
    JSON.stringify({ ...sizes, setup: { timeoutSeconds: 60 } }),
  );

  expect((await loadError(join(dir, "typo.json")))._tag).toBe("InvalidFile");
  expect((await loadError(join(dir, "half.json")))._tag).toBe("InvalidFile");
});

const request = (...args: Parameters<typeof specRequest>) =>
  specRequest(...args).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

const refusal = (...args: Parameters<typeof specRequest>) =>
  specRequest(...args).pipe(Effect.flip, Effect.provide(NodeServices.layer), Effect.runPromise);

test("a create of a profile asks for its fields, its setup read with its timeout, and its host", async () => {
  const dir = await profileDir();

  await writeFile(join(dir, "setup.sh"), "#!/bin/sh\necho hi\n");

  const profile = {
    ...sizes,
    label: "dev",
    setup: { path: join(dir, "setup.sh"), timeoutSeconds: 600 },
    host: "linux",
  };

  expect(await request("create", profile, {})).toEqual({
    spec: {
      ...sizes,
      profile: "dev",
      setup: { script: "#!/bin/sh\necho hi\n", timeoutSeconds: 600 },
    },
    host: "linux",
  });

  expect(
    await request("create", profile, { cpu: 4, setupTimeoutSeconds: 60, host: "mac" }),
  ).toEqual({
    spec: {
      ...sizes,
      cpu: 4,
      profile: "dev",
      setup: { script: "#!/bin/sh\necho hi\n", timeoutSeconds: 60 },
    },
    host: "mac",
  });
});

test("a create refuses a field nobody gives, and a setup timeout with no setup, naming each as told", async () => {
  const names = new Map<PropertyKey, string>([
    ["cpu", "--cpu"],
    ["setupTimeoutSeconds", "--setup-timeout"],
  ]);

  const missing = await refusal("create", undefined, { base: "ubuntu" }, names);

  const untimed = await refusal(
    "create",
    { ...sizes, label: "dev" },
    { setupTimeoutSeconds: 60 },
    names,
  );

  expect(missing.message).toBe("create: --cpu: missing; ramMib: missing; diskGib: missing");
  expect(untimed.message).toBe("create: --setup-timeout needs a setup to time");
});
