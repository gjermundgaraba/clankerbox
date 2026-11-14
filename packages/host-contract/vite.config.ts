import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    setupFiles: ["@gjermundgaraba/clankerbox-sdk/testing/equality"],
    include: ["tests/**/*.test.ts"],
  },
});
