# Runtime profile qualification — 2026-09-17

## Automated checks

`make build`, `make test` (including the Go race detector), `make lint`, and the
protocol TypeScript check/build/test/packed-consumer checks pass. Five repeated
host/statefs test runs also pass after fixing inherited file-lock release.
Tests cover publication and cancellation fences, admission reservations,
revision retention, interrupted-build recovery, chunked uploads, cleanup failures,
and setup overlapping lifecycle work.

## smolvm: Linux amd64 / KVM and Apple Silicon

Both isolated environments passed the public CLI profile suite with a real
`apt-get`/`jq` installation, plus lifecycle and checkpoint checks. Coverage:

- Successful publication activates a new immutable revision; failed and cancelled
  recipes leave the current revision unchanged.
- Existing running/stopped machines, forks and pre-update checkpoints retain their
  original revision. New machines use the newly activated revision.
- Stop/start completes while the new recipe is still in its setup phase.
- Referenced revisions cannot be deleted.
- Controller crash recovery completes the original build. During a host outage,
  the build becomes `unresolved` and CLI `--wait` continues waiting.
- Host crashes during setup and capture fail without replay or activation.
- Reusing a consumed upload is rejected; expired complete/incomplete staging is
  removed; late publication fails and releases reserved capacity. Expiry was
  accelerated by changing timestamps in the disposable host database, then
  exercising ordinary startup maintenance.
- Removing both the deployed base binding and its artifact does not prevent
  creation/checkpoint/restore from a retained revision. Deleting the profile name
  does not prevent an existing machine from restarting and running its tool.

### Startup performance

Three sequential samples per version on the same host, using the exact same
prepared filesystem, current guest binary, pinned runtime and VM resources
(2 CPUs, 1024 MiB RAM). The baseline uses the previously qualified static-profile
host/controller/client binaries. These small samples detect gross regressions;
they do not establish statistical equivalence.

| Linux amd64 median | Runtime profiles | Static profiles |
| --- | ---: | ---: |
| Create | 4.208 s | 4.215 s |
| Retained start | 1.606 s | 1.606 s |
| Stop | 0.207 s | 0.206 s |
| Fork | 4.216 s | 4.415 s |
| Restore | 12.808 s | 12.808 s |

| Apple Silicon median | Runtime profiles | Static profiles |
| --- | ---: | ---: |
| Create | 5.841 s | 7.628 s |
| Retained start | 2.005 s | 2.203 s |
| Stop | 0.404 s | 0.404 s |
| Fork | 2.101 s | 3.246 s |
| Restore | 24.416 s | 32.815 s |

Neither host showed a startup slowdown in this comparison. The Apple Silicon
results do not establish a general speedup from runtime profiles.

Linux source deletion after checkpoint took 1.820 s versus 1.007 s. The difference
was localized to native deletion, whose Linux implementation is unchanged.
Child and restored-machine deletion timings matched. The three samples ran in
fixed order (candidate before baseline); logs do not separate runtime deletion
from filesystem removal. Cache or storage state may explain the difference, but
no cause or implementation regression is established. Treat this as a measurement
limitation rather than a demonstrated startup regression. Setup and capture remain
publication work, outside machine creation.

## Apple Silicon / Tart

The signed host now connects successfully after Local Network access was enabled.
Native recipe setup, stopped-seed capture, validation, activation, machine creation
and stopped-source fork have passed through the public API.

One full-suite attempt failed stopping the forked child: it remained running after
the guest-command deadline and the subsequent 90-second stop wait. A bounded fresh
reproduction passed, including an 8.3-second child stop. The original intermittent
failure remains unexplained; there is no evidence establishing its cause.
A second full-suite attempt reproduced the child-stop failure. Guest boot logs
and uptime show a reboot inside the native VM after the stop request; the host
launchd job had one run and `KeepAlive=false`. The guest panic report records
`failed to read aon_security` at `attestation.c:517`, with panicked task `ctkd`
and `AppleVPKeyStore` in the backtrace. This explains the reboot during the stop
attempt, but the cause and any relationship to cloning remain unproven. Further
diagnosis is paused pending a scope decision. The remote suite remained blocked at that point; the passing focused retry did
not override the two suite failures. See the separate local result below.

### Recreated local seed and local profile suite

