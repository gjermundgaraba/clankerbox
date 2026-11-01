import { defineRule, eslintCompatPlugin } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

interface AllowedImports {
  readonly allow: readonly string[];
  readonly allowTypes?: readonly string[];
  readonly because: string;
}

const isAllowedImports = (option: unknown): option is AllowedImports =>
  typeof option === "object" &&
  option !== null &&
  "allow" in option &&
  Array.isArray(option.allow) &&
  (!("allowTypes" in option) || Array.isArray(option.allowTypes)) &&
  "because" in option &&
  typeof option.because === "string";

const isStringLiteral = (
  node: ESTree.Node | undefined
): node is ESTree.StringLiteral =>
  node?.type === "Literal" && typeof node.value === "string";

export const allowedImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Allow a file to import only the specifiers its folder may depend on, whether static, type-only, re-exported, dynamic or required. `allowTypes` lists what it may only import as types, which leaves nothing at runtime.",
    },
    messages: {
      notAllowed:
        '"{{specifier}}" is outside what this file may import: {{because}}',
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
          allowTypes: { type: "array", items: { type: "string" } },
          because: { type: "string" },
        },
        required: ["allow", "because"],
        additionalProperties: false,
      },
    ],
  },
  createOnce(context) {
    const check = (source: ESTree.StringLiteral, typeOnly = false) => {
      const option = context.options?.[0];

      if (!isAllowedImports(option)) {
        return;
      }

      const allowed = typeOnly
        ? [...option.allow, ...(option.allowTypes ?? [])]
        : option.allow;

      if (
        !allowed.some((pattern) => new RegExp(pattern, "u").test(source.value))
      ) {
        context.report({
          node: source,
          messageId: "notAllowed",
          data: { specifier: source.value, because: option.because },
        });
      }
    };

    return {
      ImportDeclaration(node) {
        check(node.source, node.importKind === "type");
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) {
          check(node.source, node.exportKind === "type");
        }
      },
      ExportAllDeclaration(node) {
        check(node.source, node.exportKind === "type");
      },
      ImportExpression(node) {
        if (isStringLiteral(node.source)) {
          check(node.source);
        }
      },
      TSImportType(node) {
        check(node.source, true);
      },
      CallExpression(node) {
        const [first] = node.arguments;

        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          isStringLiteral(first)
        ) {
          check(first);
        }
      },
    };
  },
});

const runners = new Set(["Effect", "Runtime", "NodeRuntime", "BunRuntime"]);

const isRun = (name: string) => /^run[A-Z]/u.test(name);

export const noManualRunRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Run Effect by hand only in an entry file: no Effect.run*, runMain, Runtime.run* or ManagedRuntime, nor those names imported alone.",
    },
    messages: {
      manualRun:
        "`{{name}}` runs Effect by hand: return the Effect, and let the entry file or @effect/vitest run it.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type !== "Identifier" ||
          node.property.type !== "Identifier"
        ) {
          return;
        }

        const name = `${node.object.name}.${node.property.name}`;

        if (
          node.object.name === "ManagedRuntime" ||
          (runners.has(node.object.name) && isRun(node.property.name))
        ) {
          context.report({ node, messageId: "manualRun", data: { name } });
        }
      },
      ImportDeclaration(node) {
        if (!/^effect(?:\/|$)|^@effect\/platform-/u.test(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            continue;
          }

          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;

          if (isRun(imported) || imported === "ManagedRuntime") {
            context.report({
              node: specifier,
              messageId: "manualRun",
              data: { name: imported },
            });
          }
        }
      },
    };
  },
});

const impureNames = new Set(["Date", "crypto"]);

export const noImpureRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep a file a pure function of its arguments: no Date, Math.random or crypto, also through globalThis.",
    },
    messages: {
      impure:
        "`{{name}}` isn't a function of the row and the event: what a transition needs from the world rides on the event.",
    },
  },
  createOnce(context) {
    const called = (node: ESTree.CallExpression | ESTree.NewExpression) => {
      if (
        node.callee.type === "Identifier" &&
        impureNames.has(node.callee.name)
      ) {
        context.report({
          node,
          messageId: "impure",
          data: { name: node.callee.name },
        });
      }
    };

    return {
      CallExpression: called,
      NewExpression: called,
      MemberExpression(node) {
        if (
          node.object.type !== "Identifier" ||
          node.property.type !== "Identifier"
        ) {
          return;
        }

        const { name } = node.object;
        const property = node.property.name;

        if (
          impureNames.has(name) ||
          (name === "Math" && property === "random") ||
          (name === "globalThis" && impureNames.has(property))
        ) {
          context.report({
            node,
            messageId: "impure",
            data: { name: `${name}.${property}` },
          });
        }
      },
    };
  },
});

export default eslintCompatPlugin({
  meta: { name: "fence" },
  rules: {
    "allowed-imports": allowedImportsRule,
    "no-impure": noImpureRule,
    "no-manual-run": noManualRunRule,
  },
});
