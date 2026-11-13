import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, it } from "vite-plus/test";

import repository from "../../../oxlint.config.ts";
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

type Options =
  NonNullable<
    Parameters<typeof tester.run>[2]["valid"][number]
  > extends infer Case
    ? Case extends { readonly options?: infer O }
      ? NonNullable<O>
      : never
    : never;

const isJson = (value: unknown): value is Options[number] => {
  if (Array.isArray(value)) {
    return value.every(isJson);
  }

  return typeof value === "object" && value !== null
    ? Object.values(value).every(isJson)
    : ["string", "number", "boolean"].includes(typeof value) || value === null;
};

const fencedInRepository = (glob: string): Options => {
  const rule = repository.overrides?.find(({ files }) => files.includes(glob))
    ?.rules?.["fence/allowed-imports"];

  if (!Array.isArray(rule)) {
    throw new TypeError(`oxlint.config.ts fences no imports of ${glob}`);
  }

  return rule.slice(1).filter(isJson);
};

const domain = fencedInRepository("apps/server/src/*.ts");

const hostDomain = fencedInRepository("apps/host/src/*.ts");

const chart = fencedInRepository("apps/server/src/chart.ts");

const onBothDomains = <Case extends { readonly options?: Options }>(
  each: Case
): Case[] =>
  each.options === domain ? [each, { ...each, options: hostDomain }] : [each];

const platform = fencedInRepository("apps/host/src/platform/*.ts");

const adapter = fencedInRepository("apps/host/src/platform/*/*.ts");

const providerClient = fencedInRepository("apps/host/src/platform/boat/*.ts");

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
    { code: 'import { describe } from "./process.ts";', options: platform },
    { code: 'import { describe } from "../process.ts";', options: adapter },
    { code: 'import { Runtime } from "../../runtime.ts";', options: adapter },
    {
      code: 'import { within } from "../provider-http.ts";',
      options: providerClient,
    },
    {
      code: 'import { describe } from "../process.ts";',
      options: providerClient,
    },
    {
      code: 'import { Runtime } from "../../runtime.ts";',
      options: providerClient,
    },
  ].flatMap(onBothDomains),
  invalid: [
    {
      code: 'import { within } from "./provider-http.ts";',
      options: platform,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'import { within } from "../provider-http.ts";',
      options: adapter,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'import { make } from "../tart/tart.ts";',
      options: adapter,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'import { tailnet } from "../tailscale.ts";',
      options: providerClient,
      errors: [{ messageId: "notAllowed" }],
    },
    {
      code: 'import { make } from "../smol-cloud/api.ts";',
      options: providerClient,
      errors: [{ messageId: "notAllowed" }],
    },
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
  ].flatMap(onBothDomains),
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