A fresh local seed was prepared from the pinned vanilla image
`ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640`.
It runs macOS 26.6.2 / 25G83 without Xcode. Preparation installed the official Tart
guest agent 0.14.1 and the current Clankerbox guest, configured public DNS/network
time, and verified the guest clock before stopping it. The reusable input is
retained under `.work/inputs/tart-local/` (about 24 GiB); tests use private APFS
clones. Downloaded OCI staging was removed after preparation.

The local create → stop → fork → stop reproduction passed. The complete live
profile suite then passed: successful update, running/stopped/fork/checkpoint
revision pins, new-machine selection, referenced-revision deletion rejection,
intentional setup failure, cancellation, and restart after profile-name deletion.
Stop/start finished in 30.47 seconds while the update remained in setup.

Initial local fixture failures are retained separately: an invalid host socket
location, an unsynchronized vanilla guest clock, and a test attempting three
concurrent macOS VMs. The corrected harness stops the new machine before subsequent
build checks, staying within the native two-VM limit. Failure validation now also
checks that the intended recipe actually ran. A subsequent controller fix also
reserves the native two-VM limit across Tart machines and nonterminal profile
builds, independent of CPU/RAM sizes. Focused admission tests cover mixed runtimes,
unknown states, stopped/deleted machines, builder reservations and start exclusion.
No scheduler or public capacity configuration was added.

Evidence: `.work/runs/t-ada29dd02b5d/evidence/` (successful full suite) and
`.work/runs/t-183aa34024c4/evidence/focused.json` (successful focused sequence).
Both used the same prepared base digest. All disposable local runtime resources
and scratch were removed; the stopped reusable seed and small evidence remain.
The local passes do not establish the cause of the remote panic.

### Local recovery and lifecycle overlap

The subsequent local run passed controller-crash recovery, a 40-second host pause
with `unresolved`/`--wait`, consumed-upload rejection, and host crashes during
setup and validation. Interrupted builds failed without setup replay or activation.
Complete and incomplete uploads expired through ordinary startup maintenance after
advancing their private database expiry timestamps. Late publication failed
terminally and released capacity. A retained revision still supported create,
checkpoint and restore after removing its base binding and artifact.

Creating a machine during a second build's setup took 28.73 seconds; the build was
still in setup afterward. The earlier full suite measured retained stop/start
during setup at 30.47 seconds. These demonstrate lifecycle overlap, not absence of
CPU/I/O contention or a latency guarantee during serialized preparation/finalization.

All recovery assertions passed before a missing Python import aborted benchmark
startup without collecting samples. Automatic teardown verified empty private VM
inventories and no remaining jobs/processes, then removed scratch. The recovery
receipt distinguishes this driver failure from product assertions. The corrected
benchmark-only run subsequently passed. Recovery evidence is retained under
`.work/runs/t-f6faabcaba35/evidence/`.

### Matched local Tart performance

Three sequential candidate samples followed by three static-profile baseline
samples on the same Mac, using the same captured revision, current guest binary,
Tart 2.36.0, 4 CPUs and 8192 MiB RAM. Every sample passed create, retained start,
stop, stopped-source fork, stopped checkpoint, restore and cleanup. The candidate
controller includes the two-VM admission fix.

The baseline host was rebuilt and signed from commit `0bcf968`. Retained static
controller/CLI binaries have pre-commit `37467c1+dirty` build metadata; their
retained source inventory matches the committed controller/CLI Go sources and
`go.mod`. Artifact hashes and provenance are included with the results. Both
variants use the same current guest, rather than different guest revisions.

| Local Tart median | Runtime profiles | Static profiles |
| --- | ---: | ---: |
| Create | 26.297 s | 28.040 s |
| Retained start | 23.739 s | 23.125 s |
| Stop | 6.742 s | 7.347 s |
| Stopped-source fork | 24.604 s | 23.123 s |
| Stopped checkpoint | 0.412 s | 0.368 s |
| Restore | 23.325 s | 25.555 s |

No consistent startup slowdown appears in this comparison. Retained start differs
by 0.614 seconds; observed ranges overlap (candidate 21.16–25.73 seconds, baseline
20.32–26.58 seconds). Native-start medians were 1.147/1.130 seconds and
guest-execution-ready medians 16.308/16.469 seconds. The image-check phase was
0.732/0.380 seconds; these traces localize the small difference without establishing
its cause. Three fixed-order samples do not establish statistical equivalence or
a general speedup. No guest panic occurred in the local samples;
this does not explain or qualify the earlier failing remote environment.

