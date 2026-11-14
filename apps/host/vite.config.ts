import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { "clankerbox-host": "src/main.ts" },
    format: "esm",
    platform: "node",
    dts: false,
  },
  test: {
    setupFiles: ["@gjermundgaraba/clankerbox-sdk/testing/equality"],
    include: ["tests/**/*.test.ts"],
  },
  run: {
    tasks: {
      "test:live": {
        command: "CLANKERBOX_LIVE=1 vp test tests/live",
        cache: false,
      },
    },
  },
});
