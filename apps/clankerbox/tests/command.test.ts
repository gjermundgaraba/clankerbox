import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import type { StubHost } from "../../../packages/sdk/tests/stub-host.ts";
import {
  cleanup,
  cli,
  type CliOptions,
  decodeJsonError,
  hostIn,
  scratch,
  sizes,
  writeConfig,
} from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

const host = hostIn(stubs);

test("a list exits 1 when every host failed, still naming each one", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"]);

  for (const command of [["machines"], ["hosts"], ["checkpoint", "list"]]) {
    const { code, stdout, stderr } = await cli([...command, "--config", config], {
      endpoints: [
        ["linux", "down"],
        ["mac", "down"],
      ],
    });

    const json = await cli([...command, "--json", "--config", config], {
      endpoints: [
        ["linux", "down"],
        ["mac", "down"],
      ],
    });

    expect(code, command.join(" ")).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("clankerbox: no ");
    expect(stderr).toContain("linux");
    expect(stderr).toContain("mac");
    expect(json.code, command.join(" ")).toBe(1);
    expect(json.stdout).toContain('"unreachable":[{"host":"linux"');
  }
});

test("with --json an error prints {error: {message, tag, retryable}} and exits 1", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const { code, stdout } = await cli(
    [
      "create",
      "dev",
      "--base",
      "fedora",
      "--cpu",
      "1",
      "--ram",
      "1M",
      "--disk",
      "1G",
      "--json",
      "--config",
      config,
    ],
    { endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]] },
  );

  const { error } = decodeJsonError(stdout);

  expect(code).toBe(1);
  expect(error.tag).toBe("Precondition");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("linux offers ubuntu");
});

test("with --json a usage error is effect/cli's usual output, and exits 1", async () => {
  const missing = await cli(["start", "--json"]);
  const malformed = await cli(["create", "dev", "--json", ...sizes.slice(0, 2), "--cpu", "x"]);

  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("machine");
  expect(malformed.code).toBe(1);
  expect(malformed.stderr).toContain("--cpu");
});

test("with --json, --help still prints the help", async () => {
  const { code, stdout } = await cli(["machines", "--help", "--json"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox machines");
});

test("a retryable error says so in --json", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const { code, stdout } = await cli(["create", "dev", ...sizes, "--json", "--config", config], {
    endpoints: [
      [
        "linux",
        host({
          id: "linux",
          bases: ["ubuntu"],
          create: () => Effect.fail(new Capacity({ message: "RAM budget is full" })),
        }),
      ],
    ],
  });

  expect(code).toBe(1);
  expect(decodeJsonError(stdout).error).toEqual({
    message: "RAM budget is full",
    tag: "Capacity",
    retryable: true,
  });
});

test("without --json an error goes to stderr with its tag", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const { code, stdout, stderr } = await cli(["start", "mac_dev", "--config", config], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
  });

  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("Invalid");
});

test("--timeout stops waiting, says the action may have run, and exits 1", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"], create: () => Effect.never });
  const endpoints = [["linux", linux]] as const;

  const text = await cli(["create", "dev", ...sizes, "--timeout", "1s", "--config", config], {
    endpoints,
  });

  const json = await cli(
    ["create", "slow", ...sizes, "--timeout", "1s", "--json", "--config", config],
    { endpoints },
  );

  expect(text.code).toBe(1);
  expect(text.stderr).toContain("may have run: read linux_dev to see");
  expect(json.code).toBe(1);
  expect(decodeJsonError(json.stdout).error).toMatchObject({
    tag: "Unavailable",
    retryable: false,
  });
  expect(linux.creates).toHaveLength(2);
});

test("a read takes no --timeout", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code } = await cli(["machines", "--timeout", "1s", "--config", config], {
    endpoints: [["linux", linux]],
  });

  expect(code).toBe(1);
  expect(linux.calls).toEqual([]);
});

test("a list with nothing in it prints no table and says so on stderr", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"], "profiles");

  await mkdir(join(dir, "profiles"));

  const endpoints: CliOptions["endpoints"] = [
    ["linux", host({ id: "linux", bases: ["ubuntu"] })],
    ["mac", "down"],
  ];

  const machines = await cli(["machines", "--config", config], { endpoints });
  const json = await cli(["machines", "--json", "--config", config], { endpoints });
  const profiles = await cli(["profiles", "--config", config]);

  expect(machines).toMatchObject({ code: 0, stdout: "" });
  expect(machines.stderr.split("\n")[0]).toBe("clankerbox: no machines to list");
  expect(machines.stderr).toContain("Unavailable: host mac");
  expect(JSON.parse(json.stdout)).toMatchObject({ machines: [] });
  expect(profiles).toMatchObject({
    code: 0,
    stdout: "",
    stderr: `clankerbox: no profiles in ${join(dir, "profiles")}`,
  });
});

test("a host URL with a trailing slash still reaches its routes", async () => {
  const dir = await scratch(owned);
  const config = join(dir, "config.json");

  await writeFile(config, JSON.stringify({ hosts: [{ id: "linux", url: "http://linux.test/" }] }));

  const { code, stdout } = await cli(["hosts", "--config", config], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
  });

  expect(code).toBe(0);
  expect(stdout).toContain("ubuntu");
});
