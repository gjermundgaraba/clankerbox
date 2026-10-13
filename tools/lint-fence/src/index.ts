import { defineRule, eslintCompatPlugin, type ESTree } from "vite-plus/lint/plugins";

interface AllowedImports {
  readonly allow: ReadonlyArray<string>;
  readonly because: string;
}

const isAllowedImports = (option: unknown): option is AllowedImports =>
  typeof option === "object" &&
  option !== null &&
  "allow" in option &&
  Array.isArray(option.allow) &&
  "because" in option &&
  typeof option.because === "string";

const isStringLiteral = (node: ESTree.Node | undefined): node is ESTree.StringLiteral =>
  node?.type === "Literal" && typeof node.value === "string";

/**
 * Every specifier a file names must match one of `allow`, regular expressions, whether it is a
 * static, type-only, re-exported or dynamic import, or a `require`.
 */
export const allowedImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Allow a file to import only the specifiers its folder may depend on." },
    messages: { notAllowed: '"{{specifier}}" is outside what this file may import: {{because}}' },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
          because: { type: "string" },
        },
        required: ["allow", "because"],
        additionalProperties: false,
      },
    ],
  },
  createOnce(context) {
    const check = (source: ESTree.StringLiteral) => {
      const option = context.options?.[0];

      if (!isAllowedImports(option)) {
        return;
      }

      if (!option.allow.some((pattern) => new RegExp(pattern, "u").test(source.value))) {
        context.report({
          node: source,
          messageId: "notAllowed",
          data: { specifier: source.value, because: option.because },
        });
      }
    };

    return {
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) {
          check(node.source);
        }
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        if (isStringLiteral(node.source)) {
          check(node.source);
        }
      },
      TSImportType(node) {
        check(node.source);
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

/**
 * Effect is run by hand only where a program starts: `Effect.run*`, a platform's `runMain`,
 * `Runtime.run*` and any `ManagedRuntime`, and the same names imported on their own.
 */
export const noManualRunRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Run Effect by hand only in an entry file." },
    messages: {
      manualRun:
        "`{{name}}` runs Effect by hand: return the Effect, and let the entry file or @effect/vitest run it.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || node.property.type !== "Identifier") {
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
            context.report({ node: specifier, messageId: "manualRun", data: { name: imported } });
          }
        }
      },
    };
  },
});

/** The repository's own boundaries: what each folder may import, and where Effect is run. */
export default eslintCompatPlugin({
  meta: { name: "fence" },
  rules: {
    "allowed-imports": allowedImportsRule,
    "no-manual-run": noManualRunRule,
  },
});
