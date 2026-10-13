import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { type StubHost } from "../../../packages/sdk/tests/stub-host.ts";
import { cleanup, cli, decodeJsonError, hostIn, scratch, writeConfig } from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

const host = hostIn(stubs);

test("the config is read from $XDG_CONFIG_HOME/clankerbox/config.json without --config", async () => {
  const dir = await scratch(owned);

  await mkdir(join(dir, "clankerbox"));
  await writeConfig(join(dir, "clankerbox"), ["linux"]);

  const { code, stdout } = await cli(["hosts"], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
    env: { XDG_CONFIG_HOME: dir },
  });

  expect(code).toBe(0);
  expect(stdout).toContain("ubuntu");
});

test("without XDG_CONFIG_HOME the config is read from ~/.config/clankerbox/config.json", async () => {
  const dir = await scratch(owned);

  await mkdir(join(dir, ".config", "clankerbox"), { recursive: true });
  await writeConfig(join(dir, ".config", "clankerbox"), ["linux"]);

  const { code } = await cli(["hosts"], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
    env: { HOME: dir },
  });

  expect(code).toBe(0);
});

test("a config with an unknown key or a duplicate host is Invalid", async () => {
  const dir = await scratch(owned);
  const typo = join(dir, "typo.json");
  const twice = join(dir, "twice.json");

  await writeFile(
    typo,
    JSON.stringify({ hosts: [{ id: "linux", url: "http://linux.test" }], host: [] }),
  );
  await writeFile(
    twice,
    JSON.stringify({
      hosts: [
        { id: "linux", url: "http://linux.test" },
        { id: "linux", url: "http://other.test" },
      ],
    }),
  );

  for (const config of [typo, twice]) {
    const { code, stdout } = await cli(["hosts", "--json", "--config", config]);

    expect(code).toBe(1);
    expect(decodeJsonError(stdout).error.tag).toBe("Invalid");
  }
});

test("a config's mistakes are all named, each by its JSON path, and an empty host list by what it lacks", async () => {
  const dir = await scratch(owned);
  const wrong = join(dir, "wrong.json");
  const empty = join(dir, "empty.json");

  await writeFile(wrong, JSON.stringify({ hosts: [{ id: "Linux" }], host: [] }));
  await writeFile(empty, JSON.stringify({ hosts: [] }));

  const run = async (config: string) => (await cli(["hosts", "--config", config])).stderr;

  expect(await run(wrong)).toBe(
    `clankerbox: Invalid: client config ${wrong}: host: not a known field; hosts[0].id: a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter; hosts[0].url: missing`,
  );
  expect(await run(empty)).toBe(
    "clankerbox: Invalid: the host list is empty: a client needs a host",
  );
  expect(await run(join(dir, "absent.json"))).toBe(
    `clankerbox: Invalid: couldn't read client config ${join(dir, "absent.json")}: no such file or directory`,
  );
});
