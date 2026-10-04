import { defineConfig } from "vite-plus";

// Live acceptance runs against real hosts and binaries, so it is skipped unless
// CLANKERBOX_LIVE=1. CLANKERBOX_BIN names the clankerbox binary under test; the smolvm suite
// also reads CLANKERBOX_LIVE_CONFIG and CLANKERBOX_LIVE_HOST_CONTROL (tests/live.ts).
export default defineConfig({
  // A cached result would replay a run against whatever was live at the time.
  run: { tasks: { test: { command: "vp test", cache: false } } },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000 },
});
