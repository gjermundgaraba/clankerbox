import { defineConfig } from "vite-plus";

// One self-contained ESM file, dist/clankerbox.mjs, for the SEA build in tools/release.
export default defineConfig({
  pack: {
    entry: { clankerbox: "src/main.ts" },
    format: "esm",
    platform: "node",
    target: "node26",
    dts: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    // A SEA runs one file: inline platform-node's dynamic import("./Undici.ts").
    outputOptions: { codeSplitting: false },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
