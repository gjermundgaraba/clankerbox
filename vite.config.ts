import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ".work/**",
      // The plans keep their own line breaks and are deleted before the merge.
      "docs/plans/**",
    ],
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [".work/**"],
  },
  run: { cache: true },
});
