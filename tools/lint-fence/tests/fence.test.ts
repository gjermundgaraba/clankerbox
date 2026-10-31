import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, it } from "vite-plus/test";

import {
  allowedImportsRule,
  noImpureRule,
  noManualRunRule,
} from "../src/index.ts";

RuleTester.describe = (text, method) => {
  describe(text, () => {
    method();
  });
};

RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

const domain = [
  {
    allow: [
      "^\\./[a-z-]+\\.ts$",
      "^effect$",
      "^@gjermundgaraba/clankerbox-sdk$",
    ],
    because: "a domain file",
  },
];

const chart = [
  {
    allow: ["^xstate$"],
    allowTypes: ["^\\./store\\.ts$"],
    because: "a chart",
  },
];

tester.run("allowed-imports", allowedImportsRule, {
  valid: [
    { code: 'import { Effect } from "effect";', options: domain },
    { code: 'import { setup } from "xstate";', options: chart },
    { code: 'import type { Lease } from "./store.ts";', options: chart },
    { code: 'export type { Lease } from "./store.ts";', options: chart },
    { code: 'type Lease = import("./store.ts").Lease;', options: chart },
    { code: 'import type { Held } from "./runtime.ts";', options: domain },
    {
      code: 'export { parseId } from "@gjermundgaraba/clankerbox-sdk";',
      options: domain,
    },
    {
      code: 'const sdk = await import("@gjermundgaraba/clankerbox-sdk");',
      options: domain,
    },
  ],
  invalid: [
    {
      code: 'import { Store } from "./store.ts";',
      options: chart,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'import { type Lease } from "./store.ts";',
      options: chart,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'export { Store } from "./store.ts";',
      options: chart,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'const store = await import("./store.ts");',
      options: chart,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'import { randomBytes } from "node:crypto";',
      options: domain,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'import type { Store } from "./platform/sqlite.ts";',
      options: domain,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'export * from "@effect/platform-node/NodeServices";',
      options: domain,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'const process = await import("effect/process");',
      options: domain,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'type Socket = import("node:net").Socket;',
      options: domain,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'const fs = require("node:fs");',
      options: domain,
      errors: [{ messageId: "notAllowed" }],
    },
  ],
});

tester.run("no-impure", noImpureRule, {
  valid: [
    "const at = event.at;",
    "const when = context.Date;",
    "const dice = Math.floor(2.5);",
    "const crypted = { crypto: 1 };",
  ],
  invalid: [
    { code: "const now = Date.now();", errors: [{ messageId: "impure" }] },
    { code: "const now = new Date();", errors: [{ messageId: "impure" }] },
    { code: "const now = Date();", errors: [{ messageId: "impure" }] },
    { code: "const dice = Math.random();", errors: [{ messageId: "impure" }] },
    {
      code: "const id = crypto.randomUUID();",
      errors: [{ messageId: "impure" }],
    },
    {
      code: "const id = globalThis.crypto.randomUUID();",
      errors: [{ messageId: "impure" }],
    },
    { code: "const now = globalThis.Date;", errors: [{ messageId: "impure" }] },
    {
      code: "const one = Effect.succeed(1);",
      errors: [{ messageId: "impure" }],
    },
  ],
});

tester.run("no-manual-run", noManualRunRule, {
  valid: [
    "const program = Effect.map(Effect.succeed(1), (n) => n + 1);",
    "const all = Stream.runCollect(stream);",
    'import { Runtime } from "effect";',
  ],
  invalid: [
    {
      code: "Effect.runPromise(program);",
      errors: [{ messageId: "manualRun" }],
    },
    { code: "Effect.runSync(program);", errors: [{ messageId: "manualRun" }] },
    {
      code: "program.pipe(NodeRuntime.runMain);",
      errors: [{ messageId: "manualRun" }],
    },
    {
      code: "const runtime = ManagedRuntime.make(layer);",
      errors: [{ messageId: "manualRun" }],
    },
    {
      code: 'import { runPromise } from "effect/Effect";',
      errors: [{ messageId: "manualRun" }],
    },
    {
      code: 'import { ManagedRuntime } from "effect";',
      errors: [{ messageId: "manualRun" }],
    },
  ],
});
