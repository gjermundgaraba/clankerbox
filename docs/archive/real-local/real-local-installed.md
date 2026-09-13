> Historical qualification evidence. Its experiment implementation is retired; use current product acceptance harnesses.

# Installed release and Desk qualification

This records disposable installed-release checks for the generated RPC cutover.
It is evidence, not an alternative development launcher.

## Apple Silicon and Desk

On 2026-09-12 an ordinary installed CLI started the controller and retained host
service from a self-contained bundle without Go or Rust in the runtime PATH.
The controller URL came from its generated `clankerdesk.json`. Clankerdesk used
its built Node 26.8.2 server, checked-in generated SDK artifact, built website,
and normally published extensions.

Through the actual browser UI, a fresh workspace allocated a fresh 2-vCPU,
1024-MiB Linux VM and guest-owned terminal. The terminal reported `aarch64`,
unprivileged UID 32001, and shell PID 2866. A file written in its home directory
and that shell PID survived a browser reload and a restart of Desk alone. Window
enlargement exercised terminal resize. Explicit terminal close ended the guest
session; separate typed stop and delete operations removed the disposable VM.

- Machine: `744dc8c9e24fe09341737c6b908d8d08`
- Desk session: `be7d3844-cde1-468c-bb1b-eb7aabcac8fc`
- Guest session: `d379a915-f56b-4ad9-a374-64076ee00264`
- Guest incarnation: `91ac540d-4aa3-49ff-aec5-02b816ba16f3`
- Stop operation: `fad8ce20cb034776782ae9d282ffde34` succeeded
- Delete operation: `9457a9a56dff91b0c6aaf591f62e2e8d` succeeded

Private machine/session/cleanup evidence was saved under
`/tmp/clankerdesk-real-rpc-{sessions,ended,cleanup}.json`. This browser pass used
one viewer. The separate Linux pass below must qualify simultaneous viewers.

The existing Vite+ ready pipeline passed after the cutover, including 107 server
tests and seven real Chromium tests. The browser suite keeps a viewer open over
Desk restart, checks automatic reconnect and the preserved shell PID, and accepts
new keyboard input afterward. It uses a generated HTTP/2 fixture with real PTYs;
that coverage is distinct from the installed real-VM pass.

Pinned protocol regeneration left all eleven generated Go/TypeScript files
byte-identical. SDK check/build and all four SDK tests passed. All ten built SDK
files match the vendored Desk tarball exactly.

## Linux installed release

On 2026-09-12 the self-contained Linux/amd64 archive was installed into a new
owner-private directory under `/home/clanker/cbi-installed-20260912-linuxqual`.
Ordinary `clankerbox dev` from empty projects found its adjacent manifest with
`PATH=/usr/bin:/bin`, without Go, Cargo, repository code, or `--bundle`. KVM and
the ordinary user's systemd manager were available. Inventory began empty.

Two simultaneous environments passed `tests/live_lifecycle.py`: dirty Git index,
worktree and untracked files, executable mode, symlink, cold-start identity change,
and typed rejection of a stopped session. Inventories, namespaces, host roots,
controller endpoints, and credentials were independent. A token from one
controller was rejected by the other. Environment F was destroyed while E remained
interactive.

### Two real browser viewers

The machine and terminal were created through the actual native browser UI.
Native window access then failed with `cgWindowNotFound`; the existing Vite+ and
Chromium runner continued against that actual Desk and VM, with no controller or
guest fixture. Two independent browser contexts exchanged input/output through
one shell, retained its PID and a shared file after resize and both reloads, then
retained both after Desk and controller restarts without reloading the viewers.
Both viewers accepted new input after each restart.

| Identity | Value |
| --- | --- |
| E lifecycle machine | `edcda1db69199d09b6a8ee4040854100` |
| F lifecycle machine | `c563e69ecdb4e2dcabfaeec466b93fa1` |
| Desk machine | `abe9fc39f012d7d45b8a24a8e6d49fbb` |
| Workspace | `5d713942-0b80-461d-8cf2-40a116eae440` |
| Desk session | `cf6a6fb6-9cea-4d5d-85f2-86eaeeb4923f` |
| Guest session | `5aa4532e-a0f1-4399-866d-effc600a5ca0` |
| Shell | PID 3118, UID 32001, `x86_64` |

Operator SSH forwarded only public loopback controller bytes to the local Node
26.8.2 Desk server. Desk used the generated HTTP/2 SDK; the managed
controller-to-host-to-guest path remained typed RPC. This does not qualify the
production domain or reverse-proxy deployment.

Evidence: `.work/linux-installed-qualification-20260912/two-viewers-final.json`
and its `.first.png` and `.second.png` screenshots. An initial attempt typed while
the reconnecting workspace was still inert. The final test waits for input
readiness and confirms focus; this corrected test synchronization without changing
product behavior. The opt-in test and its invocation are documented in
Clankerdesk's `docs/terminal.md`.

Explicit Desk terminal close produced guest EXITED/SIGKILL status. Desk machine
close then stopped/deleted its VM. The lifecycle sources and E/F environments were
also removed through recorded operations and `dev destroy`.

### Format-2 update and full checkpoints

A fresh format-2 environment G passed lifecycle acceptance, then an explicit
compatible update replaced the host PID (2018812 to 2021058) while retaining its
running machine and guest-manager incarnation. Runtime/image pins and profile
parameters were verified equal before the update.

