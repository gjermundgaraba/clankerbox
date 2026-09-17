# Publishing the TypeScript SDK

The npm package is `@gjermundgaraba/clankerbox-sdk`, built from `protocol/`.
Only compiled `dist/`, the package manifest, README and MIT license ship.
Generated sources are checked in; publishing does not regenerate the protocol
or require protoc or Go. Consumers need neither this repository nor build scripts.

SDK versions are independent of Clankerbox binary releases. The current release pair is SDK **0.3.0**
with Clankerbox **0.7.0**, including runtime-built profiles. Update the compatibility
statement in `protocol/README.md` when qualifying a new pair. Published npm versions are
immutable: changed package contents require a new SDK version.

## One-time account setup and first publication

You need npm publish rights for the `@gjermundgaraba` scope. The repository does
not create an npm account, configure its permissions, or publish automatically
when this setup is merged.

For a new package, make the first publication interactively so that its npm
package settings exist. From a clean, committed checkout with passing CI, using
the pinned pnpm version in `protocol/package.json`:

```sh
cd protocol
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm pack
# Substitute the version in package.json if it has changed.
pnpm test:package ./gjermundgaraba-clankerbox-sdk-0.3.0.tgz
npm publish ./gjermundgaraba-clankerbox-sdk-0.3.0.tgz --access public --ignore-scripts --dry-run

# These commands authenticate and actually publish; run them deliberately.
npm login
npm publish ./gjermundgaraba-clankerbox-sdk-0.3.0.tgz --access public --ignore-scripts
```

The local first publication does not have GitHub Actions provenance. Subsequent
workflow publications do. Do not push a release tag for a version already
published manually: the workflow will correctly fail to republish it.

Then configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):

1. Create the GitHub environment **`npm`** in this repository's settings. Restrict
   it to `sdk-v*` tags and enable required maintainer approval if available.
2. In the npm package's **Settings → Trusted Publisher**, choose GitHub Actions:
   - Organization/user: `gjermundgaraba`
   - Repository: `clankerbox`
   - Workflow filename: `publish-sdk.yml` (not the full path)
   - Environment: `npm` (must match the workflow exactly)
   - Allowed action: permit direct **`npm publish`**.
3. Protect `sdk-v*` tags against unauthorized creation, updates and deletion.
4. After verifying trusted publishing, prefer npm's **Require two-factor
   authentication and disallow tokens** publishing-access setting.

No `NPM_TOKEN` or other npm secret is needed in GitHub. The workflow uses a
GitHub-hosted runner, `id-token: write`, and npm OIDC authentication. Trusted
publishing requires npm >=11.5.1 and Node >=22.14.0; the workflow's pinned Node
26.8.2 distribution includes a suitable npm CLI. It publishes with provenance
from this public repository.

## Subsequent releases

1. Change `protocol/package.json` to a new stable semver version. Update the
   compatibility documentation if the controller contract changed.
2. Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, `pnpm test`
   and `pnpm test:package` from `protocol/`. Commit the release changes and wait
   for CI on that commit to pass.
3. Tag that commit with **`sdk-v<VERSION>`** and push the tag. For example, after
   bumping the SDK to 0.2.1:

   ```sh
   git tag -a sdk-v0.2.1 -m 'SDK 0.2.1'
   git push origin sdk-v0.2.1
   ```

4. Approve the `npm` environment deployment if configured. The
   [publish workflow](../.github/workflows/publish-sdk.yml) verifies that the tag
   exactly matches the SDK version, checks/builds/tests, packs, installs and
   smoke-tests the exact tarball, then publishes it publicly to npm with
   provenance. Publishing uses npm; building and packing use pinned pnpm.

Normal `v*` binary-release tags do not publish the SDK. Prereleases are deliberately
not supported by this workflow, so a prerelease cannot accidentally replace npm's
`latest` dist-tag. Add an explicit prerelease policy before introducing them.

For a transient failure before publication, rerun the failed workflow, or use
`gh workflow run publish-sdk.yml --ref sdk-v<VERSION>` after the workflow is on
the default branch. Branch dispatches and mismatched tags are rejected. If npm
already accepted the version, do not move the tag or try to overwrite it; verify
the published artifact and use a new version for any correction.

## Consumer migration

Replace the old vendored `@clankerbox/sdk` tarball dependency with an exact
`@gjermundgaraba/clankerbox-sdk` version, update imports (including subpaths),
and regenerate the consumer lockfile. Remove the vendor artifact and any Docker
copy step that only existed for it. Keep Connect transport dependencies in the
consumer and qualify against its pinned controller release.
