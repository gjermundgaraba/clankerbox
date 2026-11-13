import { config } from "@clanker-stuff/oxlint-config";

const adapterPackages = [
  "^node:(?!sqlite)",
  "^effect(/(encoding|http|process|socket))?$",
  "^@effect/platform-node/",
  "^@gjermundgaraba/clankerbox-sdk$",
];

const adapterBecause =
  "an adapter imports the domain files, platform's shared process.ts, and its own subfolder; never composition/ or another adapter";

const providerClients = [
  "apps/host/src/platform/boat/*.ts",
  "apps/host/src/platform/smol-cloud/*.ts",
];

export default config({
  jsPlugins: [{ name: "fence", specifier: "./tools/lint-fence/src/index.ts" }],
  testBlocks: ["it", "it.effect", "it.live", "it.prop", "it.effect.prop"],
  overrides: [
    {
      files: ["apps/host/src/guest.ts", "apps/host/tests/fake-runtime.ts"],
      rules: { "no-template-curly-in-string": "off" },
    },
    {
      files: ["packages/sdk/src/index.ts"],
      rules: { "oxc/no-barrel-file": "off" },
    },
    {
      files: [
        "apps/cli/src/main.ts",
        "apps/host/src/main.ts",
        "apps/host/tests/serving.ts",
        "apps/server/src/main.ts",
        "apps/server/tests/serve.ts",
        "packages/amp-orbs/src/main.ts",
        "packages/rivet-sandbox-agent/src/provider.ts",
        "packages/rivet-sandbox-agent/tests/leave-tunnel.ts",
        "packages/rivet-sandbox-agent/tests/provider.test.ts",
      ],
      rules: { "fence/no-manual-run": "off" },
    },
    {
      excludeFiles: ["apps/host/src/main.ts"],
      files: ["apps/host/src/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^effect$",
              "^effect/encoding$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^@clankerbox/host-contract$",
            ],
            because:
              "a host domain file imports only other domain files, effect, the SDK and the host contract; platform/, Node and effect/process are for composition/",
          },
        ],
      },
    },
    {
      excludeFiles: [
        "apps/server/src/chart.ts",
        "apps/server/src/*-chart.ts",
        "apps/server/src/hosts.ts",
        "apps/server/src/main.ts",
      ],
      files: ["apps/server/src/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^effect$",
              "^effect/encoding$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^@clankerbox/host-contract$",
            ],
            because:
              "a server domain file imports only other domain files, effect, the SDK and the host contract; a host is reached through hosts.ts, and platform/ and Node are for composition/",
          },
        ],
      },
    },
    {
      files: ["apps/server/src/chart.ts", "apps/server/src/*-chart.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: ["^xstate$", "^\\./chart\\.ts$", "^\\./[a-z-]+-chart\\.ts$"],
            allowTypes: ["^\\./store\\.ts$", "^\\./hosts\\.ts$"],
            because:
              "a chart is a pure function run inside the SQLite write: it imports xstate, other charts and the store's and hosts' types, and what else it needs rides on the event",
          },
        ],
        "fence/no-impure": "error",
      },
    },
    {
      files: ["apps/server/src/hosts.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^effect$",
              "^effect/http$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^@clankerbox/host-contract$",
              "^@gjermundgaraba/effect-actions/",
            ],
            because:
              "hosts.ts is the one file that calls a host, over the host contract",
          },
        ],
      },
    },
    {
      files: ["apps/server/src/platform/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\.\\./[a-z-]+\\.ts$",
              "^node:sqlite$",
              "^@clankerbox/host-contract$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^effect$",
            ],
            because:
              "the server's adapter is its Store, which is the one place state lives",
          },
        ],
      },
    },
    {
      files: ["apps/server/src/composition/*.ts", "apps/server/src/main.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\.\\.?/[a-z-]+(/[a-z-]+)?\\.ts$",
              "^node:http$",
              "^@effect/platform-node/",
              "^@clankerbox/host-contract/journal$",
              "^@gjermundgaraba/clankerbox-sdk(/node)?$",
              "^@gjermundgaraba/effect-actions/",
              "^effect$",
              "^effect/(cli|http)$",
            ],
            because:
              "the server reaches a host only over the network: it never loads the host package or a runtime",
          },
        ],
      },
    },
    {
      excludeFiles: ["packages/host-contract/src/journal.ts"],
      files: ["packages/host-contract/src/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^effect$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^@gjermundgaraba/effect-actions/",
            ],
            because:
              "the host contract is schemas and actions, shared by the server and the host alone; the journal alone serves HTTP",
          },
        ],
      },
    },
    {
      files: ["packages/host-contract/src/journal.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: ["^effect$", "^effect/http$"],
            because:
              "the journal is a middleware over Effect's HTTP server, of the requests the server and a host each serve",
          },
        ],
      },
    },
    {
      files: ["apps/host/src/platform/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./process\\.ts$",
              "^\\.\\./[a-z-]+\\.ts$",
              ...adapterPackages,
            ],
            because: adapterBecause,
          },
        ],
      },
    },
    {
      excludeFiles: providerClients,
      files: ["apps/host/src/platform/*/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^\\.\\./process\\.ts$",
              "^\\.\\./\\.\\./[a-z-]+\\.ts$",
              ...adapterPackages,
            ],
            because: adapterBecause,
          },
        ],
      },
    },
    {
      files: providerClients,
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^\\.\\./(process|provider-http)\\.ts$",
              "^\\.\\./\\.\\./[a-z-]+\\.ts$",
              ...adapterPackages,
            ],
            because:
              "a provider's client imports the domain files, platform's shared process.ts, the rules provider-http.ts holds for a provider's HTTP API, and its own subfolder; never composition/ or another adapter",
          },
        ],
      },
    },
    {
      excludeFiles: ["apps/cli/src/main.ts"],
      files: ["apps/cli/src/**/*.ts"],
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
              "a command imports effect, the SDK and its siblings; a client knows the control plane's contract, never a host's, and Node and @effect/platform-node are for main.ts",
          },
        ],
      },
    },
    {
      excludeFiles: [
        "packages/rivet-sandbox-agent/src/fetch.ts",
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
              "Node and @effect/platform-node enter the provider only in index.ts, its Layers, tunnel.ts, the ssh tunnel, and fetch.ts, the SDK's fetch through it",
          },
        ],
      },
    },
    {
      excludeFiles: ["packages/amp-orbs/src/main.ts"],
      files: ["packages/amp-orbs/src/**/*.ts"],
      rules: {
        "fence/allowed-imports": [
          "error",
          {
            allow: [
              "^\\./[a-z-]+\\.ts$",
              "^effect$",
              "^effect/cli$",
              "^@gjermundgaraba/clankerbox-sdk$",
              "^node:crypto$",
            ],
            because:
              "Node's services and HTTP client and @effect/platform-node enter the Amp orb provider only in main.ts, its Layers",
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
