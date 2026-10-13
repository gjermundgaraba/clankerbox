import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { type StubHost } from "../../../packages/sdk/tests/stub-host.ts";
import { cleanup, cli, decodeJsonError, scratch, writeConfig, writeProfiles } from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

test("profiles lists the profiles directory's profiles by name, without asking a host", async () => {
  const dir = await scratch(owned);

  await writeProfiles(dir);

  const config = await writeConfig(dir, ["linux"], "profiles");
  const { code, stdout } = await cli(["profiles", "--config", config]);
  const rows = stdout.split("\n").map((line) => line.split(/\s+/u));

  expect(code).toBe(0);
  expect(rows).toEqual([
    ["NAME", "BASE", "CPU", "RAM", "DISK", "SETUP", "TIMEOUT", "HOST"],
    ["dev", "ubuntu-dev", "2", "4G", "20G", "dev-recipe", "15m", "hetzner"],
    ["small", "ubuntu", "1", "1G", "10G", "-", "-", "-"],
  ]);
});

test("profiles --json carries each profile's name and fields, with its setup path resolved", async () => {
  const dir = await scratch(owned);
  const profiles = await writeProfiles(dir);
  const config = await writeConfig(dir, ["linux"], "profiles");

  const { code, stdout } = await cli(["profiles", "--json", "--config", config]);

  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    profiles: [
      {
        name: "dev",
        base: "ubuntu-dev",
        cpu: 2,
        ramMib: 4096,
        diskGib: 20,
        setup: { path: join(profiles, "dev-recipe"), timeoutSeconds: 900 },
        host: "hetzner",
      },
      { name: "small", base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 },
    ],
  });
});

test("profiles fails without a profiles directory, or on a profile that doesn't decode", async () => {
  const dir = await scratch(owned);
  const bare = await writeConfig(dir, ["linux"]);

  const unset = await cli(["profiles", "--json", "--config", bare]);

  expect(unset.code).toBe(1);
  expect(decodeJsonError(unset.stdout).error).toMatchObject({
    tag: "Invalid",
    message: expect.stringContaining("no profiles directory"),
  });

  const missing = await cli([
    "profiles",
    "--json",
    "--config",
    await writeConfig(dir, ["linux"], "absent"),
  ]);

  expect(missing.code).toBe(1);
  expect(decodeJsonError(missing.stdout).error.tag).toBe("Invalid");

  const profiles = await writeProfiles(dir);

  await writeFile(join(profiles, "broken.json"), JSON.stringify({ base: "ubuntu" }));

  const broken = await cli([
    "profiles",
    "--json",
    "--config",
    await writeConfig(dir, ["linux"], "profiles"),
  ]);

  expect(broken.code).toBe(1);
  expect(decodeJsonError(broken.stdout).error.message).toBe(
    `profile ${join(profiles, "broken.json")}: cpu: missing; ramMib: missing; diskGib: missing`,
  );
});
