import { config } from "@clanker-stuff/oxlint-config";

const adapterPackages = [
  "^node:",
  "^effect(/(encoding|http|process))?$",
  "^@effect/platform-node/",
  "^@gjermundgaraba/clankerbox-sdk$",
];

const adapterBecause =
  "an adapter imports the domain files, platform's shared process.ts and address.ts, and its own subfolder; never composition/ or another adapter";

export default config({
  jsPlugins: [{ name: "fence", specifier: "./tools/lint-fence/src/index.ts" }],
  testBlocks: ["it", "it.effect", "it.live", "it.prop", "it.effect.prop"],
  overrides: [
    {
      files: [
        "packages/host/src/guest.ts",
        "packages/host/tests/fake-runtime.ts",
      ],
      rules: { "no-template-curly-in-string": "off" },
    },
    {
      files: ["packages/sdk/src/index.ts"],
      rules: { "oxc/no-barrel-file": "off" },
    },
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
  rules: { "fence/no-manual-run": "error" },
});
