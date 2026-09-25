---
name: bump-tart
description: Upgrade clankerbox's Tart baseline and review upstream changes for compatibility and useful capabilities.
disable-model-invocation: true
---

# Bump Tart

Upgrade the Tart baseline and fix compatibility issues; report optional feature opportunities separately. Do not deploy, alter production hosts or seeds, or commit unless requested. Preserve unrelated working-tree changes. A candidate that lacks required native qualification is **not** a qualified release.

Paths below are relative to this repository unless stated otherwise.

## Establish source and scope

- Read the current `tart --version` checks in `images/stage-mac.sh` and `images/finalize-mac.sh`, `scripts/release/inputs/tart-prepared-qualification.md` for the previously qualified executable and image, and `scripts/WORK_RUNS.md` for disposable work. The host uses the operator's absolute `tart_path` (`internal/host/host.go`); unlike image staging, it does **not** enforce a version or executable hash. Distinguish the script-enforced version, recorded qualification hash, configured host path, and macOS guest-image pin.
- Resolve the latest **stable published** `cirruslabs/tart` release and tag/commit from upstream release metadata, unless the user specifies a target. Do not infer a target from upstream main, Homebrew's installed version, or cached HEAD. Record old and target versions/commits and check ancestry; if already current, report that. If the release cannot be verified, state the limitation.
- Maintain a reusable read-only source cache at `~/.cache/checkouts/github.com/cirruslabs/tart`. Partial-clone if absent and fetch missing refs; inspect old and target refs with `git show`, `git diff`, or a private temporary extraction. Never edit, reset, or switch the shared checkout. Use a separate private checkout or installation for build and live tests; do not upgrade the operator's installed Tart as a side effect.

## Review before changing the baseline

- Inventory the complete changed-file set and release notes between old and target, then inspect relevant source and tests. Trace Tart CLI, output and JSON schema changes and macOS/Virtualization behavior to actual consumers: image staging/finalization, `internal/host/` runtime and profile commands, networking, guest execution, clone/fork/checkpoint/restore, stop/delete, seed compatibility, and supervisor/reconciliation behavior. Check changed defaults, feature gates and migration requirements. A successful version check or compilation does not establish compatibility.
- For each breaking change, identify the upstream behavior and local consumer, implement necessary fixes, and add regression coverage for the changed contract. Inspect opportunities worth adopting at the target version, including behavior already available but unused; verify its actual scope and user benefit. Separate inherited benefits from optional implementation. **Report** optional opportunities with local touchpoints, trade-offs and smallest useful validation; do not bundle them into the bump.

## Verify and hand off

- Update both image-script version checks together and any affected tests/documentation. Verify the exact target executable and its provenance before native tests; do not treat a version string as a content hash. Reassess whether host-side enforcement needs changing, but do not introduce a new deployment policy silently. Keep the separately pinned guest image and prepared seed unchanged unless the upgrade actually requires a new image and its qualification.
- Run focused host and image-staging tests, then isolated live macOS/Tart lifecycle, guest execution, networking and disk-copy/checkpoint tests where available. Use `scripts/work_runs.py` for new disposable builds/qualification; follow `AGENTS.md` and `scripts/WORK_RUNS.md` for owned VM/job teardown, reusable seed clones and evidence. Do not mutate a production service, native Tart installation, or the only local seed.
- Report the version/ref transition, exact executable provenance, compatibility fixes, checks actually run, missing native checks, and worthwhile optional opportunities. If live qualification is unavailable, hand off an explicitly **unqualified candidate**; do not claim release readiness. Report remaining runtime resources and retained disk artifacts separately, with size and reason.
