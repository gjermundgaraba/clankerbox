import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { "clankerbox-server": "src/main.ts" },
    format: "esm",
    platform: "node",
    dts: false,
  },
  test: {
    setupFiles: ["@gjermundgaraba/clankerbox-sdk/testing/equality"],
    include: ["tests/**/*.test.ts"],
  },
});
