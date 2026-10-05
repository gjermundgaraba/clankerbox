import { version } from "@gjermundgaraba/clankerbox-sdk";
import { expect, test } from "vite-plus/test";
import { cli } from "./support.ts";

test("--version prints the version", async () => {
  const { code, stdout } = await cli(["--version"]);

  expect(code).toBe(0);
  expect(stdout).toBe(`clankerbox v${version}`);
});

test("--help shows the CLI's usage", async () => {
  const { code, stdout } = await cli(["--help"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox <subcommand> [flags]");
});

test("host --help shows the host role's usage", async () => {
  const { code, stdout } = await cli(["host", "--help"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox host [flags]");
  expect(stdout).toContain("--config");
});

test("host without --config is a usage error", async () => {
  const { code, stderr } = await cli(["host"]);

  expect(code).toBe(1);
  expect(stderr).toContain("--config");
});

test("host with a config it can't read says so and exits 1", async () => {
  const { code, stderr } = await cli(["host", "--config", "/nonexistent/clankerbox-host.json"]);

  expect(code).toBe(1);
  expect(stderr).toContain("Invalid: couldn't read host config /nonexistent/clankerbox-host.json");
});

test("an unknown flag exits 1", async () => {
  const { code } = await cli(["--bogus"]);

  expect(code).toBe(1);
});