A trivial successful recipe build took 74.4 seconds, separately from machine
creation. Single readiness observations were 0.21 seconds for a candidate
controller restart and 0.43 seconds for launching the baseline services; these
have different scopes and are not a matched service-startup benchmark. The
post-create session probe in the raw results measures a guest command after
create completes, not service startup. Native preparation/finalization queue
latency has no dedicated matched benchmark; those phases remain allowed to delay
lifecycle work, with serialization/release covered by automated tests.

Results and cleanup receipts: `.work/runs/t-c243969cd6f9/evidence/` and
`.work/runs/b-bf8b7c51fc5e/evidence/`.

## Follow-up review fixes and packaged installation

The staging/budget/retarget follow-up passed `make build`, `make test` (Go race
checks and both Python suites), `make lint`, and the protocol check/build/test/
packed-consumer checks. Focused regressions cover:

- Upload-removal failure leaves unrelated lifecycle work usable; subsequent
  maintenance retries it while already-cleaned identities are excluded.
- Local tar staging includes overhead in its size bound, observes cancellation,
  removes temporary files and never uploads a failed archive.
- Development CPU/RAM budgets persist across launches and teardown preparation;
  invalid overrides do not change the recorded budget.
- Successful profile retargeting changes future selection while failed/pending
  builds leave it unchanged. Queued creates, old machines and checkpoint restore
  placement retain their original complete pins.

The existing CLI wait test exposed a 40 ms scheduling assumption during the race
run. Its pending case now allows deadline expiry before the first poll, while
terminal cases have time to obtain an outcome and still require polling. The
single-submission assertion remains. Ten focused race repetitions and the final
full run passed.

A fresh macOS/arm64 smolvm archive was built and installed into a disposable work
run. Packaged `dev --cpus 4 --ram-mib 8192` started with an empty catalog and built
a recipe requiring 4096 MiB. A v1 machine remained running during the v2 build;
it kept v1 while a new machine ran v2. Actual host/controller PIDs remained
unchanged. Stop/delete, profile deletion and `dev destroy` succeeded.

The archive used the retained qualified runtime and original unprepared image.
Verified dependency notices were reused after confirming the same 50 Go module
identities/versions and unchanged `go.mod`; only scratch `go.sum` provenance was
refreshed. Production verification was unchanged. Preparatory fixture failures
(missing cached notice sources, selecting an already-prepared image, and tar
extraction without preserved modes) are retained separately from the passing run.

Evidence: `.work/runs/profile-package-smoke-4c4a7a4fcb5d/evidence/`.
The disposable archive was 914,382,396 bytes, SHA-256
`69a5daa022eb05746449bf0a36e6e4e65b32c87bec81d85a7b20b3a4329490f2`.
All four smoke work runs are cleaned. The successful run retains about 4.4 MiB
of evidence and the preparatory runs another 4.4 MiB, primarily payload inventories
and logs. No scratch, installation, archive, host root, service process or owned
native job remains; six exact VM job identities were checked after destruction.
Existing reusable inputs were unchanged.

The earlier native performance tables precede this follow-up. The packaged smoke
is functional validation, not a new performance benchmark or a repeat of the
full Tart suite. This clean break changes the host upload schema; the development
environment manifest is now version 2. Earlier disposable environments require
recreation, with no migration path.

## Cancellation and contract cleanup follow-up

Cancellation now persists separately from phase snapshots and signals the build
context without taking the native lifecycle lock. A short publication fence orders
host cancellation against ready-revision publication. Controller cancellation
contacts the host directly, resolving admission only when the build is missing.
Cleanup retains its independent deadline and reservations until resources are gone.

Race-tested cases interrupt preparation, capture and validation, exercise the final
publication race, and recover cancelled builds with and without a ready descriptor.
Retained-history coverage verifies admission and upload replay rejection while
recovery selects only unfinished builds. Admission uses indexed existence queries.

Resolved disk validation requires positive smolvm sizes and omitted/zero Tart
sizes. The unused private revision-inspection RPCs were removed; public listing
remains. CLI mutation tests assert exact RPC targets, call counts and errors.

