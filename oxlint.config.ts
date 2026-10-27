import { recommended as effect } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import type { DummyRuleMap, OxlintOverride } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// The shared Ultracite exceptions. Every Effect/Vite+ repository carries this block verbatim, so
// a grep finds every copy; only the test-block and assertion-function name lists vary. Each rule
// here conflicts with an Effect idiom or with a contract the code must keep. Changing the block
// needs maintainer approval, and changes every copy.

// The files Ultracite's vitest preset treats as tests, so its rules and these relaxations agree.
const testFiles = [
  "**/*.{test,spec,test-d,spec-d}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  "**/__tests__/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
];

export const sharedRules: DummyRuleMap = {
  // Key order carries meaning: wire formats, hashes, CLI flags, tool schemas, UI order.
  "sort-keys": "off",
  // A module holds several tagged errors or services, which are classes.
  "max-classes-per-file": "off",
  // A loop awaits in order where order, back-pressure or one-at-a-time I/O matters.
  "no-await-in-loop": "off",
  // With `promise-function-async`, it forces `await Promise.resolve(x)` into thin async wrappers.
  "require-await": "off",
  // `return yield*` in a generator reads as an inconsistent return.
  "typescript/consistent-return": "off",
  // A module may call a function or class declared further down, and types are hoisted; a
  // value used before its declaration is still an error.
  "no-use-before-define": [
    "error",
    { classes: false, functions: false, ignoreTypeReferences: true },
  ],
  // Metrics, not defects: splitting to satisfy them scatters one decision across helpers.
  complexity: "off",
  "max-nested-callbacks": "off",
  // Hashes, file modes and binary formats are bitwise by nature.
  "no-bitwise": "off",
  // Effect modules are PascalCase (`Schema.ts`); everything else is kebab-case.
  "unicorn/filename-case": [
    "error",
    { cases: { kebabCase: true, pascalCase: true } },
  ],
  // Optional DTO fields belong in their construction expression.
  "anti-slop/no-conditional-empty-object-spread": "off",
  // Generators passed to Effect.gen and Effect.fn are named by their span, not the function.
  "func-names": ["error", "as-needed", { generators: "never" }],
  // A schema and its type share a name; tsc rejects real redeclarations.
  "no-redeclare": "off",
  // `Effect.catch` is not a promise chain.
  "promise/prefer-await-to-then": "off",
  // Effect handlers are typed functions, not error-first callbacks: the rule flags every
  // `Effect.catch((error) => ...)`, the name `unicorn/catch-error-name` demands.
  "promise/prefer-await-to-callbacks": "off",
  // `readonly string[]`, but `ReadonlyArray<Html | string>` over `readonly (Html | string)[]`.
  "typescript/array-type": [
    "error",
    { default: "array-simple", readonly: "array-simple" },
  ],
  // Effect's data-first `map(self, f)` and `filter(self, f)` take no thisArg.
  "unicorn/no-array-method-this-argument": "off",
  // Effect APIs take `undefined` as a value, as in `Deferred.succeed(done, undefined)`.
  "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
  // `Schema.TaggedError<X>()` builds an error class; it throws nothing.
  "unicorn/throw-new-error": "off",
  // Notices for every unstable Effect API bury the warnings that matter.
  "effecttsgo/unstable-api-usage": "off",
};

export const sharedTestOverride: OxlintOverride = {
  files: testFiles,
  // Naming the plugin lets the override reach its rules.
  plugins: ["vitest"],
  rules: {
    // `@effect/vitest`'s test functions are test blocks, and the repository's assertion helpers
    // (Foldkit's `scene`/`story` among them, where used) assert. List the names the repository uses.
    "vitest/no-standalone-expect": [
      "error",
      {
        additionalTestBlockFunctions: [
          "it",
          "it.effect",
          "it.live",
          "it.prop",
          "it.effect.prop",
        ],
      },
    ],
    "vitest/expect-expect": [
      "error",
      {
        additionalTestBlockFunctions: [
          "it",
          "it.effect",
          "it.live",
          "it.prop",
          "it.effect.prop",
        ],
        assertFunctionNames: ["expect", "expectTypeOf", "assert", "assert.*"],
      },
    ],
    // An `Effect.fn` export's runtime name is empty, so `describe(fn)` reports `<anonymous>`; the
    // rule also takes namespace imports for functions. Titles are strings.
    "vitest/prefer-describe-function-title": "off",
    // A test writes `find(...)!` for what it asserts exists.
    "typescript/no-non-null-assertion": "off",
    // Each value gets its own `expect`, with a message where the value alone would not explain a failure.
    "vitest/max-expects": "off",
    "vitest/valid-expect": ["error", { maxArgs: 2 }],
    // `toBe(true)` asserts a boolean; `toBeTruthy()` accepts any truthy value.
    "vitest/prefer-to-be-truthy": "off",
    "vitest/prefer-to-be-falsy": "off",
    // Tests feed hostile and literal input on purpose.
    "no-script-url": "off",
    "no-template-curly-in-string": "off",
    // Replaces Ultracite's `no-module-mocking`, which misses `vi` from `vite-plus/test`.
    "vitest/no-restricted-vi-methods": [
      "error",
      {
        doMock:
          "Replace dependencies through Layers or real interfaces, not module mocks.",
        mock: "Replace dependencies through Layers or real interfaces, not module mocks.",
      },
    ],
  },
};

