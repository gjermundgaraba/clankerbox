import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, it } from "vite-plus/test";
import { allowedImportsRule, noManualRunRule, noProseCommentsRule } from "../src/index.ts";

RuleTester.describe = describe;

RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

const domain = [
  {
    allow: ["^\\./[a-z-]+\\.ts$", "^effect$", "^@gjermundgaraba/clankerbox-sdk$"],
    because: "a domain file",
  },
];

tester.run("allowed-imports", allowedImportsRule, {
  valid: [
    { code: 'import { Effect } from "effect";', options: domain },
    { code: 'import type { Held } from "./runtime.ts";', options: domain },
    { code: 'export { parseId } from "@gjermundgaraba/clankerbox-sdk";', options: domain },
    { code: 'const sdk = await import("@gjermundgaraba/clankerbox-sdk");', options: domain },
  ],
  invalid: [
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

tester.run("no-manual-run", noManualRunRule, {
  valid: [
    "const program = Effect.map(Effect.succeed(1), (n) => n + 1);",
    "const all = Stream.runCollect(stream);",
    'import { Runtime } from "effect";',
  ],
  invalid: [
    { code: "Effect.runPromise(program);", errors: [{ messageId: "manualRun" }] },
    { code: "Effect.runSync(program);", errors: [{ messageId: "manualRun" }] },
    { code: "program.pipe(NodeRuntime.runMain);", errors: [{ messageId: "manualRun" }] },
    { code: "const runtime = ManagedRuntime.make(layer);", errors: [{ messageId: "manualRun" }] },
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

tester.run("no-prose-comments", noProseCommentsRule, {
  valid: [
    "// SAFETY: the union decodes what it encoded.\nconst error = decode(encoded) as E;",
    "// Source: S@1.27.3:src/agent/fork.rs:3978\nconst floor = 20_000;",
    "// oxlint-disable-next-line no-console -- the CLI's own output\nconsole.log(1);",
    "interface Port {\n  /** Returns once exec works. */\n  readonly start: () => void;\n}",
    "/** A port's contract. */\nexport interface Port {}",
    "/** What every runtime fails with. */\nexport type RuntimeError = Refused | Internal;",
    "type Shape = {\n  /** In MiB. */\n  readonly ram: number;\n};",
    "#!/usr/bin/env node\nconsole.log(1);",
    {
      code: "/** The client over Node's http. */\nexport const layer = make();",
      options: [{ publicDocs: true }],
    },
  ],
  invalid: [
    { code: "// Logged, not failed.\nconst x = 1;", errors: [{ messageId: "prose" }] },
    { code: "/** Logged, not failed. */\nconst x = 1;", errors: [{ messageId: "prose" }] },
    { code: "/* a block */\nconst x = 1;", errors: [{ messageId: "prose" }] },
    {
      code: "/** The client over Node's http. */\nexport const layer = make();",
      errors: [{ messageId: "prose" }],
    },
    {
      code: '/** A module header. */\nimport { Effect } from "effect";',
      options: [{ publicDocs: true }],
      errors: [{ messageId: "prose" }],
    },
    {
      code: "// SAFETY: the union decodes\n// what it encoded.\nconst error = decode(encoded) as E;",
      errors: [{ messageId: "prose" }],
    },
    {
      code: "// oxlint-disable-next-line no-console\nconsole.log(1);",
      errors: [{ messageId: "prose" }],
    },
    {
      code: "const run = () => {\n  /** narration */\n  step();\n};",
      options: [{ publicDocs: true }],
      errors: [{ messageId: "prose" }],
    },
  ],
});