`make build`, `make test` (full Go race suite, 34 work-run tests and 45 release
tests), `make lint`, and SDK type/build/test/package checks passed. Existing
native performance and Tart results above were not rerun for this follow-up.
A bounded local smolvm proof cancelled during filesystem export after observing
nonempty output. The public cancellation request returned in 24.5 ms; terminal
cancellation and confirmed cleanup took 2.43 s. No profile or revision activated.
Both exact native job identities, services, upload archives and scratch were absent
after teardown. Evidence: `.work/runs/c-ecc6607f0a70/evidence/`. Four attempts retain
76 KiB of logs/receipts (including preflight failures); the reusable seed is unchanged.
The retained reproduction driver is `.work/profile-final/cancel_native.py` (8 KiB).

The new host cancellation column is a clean schema break: recreate disposable
host state; no migration is supplied.

## Shutdown, teardown and lease recovery follow-up

The host completion signal now covers lifecycle and profile workers. A blocked
profile-worker regression verifies the database and service lock remain owned
past the shutdown deadline until the worker and native cleanup finish.

Development stop/destruction persists cancellation intent for all nonterminal
builds before restarting controller reconciliation, then waits for terminal
cleanup before ordinary resource teardown. Regression tests cover unresolved
cleanup, retained environment/journal, successful retry, and persisted cancellation
without changing terminal results.

Port release matches the durable host-root/machine identity, including when a
crash leaves the manifest port zero. A recovery regression models validation lease
allocation before journal persistence and verifies unrelated leases survive.

`make build`, the full Go race suite, all 79 Python tests and `make lint` passed.
These checks used controlled failure injection; no new native VM qualification
was run and no disposable runtime resources or evidence artifacts were created.

## Outcome and contract simplification follow-up

Cleanup retries now preserve the persisted execution outcome, replace their latest
error, and run at a paced interval independently of reads. Regression coverage
includes repeated cleanup failure, restart after validation, cancellation during
cleanup, and existing admission despite changed configuration/native contention.
Controller coverage distinguishes typed refusal, busy admission and lost replies;
checks visible/retryable deletion; and checks inferred placement, explicit host
constraints and idempotent creates after profile changes.

Build, full Go race suite, all 79 Python tests, lint, generated SDK type/build/tests
and packed-package checks passed. One initial full race run hit the existing
one-second guest-readiness diagnostic test; three focused repeats and the full
rerun passed. Later focused race checks cover the final recovery/reference tests.

Local smolvm evidence: `.work/runs/s-de88fe968b41/evidence/`. The smoke published a
revision, created with inferred placement, executed its installed root tool, and
deleted the machine/profile/revision. It then cancelled a second build during
nonempty filesystem export: request 30 ms, confirmed cancellation/cleanup 2.124 s.
All five exact native job identities, services, uploads and scratch were absent
after teardown. Reusable inputs were unchanged. A preflight path-length failure
and a corrected harness response-key failure also cleaned safely; their receipts
are retained. Total new evidence is 104 KiB, plus a 12 KiB reproduction driver
at `.work/profile-final/profile_cleanup_smoke.py`.

The full Tart suite and native performance benchmarks were not repeated. This
follow-up changes build/revision records and protobuf contracts; recreate
disposable state and use the regenerated SDK. See ADR 0008 for the revised outcome
and admission rules.

## Cleanup

Both smolvm environments were removed after verifying no test machines,
checkpoints, host jobs, upload archives or processes remained. The Linux production
fingerprint was unchanged. All Tart attempts also ended with empty private VM
inventories and no test host/controller processes or native jobs. Four stopped
native jobs left behind after failure were removed only after verifying their
paths belonged to the disposable test roots. The Tart production fingerprint
was unchanged.

The final local recovery and benchmark runs also verified empty private native
inventories and no owned jobs/processes before removing scratch. Their archived
receipts/logs occupy about 296 KiB. The temporary baseline compiler checkout and
newly built baseline host binary were removed. The reusable stopped Tart seed
and pinned runtime remain under `.work/inputs/tart-local/` (about 24 GiB), with
provenance and a ready marker, so future qualification needs no seed transfer.

## Scope and reproduction

Linux recipes target root-run tools/packages and do not depend on preserved
service-account ownership or file capabilities. Setup is assumed to finish all
installation work and stop background writers before exiting. There is no process
inspection or enforcement of that assumption.

Use [the live profile harness](../tests/live_profiles.py) and the commands in
[the acceptance-test guide](../tests/README.md) against disposable environments.
Service crashes, base retirement and accelerated expiry require environment-level
control. Run receipts and host logs for this qualification are retained locally
under `.work/profile-final/`; that ignored directory is not a portable release
artifact. Historical benchmarks alone do not qualify runtime profiles.
