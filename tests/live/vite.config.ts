import { defineConfig } from "vite-plus";

// Live acceptance runs against real hosts and binaries, so it is skipped unless
// CLANKERBOX_LIVE=1. CLANKERBOX_BIN names the clankerbox binary under test; a runtime's suite
// runs when CLANKERBOX_LIVE_RUNTIME names it, and also reads CLANKERBOX_LIVE_CONFIG,
// CLANKERBOX_LIVE_HOST_CONTROL and CLANKERBOX_LIVE_PREFIX (tests/live.ts), which
// smolvm/driver.py, tart/driver.py and boat/driver.py provide.
export default defineConfig({
  // A cached result would replay a run against whatever was live at the time.
  run: { tasks: { test: { command: "vp test", cache: false } } },
  // One file at a time: a run's suites share one host, and its capacity.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
