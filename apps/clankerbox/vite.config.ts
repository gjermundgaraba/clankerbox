import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

/** The major of the Node `.node-version` pins, which the SEA is built on. */
const nodeMajor = readFileSync(new URL("../../.node-version", import.meta.url), "utf8")
  .trim()
  .split(".")[0];

// One self-contained ESM file, dist/clankerbox.mjs, for the SEA build in tools/release.
export default defineConfig({
  pack: {
    entry: { clankerbox: "src/main.ts" },
    format: "esm",
    platform: "node",
    target: `node${nodeMajor}`,
    dts: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    // A SEA runs one file: inline platform-node's dynamic import("./Undici.ts").
    outputOptions: { codeSplitting: false },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
