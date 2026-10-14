import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

const nodeMajor = readFileSync(new URL("../../.node-version", import.meta.url), "utf8")
  .trim()
  .split(".")[0];

export default defineConfig({
  pack: {
    entry: { clankerbox: "src/main.ts" },
    format: "esm",
    platform: "node",
    target: `node${nodeMajor}`,
    dts: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    outputOptions: { codeSplitting: false },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