The updated `tests/live_checkpoints.py` passed **49 recorded events**: real RAM
fork with the same in-memory process, independent fork disk/cold restart, a
source-delete dependency rejection, checkpoint capture and source deletion, two
independent RAM-continuing restores with fresh machine identities, checkpoint
deletion, restored disk cold-start independence, and complete resource cleanup.
Capture memory/identity and both restored memory samples are saved in the report.

| Artifact or identity | Value |
| --- | --- |
| Initial format-2 archive SHA-256 | `59eda7d90d1d9f3213623aad508e904737ca60f4a8cd570489e38e1158f00df8` |
| Tested compatible replacement archive SHA-256 | `560dff25cd720c2155365346c847c3664aec6c078db793f81448b3850c3bb628` |
| Runtime digest | `e4ed84bd8026b44f2f077ca1c2d5fae71ccb73527dff5622b838e2252c07f956` |
| Image digest | `f7c5915a20c0c4aa8f823776c7dea73d8df63a8b056b8acbcd2600877c5f02a8` |
| Source | `50d8c6dfc39f00324a84d5832468252c` |
| Checkpoint | `e4c845b112ab6695ef6454623c5b66e5` |
| Restores | `f596b42811bbd09d45b10621cd533155`, `12fcf70a178f6ad849f94b7f023e627d` |

The report finished `status: passed`, `cleaned: true`, with no pending mutation.
`dev destroy` removed G's empty environment. All qualification Desk servers and
operator tunnels were stopped. The preexisting production host PID 1999841 stayed
unchanged. Settled evidence is copied under
`.work/linux-installed-qualification-20260912/remote-evidence/`, including
`lifecycle-g.json`, `compatible-upgrade.json`, `checkpoints-g.json`, and
`production-host-after.txt`. The replacement predates the subsequent Mac-driven
interrupted-upgrade CLI recovery fix; host/controller/guest behavior qualification
is for the exact archive above.

### Corrected preparation failures

The first candidate failed before creating a host service or VM because the Linux
native socket path exceeded the platform limit. The qualified implementation uses
the owned short shared native cache layout.

A later attempt extracted GNU tar under `umask 077` without `-p`, stripping guest
executables to 0700. The original image export had root mode 0755, while its
prepared input had lost that mode. No live guest was modified to bypass this:
the failed machines were stopped/deleted and their environment destroyed. A
qualification-owned image copy restored the original archive root mode and the
mountpoint modes; installation used `tar -xzpf` inside an owner-private directory.
Format-2 manifests now bind and verify semantic filesystem modes and types.
Failure and cleanup evidence remains in
`.work/linux-installed-qualification-20260912/evidence.json` and the private
remote evidence directory. These preparation failures are distinct from the
successful final behavior checks.

## Final macOS full contract rerun

The fresh corrected format-2 macOS run passed both ordinary harnesses without
operator reconciliation: `.work/real-local-release/mac-final-lifecycle.json`
and `mac-final-checkpoints.json`. The lifecycle retained dirty Git/files/modes
through a cold start and rejected access while stopped. Checkpoints exercised
RAM fork, dependency rejection, capture/source deletion, two continuing restores,
checkpoint deletion, both restored cold starts, and complete cleanup. Capture
PID 2808, incarnation `c6bea7af-464f-487f-ae58-97362a9be644` and the recorded
in-memory token continued in both RAM restores. Checkpoint identity was
`97c2fbedc171c12bb0fcfd9176dbd6a0`.

The old interrupted/recovered reports remain failure/recovery evidence. They
were not rewritten to substitute for the fresh passing run. `dev destroy`
removed environment D; final independent audit found A–E state absent, no owned
native jobs/VMs, and empty local port leases. Unrelated smolvm workloads were
untouched. The separate Tart fixture still awaits system-daemon qualification.

## Final rc5 Linux extracted-archive consumer smoke

The corrected, platform-specific archive
`clankerbox-0.2.0-rc5-linux-amd64.tar.gz` passed a fresh installed-consumer run.
Its SHA-256 was verified locally and after upload:
`490671134bebca1cdbbd193abf0fccbc1802b34cf14a95382bc16e519d47c50e`.
The archive was extracted with `tar -xzpf` under a new mode-0700 parent,
`/home/clanker/cbi-rc5-consumer-20260912`. The extracted CLI ran ordinary `dev`
from an empty project, discovering and verifying its adjacent bundle without
`--bundle`. Host PATH was `/usr/bin:/bin`; Go, Cargo, and Rust were absent from
that PATH. The separately supplied test-only session adapter was built on the
operator machine and is not a product installation dependency.

The initial inventory was empty. The real lifecycle/session harness passed for
machine `53ef16df0b0f924d178c06ec65a9cace`: dirty Git state, untracked files,
executable modes and symlinks survived cold start; stopped session access was
rejected; machine identity stayed stable and guest incarnation changed. This
smoke closes the final archive naming and current CLI/guard changes; the full
fork/checkpoint and two-browser-viewer contracts were qualified separately above.

The harness deleted its machine, confirmed an empty inventory, and ordinary
`dev destroy` removed the owned service/environment. No process remained under
the smoke directory; the unrelated production host retained PID 1999841.
Immutable extracted artifacts and evidence remain for inspection. Local evidence
is `.work/linux-rc5-consumer-smoke/`, including `archive.sha256`,
`cleanup-processes.txt`, and `evidence/{result,lifecycle,initial-machines,final-machines}.json`.
