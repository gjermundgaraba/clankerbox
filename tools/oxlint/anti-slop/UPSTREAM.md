# Vendored anti-slop Oxlint plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Installed on 2026-10-04 with the `install-anti-slop` skill (`scripts/install.mjs`), which
copies its bundled `assets/anti-slop/`, a copy of `skills/install-anti-slop/` at that
upstream commit. The installed files are identical to the bundle.

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

- `oxlint` comes from `vite-plus` 1.0.0, which pins it to `1.85.0`.
- Root `devDependency`: `@oxlint/plugins@1.85.0` (catalog), pinned to match oxlint.

## Intentional deviations

- Plugin assets: none.
- Lint policy, as in clankerauth: `anti-slop/no-runtime-typeof` is
  `["error", { allowInTypeGuards: true }]`, so boundary type predicates may use
  `typeof`. `typeof` outside type guards remains an error.
