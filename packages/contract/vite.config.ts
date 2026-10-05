import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/node.ts"],
    platform: "node",
    format: ["esm"],
    dts: { generator: "tsgo" },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
