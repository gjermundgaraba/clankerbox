# Prepared-image lifecycle qualification — 2026-09-14

## Scope

Candidate `0.5.0-prepared-candidate3`, manifest format 3. Linux guests on an
Apple M4 Pro / 48 GiB / macOS 26.6.2 / APFS host and an AMD EPYC 7502P /
128 GiB / Linux 7.0 / ext4 KVM host. The profile is `linux-dev-v3`: two vCPUs,
1024 MiB RAM, 1 GiB storage and 8 GiB overlay. No production deployment.
The later [Tart qualification](tart-prepared-qualification.md) covers fresh macOS
image finalization and live correctness checks; the measurements below remain
Linux-guest-only. Do not overwrite an existing seed or relabel checkpoints.

The baseline is the previously qualified `0.4.0-smolvm1.16.0-candidate3` bundle,
not the old 0.4.0 runtime. Both use the same pinned smolvm 1.16.0 engine, agents,
libraries, compact disk templates, Ubuntu and package inventories. Candidate
assembly adds the prepared account/permissions/guest binary on an output copy.
Existing notices and input provenance were verified using a matching isolated
checkout; the main repository module files were not expanded.

## Measurements

`tests/benchmark_lifecycle.py --samples 3` ran on fresh disposable environments.
Each sample measures the ordinary create, stop/start, fork, checkpoint, restore
and deletion APIs and verifies guest identity. Values below are **median seconds
from durable acceptance to controller completion**, excluding client polling and
extra identity probes. Complete-cycle is the median of each 13-operation sum,
not a sum of per-phase medians. Every measured operation succeeded.

These are sequential candidate-then-baseline runs on active hosts, not a randomized
isolated laboratory or a latency guarantee. No release builds or unit suites ran
during timed samples. Filesystem cache, background workloads and brief baseline
artifact staging can affect results, particularly checkpoint/restore timings.

| Operation | Mac baseline | Mac candidate | Linux baseline | Linux candidate |
|---|---:|---:|---:|---:|
| create | 43.98 | 7.83 | 47.29 | 4.41 |
| retained-start | 23.78 | 2.20 | 44.71 | 1.61 |
| fork | 25.14 | 3.26 | 45.57 | 4.41 |
| checkpoint | 35.35 | 20.05 | 21.02 | 20.42 |
| restore | 68.41 | 37.82 | 54.50 | 12.41 |
| complete-cycle | 211.89 | 84.41 | 222.07 | 48.23 |

Candidate create phase medians (nested phases must **not** be added):

| Host | Private image materialization | Native start | Guest preparation |
|---|---:|---:|---:|
| darwin-arm64 | 5.26s | 1.14s | 1.22s |
| linux-amd64 | 1.88s | 0.93s | 1.31s |

The remaining large costs are private image materialization and native snapshot
capture/restore, not recursive guest provisioning. APFS cloning still walks the
image tree; Linux ext4 retains private-copy semantics when reflinks are unavailable.
Investigate native restore/copy costs before introducing pools. Sharing a lower
root or adding concurrent host mutations remains a separately qualified engine/
scheduler change, as described in [lifecycle performance](../../../docs/lifecycle-performance.md).

## Correctness and teardown

- Both platforms passed the live lifecycle matrix: staged/unstaged Git data,
  executable modes and symlinks, stopped-session rejection, and cold manager
  incarnation changes with preserved machine identity.
- Both passed RAM forks/checkpoints: memory identity and disk isolation, source
  restart with retained children, source deletion, two independent restores,
  checkpoint deletion, and retained descendants' cold restarts.
- SDK qualification passed nonroot/private-state/executable ownership, sudo and
  environment isolation, and 8 MiB retained-prefix resume.
- Public HTTPS/H2 qualification passed invalid-bearer rejection, ordered controls,
  64 MiB bidirectional flow, bounded unread/stalled viewers beside healthy siblings,
  cancel/resume shell continuity and explicit end. These used owned loopback TLS
  proxies (plus a Linux SSH tunnel), not production ingress.