const adapterPackages = [
  "^node:",
  "^effect(/(encoding|http|process))?$",
  "^@effect/platform-node/",
  "^@gjermundgaraba/clankerbox-sdk$",
];

const adapterBecause =
  "an adapter imports the domain files, platform's shared process.ts and address.ts, and its own subfolder; never composition/ or another adapter";

export default defineConfig({
  env: { node: true },
  extends: [core, antiSlop, vitest, effect],
  ignorePatterns: core.ignorePatterns ?? [],
  jsPlugins: [
    { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
    { name: "fence", specifier: "./tools/lint-fence/src/index.ts" },
  ],
  options: {
    typeAware: true,
    typeCheck: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "deny",
  },
  overrides: [
    sharedTestOverride,
    // These files hold shell scripts as strings: `${VAR}` there is the shell's expansion, not a
    // missed template literal.
    {
      files: [
        "packages/host/src/guest.ts",
        "packages/host/tests/fake-runtime.ts",
      ],
      rules: { "no-template-curly-in-string": "off" },
    },
    // `locate` rebuilds a client error by decoding what the same union encoded, so the result is the
    // input's class. Without the `as E`, every client method's declared errors would widen to all
    // of `ClankerboxError`; a guard in its place would assert the same thing unchecked.
    {
      files: ["packages/sdk/src/client.ts"],
      rules: { "typescript/no-unsafe-type-assertion": "off" },
    },
    // The SDK's published `.` entry is a module of re-exports.
    {
      files: ["packages/sdk/src/index.ts"],
      rules: { "oxc/no-barrel-file": "off" },
    },
    // The program's entries run Effect by hand: the CLI's `main`, the provider's Promise API, and
    // the tests that drive that API or a child program.
    {
      files: [
        "apps/clankerbox/src/main.ts",
        "packages/rivet-sandbox-agent/src/provider.ts",
        "packages/rivet-sandbox-agent/tests/leave-tunnel.ts",
        "packages/rivet-sandbox-agent/tests/provider.test.ts",
      ],
      rules: { "fence/no-manual-run": "off" },
    },
    {
      excludeFiles: ["packages/host/src/lifecycle.ts"],
      files: ["packages/host/src/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^effect$",
              "^effect/encoding$",
              "^@gjermundgaraba/clankerbox-sdk$",
            ],
            because:
              "a host domain file imports only other domain files, effect and the SDK; platform/, Node and effect/process are for composition/, and xstate for lifecycle.ts",
          },
        ],
      },
    },
    {
      files: ["packages/host/src/lifecycle.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^effect$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^xstate$",
              "^@xstate/effect$",
            ],
            because:
              "lifecycle.ts holds the machines' statechart, the one domain file on xstate, beside its siblings, effect and the SDK",
          },
        ],
      },
    },
    {
      files: ["packages/host/src/platform/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./(process|address)\\.ts$",
              "^\\.\\./[a-z-]+\\.ts$",
              ...adapterPackages,
            ],
            because: adapterBecause,
          },
        ],
      },
    },
    {
      files: ["packages/host/src/platform/*/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^\\.\\./(process|address)\\.ts$",
              "^\\.\\./\\.\\./[a-z-]+\\.ts$",
              ...adapterPackages,
            ],
            because: adapterBecause,
          },
        ],
      },
    },
    {
      excludeFiles: [
        "apps/clankerbox/src/main.ts",
        "apps/clankerbox/src/host.ts",
      ],
      files: ["apps/clankerbox/src/**/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\.\\.?/[a-z-]+(/[a-z-]+)?\\.ts$",
              "^effect$",
              "^effect/(cli|encoding|http|process|socket)$",
              "^@gjermundgaraba/clankerbox-sdk$",
            ],
            because:
              "a command imports effect, the SDK and its siblings; Node, @effect/platform-node and the host package are for main.ts and host.ts",
          },
        ],
      },
    },
    {
      excludeFiles: [
        "packages/rivet-sandbox-agent/src/index.ts",
        "packages/rivet-sandbox-agent/src/tunnel.ts",
      ],
      files: ["packages/rivet-sandbox-agent/src/**/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^effect$",
              "^effect/(encoding|process)$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^sandbox-agent$",
            ],
            because:
              "Node and @effect/platform-node enter the provider only in index.ts, its Layers, and tunnel.ts, the ssh tunnel",
          },
        ],
      },
    },
    {
      excludeFiles: ["packages/sdk/src/node.ts"],
      files: ["packages/sdk/src/**/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./(?!node\\.ts$)[a-z-]+\\.ts$",
              "^\\.\\./package\\.json$",
              "^effect$",
              "^effect/(encoding|http)$",
              "^@gjermundgaraba/effect-actions/",
            ],
            because:
              "the SDK's . entry runs anywhere; what needs Node goes in node.ts",
          },
        ],
        "no-restricted-globals": [
          "error",
          {
            message: "The SDK's . entry runs anywhere: use Uint8Array.",
            name: "Buffer",
          },
          {
            message: "The SDK's . entry runs anywhere: take it as input.",
            name: "process",
          },
        ],
      },
    },
  ],
  rules: {
    ...sharedRules,
    "fence/no-manual-run": "error",
    "vite-plus/prefer-vite-plus-imports": "error",
  },
});
