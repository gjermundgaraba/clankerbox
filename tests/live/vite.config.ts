import { defineConfig } from "vite-plus";

export default defineConfig({
  // A cached result would replay a run against whatever was live at the time.
  run: { tasks: { test: { command: "vp test", cache: false } } },
  // One file at a time: a run's suites share one host, and its capacity.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
