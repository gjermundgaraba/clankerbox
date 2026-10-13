import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { type StubHost } from "@gjermundgaraba/clankerbox-sdk/testing";
import {
  cleanup,
  cli,
  type CliOptions,
  hostIn,
  scratch,
  sizes,
  writeConfig,
  writeProfiles,
} from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

const host = hostIn(stubs);

test("prebuild captures a profile's setup, and a create of the profile then restores it", async () => {
  const dir = await scratch(owned);
  const profiles = await writeProfiles(dir);
  const config = await writeConfig(dir, ["linux"], "profiles");
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const endpoints: CliOptions["endpoints"] = [["linux", linux]];

  await writeFile(
    join(profiles, "dev.json"),
    JSON.stringify({
      base: "ubuntu",
      cpu: 2,
      ramMib: 4096,
      diskGib: 20,
      setup: { path: "dev-recipe" },
    }),
  );

  const built = await cli(["prebuild", "--profile", "dev", "--config", config], { endpoints });

  expect(built.code).toBe(0);
  expect(built.stdout).toMatch(/^linux_prebuilt-[0-9a-f]{12}$/u);
  expect(built.stderr).toBe("");

  const again = await cli(["prebuild", "--profile", "dev", "--config", config], { endpoints });

  expect(again.code).toBe(0);
  expect(again.stdout).toBe(built.stdout);
  expect(again.stderr).toMatch(
    new RegExp(
      `^clankerbox: ${built.stdout} was already prebuilt, \\d+[smhd] ago; delete it to prebuild again$`,
      "u",
    ),
  );
  expect(linux.creates).toHaveLength(1);

  const listed = await cli(["checkpoint", "list", "--config", config], { endpoints });

  expect(listed.stdout).toMatch(/PROFILE/u);
  expect(listed.stdout).toMatch(
    new RegExp(`${built.stdout}\\s+disk\\s+linux_prebuilding-\\S+\\s+ubuntu\\s+dev\\s`, "u"),
  );

  const restored = await cli(["create", "box", "--profile", "dev", "--config", config], {
    endpoints,
  });

  expect(restored.code).toBe(0);
  expect(restored.stdout).toBe("linux_box");
  expect(restored.stderr).toMatch(
    new RegExp(
      `^clankerbox: restored from the prebuild ${built.stdout}, made \\d+[smhd] ago$`,
      "u",
    ),
  );
  expect(linux.creates).toHaveLength(1);

  // Other sizes are another spec, and --fresh runs the setup whatever the host has.
  for (const flags of [["--ram", "8G"], ["--fresh"]]) {
    const before = linux.creates.length;

    const fresh = await cli(
      ["create", `box${before}`, "--profile", "dev", ...flags, "--config", config],
      { endpoints },
    );

    expect(fresh.code).toBe(0);
    expect(fresh.stderr).toBe("");
    expect(linux.creates).toHaveLength(before + 1);
  }
});

test("prebuild exits 0 when its builder can't be deleted, and names the builder on stderr", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const script = join(dir, "setup.sh");

  await writeFile(script, "#!/bin/sh\ntrue\n");

  const linux = host({
    id: "linux",
    bases: ["ubuntu"],
    deleteMachine: () => Effect.fail(new Internal({ message: "no answer" })),
  });

  const { code, stdout, stderr } = await cli(
    ["prebuild", ...sizes, "--setup", script, "--config", config],
    { endpoints: [["linux", linux]] },
  );

  expect(code).toBe(0);
  expect(stdout).toMatch(/^linux_prebuilt-[0-9a-f]{12}$/u);
  expect(stderr).toMatch(
    new RegExp(
      `^clankerbox: ${stdout} is prebuilt, but its builder linux_prebuilding-[0-9a-f]{16} couldn't be deleted, and may still run: delete it$`,
      "u",
    ),
  );
});

test("prebuild names itself in a refusal of its spec", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code, stderr } = await cli(["prebuild", "--base", "ubuntu", "--config", config], {
    endpoints: [["linux", linux]],
  });

  expect(code).toBe(1);
  expect(stderr).toBe(
    "clankerbox: Invalid: prebuild: --cpu: missing; --ram: missing; --disk: missing",
  );
  expect(linux.calls).toEqual([]);
});

test("prebuild needs a setup", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code, stderr } = await cli(["prebuild", ...sizes, "--config", config], {
    endpoints: [["linux", linux]],
  });

  expect(code).toBe(1);
  expect(stderr).toBe(
    "clankerbox: Invalid: prebuild needs a setup: pass --setup, or a profile that has one",
  );
  expect(linux.calls).toEqual([]);
});
