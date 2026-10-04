import { version } from "@gjermundgaraba/clankerbox-sdk";
import { expect, test } from "vite-plus/test";
import { cli } from "./support.ts";

test("--version prints the version", async () => {
  const { code, stdout } = await cli(["--version"]);

  expect(code).toBe(0);
  expect(stdout).toBe(`clankerbox v${version}`);
});

test("--help lists the CLI's commands next to host", async () => {
  const { code, stdout } = await cli(["--help"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox <subcommand> [flags]");

  for (const command of ["hosts", "machines", "create", "checkpoint", "restore", "ssh", "host"]) {
    expect(stdout).toContain(command);
  }
});

test("host --help shows the host role's usage", async () => {
  const { code, stdout } = await cli(["host", "--help"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox host [flags]");
});

test("host runs the host role", async () => {
  const { code, stdout } = await cli(["host"]);

  expect(code).toBe(0);
  expect(stdout).toBe(`clankerbox host ${version}`);
});

test("an unknown flag exits 1", async () => {
  const { code } = await cli(["--bogus"]);

  expect(code).toBe(1);
});
