# Vendored anti-slop Oxlint plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Installed on 2026-10-04 with the `install-anti-slop` skill (`scripts/install.mjs`), which
copies its bundled `assets/anti-slop/`, a copy of `skills/install-anti-slop/` at that
upstream commit. The installed files are identical to the bundle, less the deviations below.

## Installed paths

- Generic plugin: `tools/oxlint/anti-slop/index.ts`
- Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`
- Nested ESLint Stylistic readability vendor: `tools/oxlint/anti-slop/vendor/eslint-stylistic/` (see its `UPSTREAM.md` and `LICENSE`)

## Configuration

Registered in the root `vite.config.ts` under `lint.jsPlugins`, with matching
`lint.ignorePatterns` and `fmt.ignorePatterns`. The generic rules,
`oxc/no-accumulating-spread` and the Effect rules are enabled at `"error"`: the
workspace depends on `effect` directly.

## Dependencies

- `oxlint` and the plugin API both come from `vite-plus`. The API is imported from
  `vite-plus/lint/plugins`, which re-exports the `@oxlint/plugins` that `vite-plus` pins; that
  pin can lag its oxlint.
- These files are neither linted nor type-checked here. `vp check` loads both plugins and
  fails on an import or export they can't resolve.

## Intentional deviations

- Plugin API imports: they come from `vite-plus/lint/plugins`, not upstream's
  `@oxlint/plugins`, which the workspace doesn't install. `vp migrate` makes this rewrite.
- Plugin assets: `rules/no-module-mocking.ts` and `rules/no-shape-in-symbol-names.ts` are
  removed, with their registrations in `index.ts`.
  - `no-module-mocking`: Oxlint's built-in `vitest/no-restricted-vi-methods` does its job,
    configured in `vite.config.ts` to refuse `vi.mock` and `vi.doMock`. It catches `vi`
    imported from `vite-plus/test` (probed with oxlint 1.85.0), so the vitest plugin is
    enabled beside Oxlint's default plugins.
  - `no-shape-in-symbol-names`: it flags Effect's own `Context.Service`'s `Shape` in type
    position, and nothing here needs it.
- Lint policy, as in clankerauth: `anti-slop/no-runtime-typeof` is
  `["error", { allowInTypeGuards: true }]`, so boundary type predicates may use
  `typeof`. `typeof` outside type guards remains an error.
