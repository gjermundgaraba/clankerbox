import { defineConfig } from "vite-plus";

const agentTooling = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
];

export default defineConfig({
  fmt: {
    ignorePatterns: [...agentTooling, ".work/**", "tools/oxlint/anti-slop/**"],
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    // Oxlint's defaults, and vitest for no-restricted-vi-methods.
    plugins: ["unicorn", "typescript", "oxc", "vitest"],
    ignorePatterns: [...agentTooling, ".work/**", "tools/oxlint/anti-slop/**"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      {
        name: "anti-slop-effect",
        specifier: "./tools/oxlint/anti-slop/effect/index.ts",
      },
      { name: "fence", specifier: "./tools/lint-fence/src/index.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "oxc/no-accumulating-spread": "error",
      // Vitest's expect takes a message as its second argument.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/require-to-throw-message": "error",
      "vitest/no-conditional-expect": "error",
      // @effect/vitest's testers are test blocks too.
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: ["it", "it.effect", "it.live", "it.prop", "it.effect.prop"],
        },
      ],
      "vitest/no-restricted-vi-methods": [
        "error",
        {
          mock: "Pass a real dependency seam instead of mocking a module.",
          doMock: "Pass a real dependency seam instead of mocking a module.",
        },
      ],
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
      "fence/no-manual-run": "error",
    },
    overrides: [
      {
        // The entry files, and the tests that drive a Promise API or a child program.
        files: [
          "apps/clankerbox/src/main.ts",
          "packages/rivet-sandbox-agent/src/provider.ts",
          "packages/rivet-sandbox-agent/tests/leave-tunnel.ts",
          "packages/rivet-sandbox-agent/tests/provider.test.ts",
          "tests/live/tests/sandbox-agent.test.ts",
          "tools/lint-fence/tests/**",
        ],
        rules: { "fence/no-manual-run": "off" },
      },
      {
        files: ["packages/host/src/*.ts"],
        excludeFiles: ["packages/host/src/{config,host,routes,runtimes,startup}.ts"],
        rules: {
          "fence/allowed-imports": [
            "error",
            {
              allow: [
                "^\\./(checkpoints|claims|guest|ids|machine-ports|machines|ram-budget|runtime|settings|store)\\.ts$",
                "^effect$",
                "^effect/encoding$",
                "^@gjermundgaraba/clankerbox-sdk$",
              ],
              because:
                "a host domain file imports only other domain files, effect and the SDK; platform/, Node and effect/process are for the composition files",
            },
          ],
        },
      },
      {
        files: ["packages/sdk/src/**/*.ts"],
        excludeFiles: ["packages/sdk/src/node.ts"],
        rules: {
          "fence/allowed-imports": [
            "error",
            {
              allow: [
                "^\\.\\.?/",
                "^effect$",
                "^effect/(encoding|http)$",
                "^@gjermundgaraba/effect-actions/",
              ],
              because: "the SDK's . entry runs anywhere; what needs Node goes in node.ts",
            },
          ],
          "no-restricted-globals": [
            "error",
            { name: "Buffer", message: "The SDK's . entry runs anywhere: use Uint8Array." },
            { name: "process", message: "The SDK's . entry runs anywhere: take it as input." },
          ],
        },
      },
    ],
  },
  run: { cache: true },
});
