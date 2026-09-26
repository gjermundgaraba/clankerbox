---
name: bump-smolvm
description: Upgrade clankerbox's smolvm runtime and review upstream changes for compatibility and useful capabilities.
disable-model-invocation: true
---

# Bump smolvm

Upgrade the qualified smolvm inputs and fix compatibility issues; report optional feature opportunities separately. Do not deploy, alter production hosts, or commit unless requested. Preserve unrelated working-tree changes. A candidate that lacks required native qualification is **not** a qualified release.

Paths below are relative to this repository unless stated otherwise.

## Establish source and scope

- Read the current source commit and release URL in `scripts/release/inputs/pins.json`, and the source/patch/artifact rules in `scripts/release/inputs/README.md`. Use `scripts/release/README.md` for build and assembly, `scripts/release/inputs/smolvm-1.19.0-qualification.md` for the previous qualification contract, and `scripts/WORK_RUNS.md` for disposable work. Follow their links only when relevant to the proposed change.
- Resolve the latest **stable published** `smol-machines/smolvm` release and its tag/commit from upstream release metadata, unless the user specifies a target. Do not substitute upstream main, an installed executable, or cached HEAD. Record old and target versions/commits and check ancestry; if already current, report that rather than manufacturing a bump. If the release cannot be verified, state the limitation.
- Maintain a reusable read-only source cache at `~/.cache/checkouts/github.com/smol-machines/smolvm`. Partial-clone if absent and fetch missing refs; inspect old and target refs with `git show`, `git diff`, or a private temporary extraction. Never edit, reset, or switch the shared checkout. For builds, create a private checkout with the target ref and its **release-matched** submodules; do not build in the shared cache or replace submodule commits with branch heads. Keep distinct the upstream checkout, patched build source, and the isolated clankerbox release checkout required by `scripts/release/README.md`.

## Review before changing pins

- Inventory the complete changed-file set and release notes between old and target; inspect relevant source, tests and submodule changes. Trace changes to clankerbox's actual smolvm invocations, lifecycle and recovery assumptions, disk templates and sizing, agent protocol, image staging, networking, isolation, fork/checkpoint semantics, and runtime libraries. Search `internal/host/`, `images/`, `scripts/release/`, and affected tests as needed. Changelogs and successful compilation do not establish runtime compatibility.
- For each breaking change, identify the upstream behavior and local consumer, implement the necessary fix, and add meaningful regression coverage. Rebase `scripts/release/inputs/runtime.patch` deliberately: check which hunks upstream absorbed, conflicts, and changed invariants rather than mechanically reapplying it.
- Identify new features or simplifications worth adopting, including capabilities already available at the target but not used locally. Verify they work at the tagged ref and with the relevant platform/feature gate; distinguish automatically inherited benefits from work requiring local changes. **Report** optional opportunities with benefit, local touchpoints, risk and smallest useful validation; do not add optional features as part of the bump.

## Build and verify the candidate

- Follow the release-input rules rather than changing a version string alone: pin the target source, release-matched libkrun/libkrunfw, toolchain/build provenance, patch and source hashes, platform engine and agent binaries, and verified native libraries/templates in `scripts/release/inputs/` as applicable. Preserve licensing/notices and bundle provenance. Do not bless arbitrary locally produced files as qualified artifacts or relabel old checkpoint identities. Update documentation and tests for the new baseline, leaving historical qualification records historical.
- Run focused tests for changed contracts and release-input checks; perform platform builds, assembly, and live qualification where available. Use `scripts/work_runs.py` for new disposable builds/qualification, register teardown for independently managed native jobs and VMs, and obey seed/cleanup rules in `AGENTS.md` and `scripts/WORK_RUNS.md`. Keep production installations and existing seeds untouched. Do not treat build success as a substitute for macOS/arm64 and Linux/amd64 native behavior checks.
- Report the ref transition, compatibility fixes, tests and platform evidence actually obtained, outstanding risks, and worthwhile optional opportunities. If a required platform or live test is unavailable, hand off an explicitly **unqualified candidate**, listing the missing checks; do not claim release readiness or publish it as qualified. Report remaining runtime resources and retained disk artifacts separately, with size and reason.
