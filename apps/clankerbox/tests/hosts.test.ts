import { afterEach, expect, test } from "vite-plus/test";
import { type StubHost } from "@gjermundgaraba/clankerbox-sdk/testing";
import { cleanup, cli, type CliOptions, hostIn, scratch, writeConfig } from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

const host = hostIn(stubs);

test("hosts lists every host with its bases", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"]);

  const { code, stdout } = await cli(["hosts", "--config", config], {
    endpoints: [
      ["linux", host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] })],
      ["mac", host({ id: "mac", bases: ["tahoe"], runtime: "tart" })],
    ],
  });

  expect(code).toBe(0);
  expect(stdout).toContain("ubuntu,ubuntu-dev");
  expect(stdout).toContain("tahoe");
});

test("capacity lists every host's limits, one a row, and names a host that didn't answer", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac", "boat"]);

  const endpoints: CliOptions["endpoints"] = [
    [
      "linux",
      host({
        id: "linux",
        bases: ["ubuntu"],
        capacity: [{ resource: "ramMib", limit: 14_336, used: 3072 }],
      }),
    ],
    ["mac", "down"],
    [
      "boat",
      host({
        id: "boat",
        bases: ["boat"],
        runtime: "boat",
        capacity: [
          { resource: "activeSandboxes", limit: 2, used: 1 },
          { resource: "startsPerDay", limit: 75, used: 12 },
        ],
      }),
    ],
  ];

  const { code, stdout, stderr } = await cli(["capacity", "--config", config], { endpoints });
  const json = await cli(["capacity", "--json", "--config", config], { endpoints });

  expect(code).toBe(0);
  expect(
    stdout
      .trim()
      .split("\n")
      .map((row) => row.split(/\s+/u)),
  ).toEqual([
    ["HOST", "RESOURCE", "USED", "LIMIT"],
    ["linux", "ram", "3G", "14G"],
    ["boat", "active-sandboxes", "1", "2"],
    ["boat", "starts/day", "12", "75"],
  ]);
  expect(stderr).toContain("mac");
  expect(JSON.parse(json.stdout)).toMatchObject({
    capacity: [
      { host: "linux", resource: "ramMib", limit: 14_336, used: 3072 },
      { host: "boat", resource: "activeSandboxes", limit: 2, used: 1 },
      { host: "boat", resource: "startsPerDay", limit: 75, used: 12 },
    ],
    unreachable: [{ host: "mac" }],
  });
});
