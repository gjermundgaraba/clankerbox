import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { clankerbox: "src/main.ts" },
    format: "esm",
    platform: "node",
    dts: false,
    deps: {
      onlyBundle: [
        "effect",
        "@effect/platform-node",
        "@effect/platform-node-shared",
        "@gjermundgaraba/effect-actions",
      ],
    },
    minify: true,
    outputOptions: { codeSplitting: false },
  },
  test: {
    setupFiles: ["@gjermundgaraba/clankerbox-sdk/testing/equality"],
    include: ["tests/**/*.test.ts"],
  },
});
