import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "node",
    format: ["esm"],
    dts: { generator: "tsgo" },
  },
  test: {
    setupFiles: ["@gjermundgaraba/clankerbox-sdk/testing/equality"],
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/port-slot.ts"],
  },
});
