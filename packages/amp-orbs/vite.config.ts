import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { "clankerbox-amp-orbs": "src/main.ts" },
    format: "esm",
    platform: "node",
    dts: false,
  },
  test: { include: ["tests/**/*.test.ts"] },
});
