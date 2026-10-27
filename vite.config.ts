import { defineConfig } from "vite-plus";

import fmt from "./oxfmt.config.ts";
import lint from "./oxlint.config.ts";

export default defineConfig({
  fmt,
  lint,
  run: { cache: true },
  staged: { "*": "vp check --fix" },
});
