import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { describe, expect, test } from "vite-plus/test";

const run = promisify(execFile);

describe.skipIf(process.env["CLANKERBOX_LIVE"] !== "1")("the binary under test", () => {
  test("reports the SDK's version", async () => {
    const binary = process.env["CLANKERBOX_BIN"];

    if (binary === undefined) {
      throw new Error("CLANKERBOX_BIN must name the clankerbox binary under test");
    }

    const { stdout } = await run(binary, ["--version"]);

    expect(stdout.trim()).toBe(`clankerbox v${version}`);
  });
});
