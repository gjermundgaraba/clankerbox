import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "node",
    format: ["esm"],
    dts: { generator: "oxc" },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
