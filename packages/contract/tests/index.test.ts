import { expect, test } from "vite-plus/test";
import { version } from "../src/index.ts";

test("version is a semver version", () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
