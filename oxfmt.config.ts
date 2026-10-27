import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".agents/**",
    // `vp config` writes the Vite+ block of AGENTS.md on every install; Ultracite would rewrap it.
    "AGENTS.md",
  ],
});
