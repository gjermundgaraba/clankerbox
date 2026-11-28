import ultracite from "ultracite/oxfmt";
import type { OxfmtConfig } from "vite-plus/fmt";

export default {
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".agents/**",
    "AGENTS.md",
    "apps/host/tests/kind/external-snapshotter-v8.7.0/**",
  ],
} satisfies OxfmtConfig;
