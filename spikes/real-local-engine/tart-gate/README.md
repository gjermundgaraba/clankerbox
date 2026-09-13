# Maintained Tart qualification gate

This nested module uses the product HostService and SessionService. It tests the
unprivileged guest boundary, terminal input/resize/resume, cold stop/start disk
persistence, and a same-session probe after the host daemon restarts. The normal
`tests/live_lifecycle.py` and `tests/live_checkpoints.py` own public Tart lifecycle
and checkpoint coverage; this gate retains final-system-daemon privacy coverage.

Build outputs belong in a fresh directory under `.work`, never this source directory:

```sh
CLANKERBOX_SIGNING_IDENTITY=EXISTING_IDENTITY_HASH \
  spikes/real-local-engine/tart-gate/build.sh .work/NEW_TART_BUILD
python3 spikes/real-local-engine/tart-gate/prepare.py \
  --root /SHORT/NEW_GATE_ROOT --seed EXISTING_REUSABLE_SEED_DIRECTORY \
  --tart-app PINNED_TART_APP --host-binary .work/NEW_TART_BUILD/clankerbox-host \
  --guest-binary .work/NEW_TART_BUILD/clankerbox-guest-darwin-arm64 \
  --gate-binary .work/NEW_TART_BUILD/tart-gate
```

Preparation reads the selected seed, creates a private clone and content inventory,
initializes the fresh product host authority, and generates `system-host.plist`.
It never starts a VM, changes an existing seed, or modifies production services.
The seed must already contain the generic Clankerbox workload/bootstrap accounts.

An administrator installs the generated plist at
`/Library/LaunchDaemons/LABEL.plist` (its exact generated Label), root:wheel 0644,
after proving that label is absent, and runs `launchctl bootstrap system PATH`.
Preserve the existing signing identity; verify Local Network access for this exact
signed executable running as the plist's ordinary user. No broad sudoers grant is
required. Follow the current personal-cloud runtime runbook for administrator
and privacy interactions; never replay old gate installation wrappers.

Run `tart-gate run ROOT`. It refuses an existing machine intent. A successful run
writes explicit `probe.json`, including the retained session, token, lost cold
session and resume cursor. After an administrator restarts only the gate host
service, `tart-gate probe ROOT` requires that proof and verifies continuity. There
are no hard-coded historical session IDs or cursor fallbacks. `resume` continues
inspection of the existing named machine; inspect any ambiguous operation before
continuing. Never replay `run` to resolve uncertainty.

Finish with `tart-gate stop ROOT` and `tart-gate delete ROOT`, inspect empty owned
machine/native inventories, boot out only the gate label, verify its absence, and
remove only its exact installed plist after comparing it to the generated file.
Keep the private report/root until evidence is recorded. Reusable source seeds and
production signing/privacy grants remain untouched.