- An earlier local candidate failed trusted-ancestor ownership. It was rejected,
  narrowly reconciled on its identified disposable fixture, then normally deleted.
  The final candidate adds bounded guest-root overlay ownership and a regression
  test; it does not restore recursive provisioning.
- Candidate and baseline VMs/checkpoints, environment host jobs and roots were
  deleted through the matching CLIs. Owned proxies/tunnels were stopped. The Linux
  production service PID/start time and binary/config hashes were unchanged.
- Final `make build`, `make test` (Go race, 20 harness and 46 release tests),
  `make lint`, and protocol check/build/seven tests passed.

## Candidate identities

| Platform | Identity | SHA256 |
|---|---|---|
| darwin-arm64 | manifest | `2dd9c80d0a193537af9567a8ba3246545e2167f10b212adf005ace556645c75c` |
| darwin-arm64 | runtime | `4a9570ecf4ed50471d57a2286ee2000a0f9ffa4b9bc1df617e1154ba6539cf11` |
| darwin-arm64 | image | `4c9323985e21bcc5aa06d4d04e32477e9af72574a30a51273ee48639d6949fe5` |
| linux-amd64 | manifest | `f09c4213095d73255702dc23fca0c44b59e7ce055adf449a4d51c014e8c50f59` |
| linux-amd64 | runtime | `75156912ac4dfa6b9679fe1b4d70380c7083efdad86904f5b8f5c7bc38ce0d33` |
| linux-amd64 | image | `8142971a14b9b033e7b18c3ec3d82cffb4cb44604b4e7c52ad75f12d9f65e512` |

## Evidence receipts

| Platform | Check | SHA256 |
|---|---|---|
| darwin-arm64 | candidate benchmark | `d9616dcf90cacdd91cf34ee121d8631ba614432c1b0e29718795e8a46ea0a3d9` |
| darwin-arm64 | baseline benchmark | `b7517ee35b82afc8878202c72c82ca602104a96d4ef5712ed84319ca4262e081` |
| darwin-arm64 | lifecycle | `1e3c1bc9e982aea6ae52bb274caab5029b48703a80260f5dcdaf0e20d8306160` |
| darwin-arm64 | checkpoints | `74b6d6bc56dac17980bca1229838e06a328d7460c0a3fe1a5a81683d7b3b6899` |
| darwin-arm64 | sdk | `6ff1b55d339d4737c454bfb5d082d1fc274562ccc5cf677c262a0c21613b50b0` |
| darwin-arm64 | public-session | `e7618554f5861f68737698ede9185b6c81d92e3bcfaa86baca77f03acdf67591` |
| linux-amd64 | candidate benchmark | `27b4f3787d4dd8aa475572943483b0b81912572a51ad582552a3f7caa0ab00b6` |
| linux-amd64 | baseline benchmark | `d375d769ffc7741ba8311382f49a4c2a632f187380e27357a885b1f718be0df3` |
| linux-amd64 | lifecycle | `caebd7b02eda1bc68e4ba806795c7e471fa4ecbfeee08607d15756a471d2b0b2` |
| linux-amd64 | checkpoints | `d6f8d27788b3bfa341c828dd94bba65f3edfb3c40169dab9a380bcd2dd1e4cf0` |
| linux-amd64 | sdk | `59c7aba9bb0c2a382fe3df9680cdaf886c3fbf10056dc3e1d7c92e03b6818cc8` |
| linux-amd64 | public-session | `656d8fd7c56b6b55fd7d40fe4e1c5628d59a3bb6729e13651993274addd67d50` |

Private manifests, journals, timings, logs, failed-candidate evidence and notices
are retained in `.work/lifecycle-perf.3eN9Id/`; candidate results are in
`local-results3/` and `linux-results3/`, and baseline results in
`local-baseline-results/` and `linux-baseline-results/`. They can contain private
development credentials: do not publish the directories wholesale. The original
runtime and corresponding source remain in `.work/smolvm-1.16.0-update/` as
documented in [runtime qualification](smolvm-1.16.0-qualification.md).
