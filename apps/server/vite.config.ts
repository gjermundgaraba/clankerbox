import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { "clankerbox-server": "src/main.ts" },
    format: "esm",
    platform: "node",
    dts: false,
  },
  test: { include: ["tests/**/*.test.ts"] },
});
