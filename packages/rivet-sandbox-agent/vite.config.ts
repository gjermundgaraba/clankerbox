import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "node",
    format: ["esm"],
    // Oxc, not tsgo: tsgo writes a declaration beside every workspace source the package imports.
    dts: { generator: "oxc" },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
