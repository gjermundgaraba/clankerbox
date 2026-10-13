import { afterEach, expect, test } from "vite-plus/test";
import { type StubHost } from "../../../packages/sdk/tests/stub-host.ts";
import { cleanup, cli, hostIn, scratch, writeConfig } from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

const host = hostIn(stubs);

test("--timeout takes a duration with its units in order, and refuses a bare number or none of it", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  for (const [duration, why] of [
    ["90", "isn't a duration: write it in d, h, m and s, such as 90s or 1h30m"],
    ["30m1h", "isn't a duration: write it in d, h, m and s, such as 90s or 1h30m"],
    ["0s", "is out of range: write at least 1s"],
    ["99999999999999999999s", "is out of range: write at least 1s"],
  ] as const) {
    const { code, stderr } = await cli(
      ["start", "linux_dev", "--timeout", duration, "--config", config],
      { endpoints: [["linux", linux]] },
    );

    expect(code, duration).toBe(1);
    expect(stderr, duration).toBe(`clankerbox: Invalid: --timeout "${duration}" ${why}`);
  }

  expect(linux.calls).toEqual([]);
});

test("--ram and --disk take a size with its unit, and --disk only whole GiB", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const create = (name: string, ram: string, disk: string) =>
    cli(
      [
        "create",
        name,
        "--base",
        "ubuntu",
        "--cpu",
        "1",
        "--ram",
        ram,
        "--disk",
        disk,
        "--config",
        config,
      ],
      { endpoints: [["linux", linux]] },
    );

  const made = [
    await create("a", "512M", "10G"),
    await create("b", "1.5G", "2048M"),
    await create("c", "2GiB", "10gib"),
    await create("d", "8GB", "10Gi"),
  ];

  const refused = [
    await create("e", "4096", "10G"),
    await create("f", "1T", "10G"),
    await create("g", "1.1G", "10G"),
    await create("h", "0G", "10G"),
    await create("i", "1G", "1500M"),
  ];

  expect(made.map(({ code }) => code)).toEqual([0, 0, 0, 0]);
  expect(linux.creates.map(({ ramMib, diskGib }) => [ramMib, diskGib])).toEqual([
    [512, 10],
    [1536, 2],
    [2048, 10],
    [8192, 10],
  ]);
  expect(refused.map(({ code, stderr }) => [code, stderr])).toEqual([
    [
      1,
      `clankerbox: Invalid: --ram "4096" isn't a size: write a number and M or G, such as 512M or 8G`,
    ],
    [
      1,
      `clankerbox: Invalid: --ram "1T" isn't a size: write a number and M or G, such as 512M or 8G`,
    ],
    [1, `clankerbox: Invalid: --ram "1.1G" must come to whole MiB, and at least one`],
    [1, `clankerbox: Invalid: --ram "0G" must come to whole MiB, and at least one`],
    [1, `clankerbox: Invalid: --disk "1500M" must come to whole GiB, and at least one`],
  ]);
});
