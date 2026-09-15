# Prepared Tart guest qualification — 2026-09-14

## Scope and image construction

Fresh macOS guests on `mac-workstation` (Apple M4 Max, 64 GiB RAM, macOS
26.6.2 / build 25G83, APFS), using pinned Tart 2.36.0 and Softnet
0.23.0-e5fd48c. This qualifies the prepared-image host changes and the full
`images/stage-mac.sh` → `images/finalize-mac.sh` path. It is **not a production
deployment or a Tart performance comparison**. Linux benchmark results remain
in [prepared-image qualification](prepared-image-qualification.md).

The 69 GB public image was freshly downloaded into a new private Tart home:
`ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:e0721ddeae3c7c037b764c1aebd0b2d245495c16622413f5a567d7110d18d863`.
The production seed was never a writable input. The finalizer copied and
verified the Apple-signed host Xcode, installed the matching Darwin guest binary,
created locked workload UID 1001 and wrote the prepared-image marker. It passed:

- macOS 26.6.2 / 25G83; Xcode 26.6 / 17F113.
- Swift compile/run with Swift 6.3.3.
- Pinned Node 26.8.1 archive checksum; npm 11.19.0; Python 3.14.7.

The isolated profile used four vCPUs and 8192 MiB RAM. Stopped seed files
`config.json`, `disk.img` and `nvram.bin` were hashed and privately APFS-cloned
into the newly initialized host; native sockets were not copied. The image pin
is SHA256 of the canonical sorted-key compact JSON inventory of those files.

## Host identity and recovery

The final host was built by `scripts/release/build-mac-host.py` as
`0.5.0-prepared-tart`, using the existing Apple development identity and
`org.clankerbox.host` bundle identity. It ran as an explicitly owned user
LaunchAgent, with the ordinary VM supervisor and network isolation rules.

An initial disposable host socket configuration was rejected before any VM
operation. It was corrected inside the empty owned environment. An ad-hoc host
and then the signed host could boot/bind the guest but were blocked by macOS
Local Network policy. The operator explicitly enabled Local Network access.
Restarting only the owned host reconciled the original `preparing` operation;
no replacement VM or second boot was substituted. That rejected fixture was
stopped/deleted through the API, and qualification restarted on a **fresh** VM.
Failed-attempt evidence is retained separately, not counted as a successful run.

## Live qualification

- Lifecycle: dirty/staged Git data, executable modes and symlinks survive
  stop/start; stopped sessions reject; cold boots retain machine identity and
  change manager incarnation.
- SDK: UID 1001, no privileged workload groups or sudo escalation, private
  binding/state/admin-socket isolation, root-owned non-writable guest executable,
  filtered daemon environment and 8 MiB retained-prefix resume.
- Public HTTPS/H2 through an owned loopback TLS proxy and SSH tunnel: invalid
  bearer rejection, ordered controls, 64 MiB bidirectional output, independent
  stalled-viewer disconnection beside a healthy sibling, cancel/resume shell
  continuity and explicit session end. This was not production ingress.
- Stopped-disk fork: independent child writes and cold restart; source contents
  unchanged; new machine and manager identities.
- Disk checkpoint: source deletion, two independent restores with fresh machine
  and distinct manager identities, checkpoint deletion, then each restored disk
  survives another cold start with its own contents.

The checkpoint harness now explicitly checks RAM-manager continuity versus
disk-copy manager replacement, including different incarnations between disk
restores. A regression test covers both contracts. `make build`, `make test`
(Go race, 21 Python harness tests and 46 release tests), and `make lint` passed.

## Teardown and production safeguards

All five disposable VMs (including the rejected fixture) and the checkpoint
were deleted through the normal API. Final journal inspection found no live
machines, published checkpoints or unfinished operations. Owned VM jobs and
host LaunchAgent were removed; the controller, proxy and tunnel were stopped.
Private host/controller roots, pulled image/cache and finalized test seeds were
deleted after saving compact evidence. Workstation free space returned to about
107 GiB. No production service was restarted or deployed: its PID/run count,
binary/config hashes and seed file identities, sizes and mtimes were unchanged.

## Artifact identities

| Artifact | SHA256 |
|---|---|
| `bin/clankerbox-host-signed` | `bf2f49395436cd370fd02d71aed936d09d259bad33016f03bc8f9885fe251bcb` |
| `bin/clankerbox-guest-darwin-arm64` | `b2a44f8f2c0a9b1fded71bb025379cad150cc5999e642e334d00e5ec1d9d1e1c` |
| `images/stage-mac.sh` | `dbbd7555e552a6842f5b37ac249d2d002b37948af5f0e92a6a6df044c1919d69` |
| `images/finalize-mac.sh` | `611724da9294de8ad5523fdc667e1544a17e4aa3de16fedb01a8395d327c31b1` |
| Tart executable / isolated runtime pin | `e0d71385a2974229c3e97f71862020cce4911c16c3a2fb74ab5e6f540a62131e` |
| Prepared image inventory pin | `0ee8840dd0b742ed9e14196a6d10f46a2764441cd6f486157a56f6d42e1f0b8f` |
| Prepared seed `config.json` | `be848a3dc7c64878194461846816e3ee8c0921682a7a2c0df4b8fa41c2362823` |
| Prepared seed `disk.img` | `0736c44830e91546651eca70e131e5d96a43b19603ecf33256b6754a3662ca3c` |
| Prepared seed `nvram.bin` | `1d1d90066194f3fc7ff1e1d141cb9310bf6096185cccb646434f4110d0fc213a` |

## Evidence receipts

| Check | SHA256 |
|---|---|
| image preparation | `ca3ad98fc964fc333aca5f68c80dbcd577b027252746337afcc17bccf2df0b54` |
| lifecycle | `d362c8b5f3366130152141a41f9bacb15bb78d1695983b2962eac5605b5da2cd` |
| SDK | `9ae2b7b9feef477bedf30e39ae5a6fca5bd04bdd36724906ca563a89583262bf` |
| public-session | `f6a637a6ed5b57f2b2432f7d82b6526bcf451193d9425ae576d800f7ec9ed3d0` |
| checkpoints | `44cecb05ab7a9aa2e7a5004d9a5400c012dd11990336cd1931b0361e4d2e3084` |
| reconciliation | `082bb0d4942a86809ee994510354048a377af355e952ca87bd888b7b546ba873` |
| cleanup | `ebb7dea7f90a727aeab9e59b2af00cabcef26c05519b86ce947db21df00758dd` |

Private evidence, image/binary inventories, build logs, signing receipt and
failed-attempt journals are retained in `.work/tart-prepared.2J4tT1/`.
`remote-results/` contains original remote reports; `results/` contains the SDK
and HTTPS reports. These files can contain private development credentials; do
not publish the directory wholesale. Large VM images are not retained. A future
deployment must rebuild/finalize a matching image, publish its own image digest
and preserve existing live seeds/checkpoint pins until explicitly retired.
