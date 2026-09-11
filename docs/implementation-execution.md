# Lifecycle and connections implementation — execution record

## Current product boundary

Clankerbox provides machines, SSH transport, generic TCP forwarding and local URL
mapping. Herdr is only an example external application. The `clankerbox herdr`
launcher and its application-specific live test were removed after the owner
corrected scope drift. No Herdr build, protocol version, Zig 0.15.2 exception or
Herdr test result is a Clankerbox dependency or release gate. The external fork
work below is retained as historical experiment evidence, not product scope.
No Herdr installation was added to the reusable image recipes.

## Authorization

The owner approved implementing steps 2–3 end-to-end on September 6, 2026:
helpers and disposable VMs on `clanker@203.0.113.10` and `user@mac-workstation`,
dedicated controller VM/service and narrowly required private networking in
`personal-cloud`. External Herdr experiments used isolated sessions but did not
make Herdr part of the product. No host reboots, unrelated service/data changes,
existing VM deletion, pushes or releases are authorized. Only newly created disposable resources are
cleanup targets. Earlier spike execution grants remain closed.

Networked fork preparation is deferred to the fork milestone at the owner's
request; it is not a gate for retained lifecycle and connection implementation.

## Initial inventory

- Hetzner: 125 GiB RAM, approximately 123 GiB available; 804 GiB disk available.
  Existing pinned recovery runtime/profile inputs remain. Passwordless sudo is
  available; coding guests will not run as root on the host.
- Mac: Tart 2.32.1, public cached Tahoe/Xcode image at the recorded digest,
  approximately 231 GiB disk available, GUI user context available. Existing
  `codex-macos-tahoe-xcodegen-base` is not a test target. General passwordless
  sudo is unavailable. Softnet 0.19.0 is installed but admin execution may need
  operator setup; do not weaken isolation silently.
- Compute-node: existing VM110 apps and VM111 fugu-proxy. Approximately 18 GiB RAM
  available; dedicated controller candidate VM112/IP .32 requires inventory
  confirmation in the infrastructure workstream.

## Implementation workstreams (historical)

Bounded coding workers own Go lifecycle/helpers, Go connection client, Herdr URL
delivery, and personal-cloud infrastructure separately. This thread owns image
staging, integration, diff review and live acceptance. Worker success is not
accepted as live product verification. No production agent credentials are used
in disposable lifecycle/connection fixtures.

## Implemented and verified

- Go/SQLite API and durable operation journal, explicit create/start/stop/delete,
  profile capabilities, per-machine SSH identity, restricted host control, and
  systemd/launchd retained runtime supervision. Fork/checkpoint/backup APIs are
  not part of this milestone.
- CLI SSH/SCP configuration and pinned trust; shared per-machine forwarding owner,
  TCP discovery, explicit VNC forwarding, stable local reservations, URL rewriting
  and generic local URL opening.
- Historical external experiment: the local Herdr fork delivers HTTP(S)
  Ctrl-click URLs to the clicking client, not
  the server host or other clients. Protocol 21 requires matching guest/client
  builds. Focused Rust tests and Windows compile/lint passed; see that fork's
  unreleased docs. No release was published.
- `go test -race ./internal/... ./cmd/...` and `go vet ./internal/... ./cmd/...`
  passed after integration fixes. The subsequent dependency upgrade isolates
  historical fixtures with `spikes/go.mod`; product `go test -race ./...` and
  `go vet ./...` now pass from the repository root too.
- Fresh Linux live acceptance passed create, SSH bootstrap, dirty Git staging
  and worktree changes, executable bits/symlink retention, stop/start, unchanged
  SSH host identity and stopped-machine SSH rejection. Harness:
  `tests/live_lifecycle.py`; initial private evidence `.work/linux-live-patched.json`.
- SCP through generated OpenSSH configuration returned the same SHA-256 as the
  source. Automatic HTTP forwarding passed a real loopback guest server,
  two simultaneous consumers, one consumer exiting, listener disappearance and
  reappearance on the same local address, and exact escaped URL path/query/fragment
  preservation. Harness: `tests/live_connections.py`; private evidence
  `.work/linux-connections.json`.
- Historical external experiment: matching custom Mac/Linux Herdr builds attached
  through Clankerbox to the unique
  guest session `cb-accept-39883e6c`. A command submitted through its guest API
  rendered `CLANKERBOX_HERDR_LIVE_OK` in the local client. The initial nested launch
  was correctly rejected until inherited `HERDR_ENV` was cleared. The binary was
  explicitly installed in the disposable guest; no published protocol-20 binary
  was substituted. Browser Ctrl-click delivery still needs live acceptance;
  successful URL mapping and routing unit tests alone do not prove that UI flow.

### Runtime integration corrections

The first Linux disposable remains failed evidence, not a passing run:
`3170fea0cfbb72c9d7bb74d5d75b940b` (`.work/linux-live.json`). SSH bootstrap needed
root ownership on the guest's SSH directories. Guest kernel poweroff left the
host VMM alive. Native stop now requires a shutdown acknowledgement in the pinned
smolvm fork instead of blindly terminating an unreachable VMM. Cold restart then
exposed stale OverlayFS lower-file handles when the kernel enabled indexing by
default. The guest agent now mounts the persistent root with
`index=off,redirect_dir=off,metacopy=off`. The fresh disposable passed with these
changes; the old overlay is not migrated or declared healthy.

Source changes live in `/Users/example/ws/pers/not-mine/smolvm`:
`src/agent/manager.rs`, `src/cli/vm_common.rs`, and
`crates/smolvm-agent/src/main.rs`. The remote build is isolated at
`/home/clanker/clankerbox/build/source`; earlier recovery inputs were not modified.
The installed CLI SHA-256 is
`e7dd531c872d09c5deb431eda743917571e144f3bee27a2bf58a320f7da50d70`;
the static musl guest agent SHA-256 is
`18a789b3d3404a489ab67b4c10ed7df86b705ec457e405356d335e9d3e16bccd`.
The copied original `runtime/build.json` describes the base input, **not these
replacement binaries**. Release packaging must publish a fresh complete manifest.

## Deployment and remaining gates

Dedicated personal-cloud VM112 (Ubuntu 24.04, `192.168.20.32`, 2 CPUs, 2 GiB RAM,
20 GiB disk) runs `clankerbox.service` behind private verified HTTPS at
`https://clankerbox.example.internal`. Profiles/machines API calls passed. Its
source-restricted controller SSH key can invoke the Mac structured helper and is
denied arbitrary `whoami` execution. Credentials remain outside this repository.

The initial Linux runs above used the temporary loopback controller. After the
owner updated the provider firewall, WireGuard handshakes and restricted SSH
control passed. Deployed HTTPS lifecycle and automatic forwarding now pass too
(`.work/linux-deployed-live.json`, `.work/linux-deployed-connections.json`).
Ping is intentionally denied by the narrow WireGuard host firewall; it is not
the connectivity acceptance criterion.

1. Operator installation of Softnet 0.23.0 is now verified by the installed
   binary's SHA-256 (`5982c8cde55cd039d4aa71add54356224b8b8a040df1a8786f16327b421f701d`)
   and successful restricted sudo execution. The original 0.19.0 pin rejected
   directional `in`/`out` rules; privileges were not broadened for the upgrade.
   The first failed Mac disposable (`a553929930ea66828418dd2cc2789bf3`) was
   explicitly restarted with Tart 2.36.0 after this correction. Its original
   create operation reconciled without rewriting the journal. SSH, dirty Git
   retention and SSH identity across stop/start then passed, and the API stopped
   and deleted the disposable. Evidence: `.work/mac-deployed-live.json` and
   `.work/mac-recovered-cleanup.log`. This recovery used the older seed image;
   latest-image acceptance is separate.
2. Latest-image Mac retained lifecycle, forwarding, authenticated VNC interaction
   and guest egress probes now pass (see the final Mac image section below).
   No home inbound port-forward is required.
3. Resolve the documented toolchain exceptions before declaring the requested
   all-latest upgrade complete.
   No reboot, host-loss, real-agent credential or fork-preparation claim follows
   from this retained lifecycle run.

### Deployed-path follow-up fixes

UDP queries from Hetzner to `1.1.1.1` time out even on the host; DNS-over-TCP to
that server and UDP to the host's configured Hetzner resolver `185.12.64.1` work.
The helper now accepts an optional numeric IPv4 `dns` upstream in its host config and
passes it to smolvm at creation. Hetzner uses `"dns":"185.12.64.1"`; the guest
still uses smolvm's gateway relay. This avoids opening more provider firewall
ports or allowing arbitrary guest access to private hosts. A fresh guest reached
GitHub over verified HTTPS with this setting (`.work/linux-deployed-dns.json`).

Concurrent real SSH helper invocations also exposed an initialization race:
nonblocking inventory initialization returned `host inventory busy`, producing
intermittent HTTP 503s. Initialization now waits for its short exclusive lock;
per-machine mutation locking is unchanged. The 16-concurrent-opener regression
and full product race tests pass. Failed attempts remain recorded rather than
rewritten as successful first runs.

After deploying the initialization fix, 12 concurrent real controller inspections
passed (the same probe previously returned `host inventory busy`). Smolvm's
strict floor does not exclude host public IPs, so the dedicated nftables guard
now rejects UID 1000 connections to non-loopback local IPv4/IPv6 addresses. It
preserves the host helper's loopback relay and other users' networking. Live guest
probes received refusal/reset and no SSH banner from the host's private/public
addresses, while verified GitHub HTTPS and automatic forwarding still passed.
The gateway can acknowledge guest TCP before establishing the host connection,
so connection establishment alone is not sufficient evidence of host access.
Rules were syntax-checked and installed in the existing dedicated guard service;
Docker tables were not changed.

### Latest-version upgrade, September 6

The owner explicitly requested current versions rather than minimum compatible
ones. The initial Softnet 0.19 pin and subsequent minimum 0.22 choice are
superseded by **0.23.0**. Version discovery uses upstream stable releases, not
prereleases. Core runtime upgrades are deployed on both platforms; the toolchain
exceptions below remain explicit.

| Component | Selected version | Current result |
| --- | --- | --- |
| Go | 1.27.1 | CLI, controller and both host helpers rebuilt; deployed helpers/controller updated after state backups |
| Go SSH / SQLite dependencies | x/crypto 0.56.0 / modernc.org/sqlite 1.58.0 | Latest module update and tidy; product race tests and vet pass |
| smolvm | 1.14.1 + retained-stop/OverlayFS patches | Native Linux build, matching static agent and release libraries deployed; live retained lifecycle passes |
| Linux guest | Ubuntu Base 26.04.1, current signed distro updates | New `linux-dev-v2`; no pending package upgrades at build time |
| Node / npm | 26.8.1 / bundled 11.19.0 | Verified official Node archive; versions confirmed inside the running guest |
| Rust | 1.98.1 | smolvm built/tested |
| Tart | 2.36.0 | Dedicated signature-verified binary deployed; retained lifecycle passes |
| Softnet | 0.23.0 | Installed binary verified; directional isolation rules and restricted sudo work |
| Mac image | macOS 26.6.2 / Xcode 26.6 (17F113) | `mac-xcode-v3`; verified Swift compile/run and retained lifecycle |
| Zig | 0.16.0 | Used in the smolvm runtime build, not a Clankerbox service or guest runtime dependency |

Dependency scope is explicit: smolvm's libkrun/libkrunfw and Rust crate locks are
the matching upstream runtime bundle, not independently mixed latest libraries.
Ubuntu system tools are current distro packages, not independently rebuilt
upstream releases. In particular, the guest has Python **3.14.4** while upstream
offers **3.14.7**. This is a remaining exception to a literal all-upstream-latest
requirement, not a claim that every installed package is upstream-latest.
The existing controller/host operating systems were not upgraded or rebooted.

Latest Linux acceptance uses the deployed private TLS/WireGuard path. Create,
dirty Git and SSH identity retention across stop/start, checksum-matched SCP, automatic HTTP forwarding,
independent consumers, stable listener churn, escaped URLs and verified public
HTTPS pass. Guest SSH probes to host public/private and controller addresses
return refusal/reset without an SSH banner. Evidence:
`.work/linux-latest-live-v2.json`, `.work/linux-latest-connections.json`, and
`.work/linux-latest-network.txt`. The disposable was stopped and deleted after
acceptance; older failed fixtures remain untouched. An earlier invocation supplied key text where
the CLI requires a filename; it failed before creating a machine and remains
separately recorded in `.work/linux-latest-live.json`.

The new smolvm source is isolated in `.work/smolvm-v1.14.1`; the original checkout
and unrelated dirty libkrun submodule remain intact. Native CLI SHA-256:
`66c240d5318ecb46d1e81b0f098932baec432ce02d76dc4137f4be133076ceed`;
static guest agent SHA-256:
`c232121105422b88640b09802a9fca0601caf136d38f04f9b3f0e5d6c3bec0ca`.
Remote `/home/clanker/clankerbox/versions/1.14.1` retains source pins, patch,
build scripts, `SHA256SUMS`, library symlink manifest and focused test evidence.
`images/finalize-linux.sh` joins that verified agent to the new bare Ubuntu image;
no old Alpine libraries or spike agents are mixed in. Review corrected root's
home from `/root/workspace` to `/root`, matching SSH bootstrap; workspace remains
`/root/workspace`. Separate final manifests preserve the original package-build
evidence. Deployment pins are retained in personal-cloud's
`hosts/clankerbox-runtime/linux-host.json` and
`hosts/clankerbox-controller/config.json`.

Historical external experiment (not Clankerbox acceptance): Herdr's new Rust lint
fixes preserve evaluation order and pixel conversion behavior. Its generated API
schema now records protocol 21. The full check hit
an agent-status subscription timeout; the same test also fails with the prior
Rust 1.96.1 toolchain, so the Rust upgrade alone does not explain it. The initial
workspace-CWD test failure passes with the inherited Herdr environment cleared.
No test was disabled, and these narrower passing checks do not certify the full
integration suite. Its Zig 0.15.2 requirement and agent-status timeout are not
Clankerbox release blockers; no dependency-porting work is required for this product.

### Final Mac image and acceptance

The registry's `macos-tahoe-xcode:latest` digest
`e0721ddeae3c7c037b764c1aebd0b2d245495c16622413f5a567d7110d18d863`
contains macOS 26.6.2 but **Xcode 26.2**, despite its tag. Rather than presenting
that as the latest toolchain, `images/finalize-mac.sh` clones it and copies the
existing Apple-signed host Xcode 26.6 into a dedicated guest toolchain directory.
The physical host installation is unchanged. Guest signature validation,
license/first-launch preparation and Swift compile/run pass. The final seed is
`seed-macos26.6.2-xcode26.6`; its ready marker is written only after clean shutdown.
The old image's extra tools remain present but are not the selected Xcode.

The official Node 26.8.1 ARM64 archive is checksum-verified; npm is 11.19.0.
Homebrew Python is 3.14.7. The Mac SSH bootstrap explicitly sets the developer
tool PATH so noninteractive SSH does not silently select Apple's older Python.
Image provisioning sets public DNS because Softnet deliberately blocks the
private DHCP resolver. This is the same guest DNS policy as machine bootstrap.

After backing up host SQLite and controller state/configuration, the Mac helper
and `mac-xcode-v3` were deployed. Personal-cloud retains both host and controller
profile pins. A first controller-backup command failed on a privileged directory
glob before changing its config; the service was restarted immediately, then
the backup/switch was completed in a privileged shell with a restart exit trap.

Final disposable `269a660e4adadb7221daf3cf50317879` passes retained dirty Git,
executable/symlink state, SSH host identity, stopped-machine access rejection,
automatic HTTP forwarding, exact URL preservation, independent consumers and
listener disappearance/reappearance. Evidence: `.work/mac-final-live.json`,
`.work/mac-final-connections.json`, `.work/mac-final-versions.txt`.
The connection fixture now waits for its background HTTP server to answer before
ending the startup SSH session and prints startup errors on failure; the earlier
fire-and-forget fixture intermittently lost its server during Mac startup.

Native Screen Sharing authenticated through the CLI's loopback VNC tunnel.
A VNC mouse interaction dismissed Python's local-network permission prompt;
VNC keyboard input then executed `echo CLANKERBOX_VNC_INPUT_OK` and the returned
output was visually inspected in `.work/mac-vnc-final.jpg`. This uses the
disposable image's guest login, not SSH password authentication, which remains
disabled. Desktop credentials/permissions still follow the selected image;
Clankerbox does not currently provision a separate VNC credential API.

The now-removed application-specific fixture `tests/live_herdr.py` attached the
matching protocol-21 Herdr client/server over the deployed SSH path and injected
an SGR Ctrl-click into a real client PTY. The local Clankerbox opener mapped the
guest URL and launched native Safari; its title, exact URL and page text
confirmed `CLANKERBOX_BROWSER_OK`.
Evidence: `.work/mac-final-herdr.json`. This is terminal-event injection, not a
physical mouse click or evidence about terminal-emulator-owned hyperlink clicks.
The fixture explicitly confirmed installation of the approved guest binary;
earlier fixture attempts mistook that prompt for a ready terminal and failed.
This is historical external-application evidence only. The full Herdr integration
suite is outside Clankerbox acceptance.

Checksum-matched SCP roundtrip evidence is `.work/mac-final-scp.txt`; guest probes
to the host gateway, physical Mac and controller SSH addresses time out without
an SSH banner (`.work/mac-final-network.txt`). Public certificate-verified HTTPS
returns 200. These probes supplement, not replace, the configured isolation rules.

The final disposable and its named Herdr session were stopped/deleted after
acceptance (`.work/mac-final-cleanup.json`); the viewer/test browser tabs and
local test forwarding process were closed. The three owned reusable Mac seeds
are stopped. No unrelated VM or host service was removed. Product race tests,
vet, both host-entry tests and the Mac image recipe's ShellCheck pass.

## Using the client

Create a private config with `url`, `token_file`, `identity_file` (or omit it to
use the local SSH agent), and a short private `state_dir`. Token/key files must
be mode 0600; state directories 0700. The deployed operator token is managed by
personal-cloud, never copied into a guest. Global flags precede commands:

```sh
clankerbox --config CONFIG profiles
clankerbox --config CONFIG create dev --profile linux-dev-v2 --host linux --key PUBLIC_KEY_FILE
clankerbox --config CONFIG exec dev -- git --version
clankerbox --config CONFIG ssh dev
clankerbox --config CONFIG connect dev
clankerbox --config CONFIG ports dev
clankerbox --config CONFIG url dev 'http://localhost:3000/path'
clankerbox --config CONFIG vnc --viewer MAC_MACHINE
```

Mutations now wait for completion by default (five minutes; positive `--timeout`
overrides it). Use global `--json` for automation and mutation `--async` to return
the accepted operation for explicit polling. See the latest
[machine CLI acceptance](#machine-cli-acceptance); earlier evidence remains historical.
See the [client guide](../README.md#using-machines) for output/default contracts.
Connecting never implicitly starts a stopped machine. `connect` stays running
while its forwards are needed; interactive `ssh` and VNC hold their own consumers. `ssh-config install`
adds explicit `cb.NAME` and `cb.ID` entries for ordinary SSH/SCP. Run independently
installed applications against those SSH aliases or the published local port
mappings. Application installation and session lifecycle belong to the caller.

## Cleanup and harness follow-up

The custom guest Herdr session was stopped and deleted, and its sole test outer
pane was closed. The Linux machine used for forwarding/Herdr acceptance was
stopped and deleted successfully through the API. Re-entering the lifecycle
harness for cleanup exposed a fixture bug (creating an already-existing symlink),
not a runtime regression. Its evidence retains the original successful retention
event, that harness failure, and successful stop/delete. The fixture now replaces
only its own test symlink on resume. A fresh full create/retention/stop/start/delete
run passed and cleaned its machine; it is recorded separately at
`.work/linux-live-final.json`.

The first pre-fix Linux machine still has an unresolved start operation and is
retained for explicit operator reconciliation; normal deletion correctly refuses
to bypass it. Its runtime is observed running but guest SSH is unhealthy. It has
only synthetic test data, not agent credentials. The temporary local controller
and its journal remain available for investigating that failed fixture. No
unrelated VM, session or user data was removed.

## September 7: pragmatic milestone 4 and reconnect acceptance

The owner approved finishing useful lifecycle/connection gaps and milestone 4
without strict first-instruction network quarantine, generalized credential
rotation, backup hooks or automatic recovery of ambiguous capture/restore stages.
Such operations stay visible and require inspection; they are not blindly replayed.
Herdr remains an external application, not a product dependency.

The API and CLI now provide `fork`, `checkpoint create/list/inspect/delete` and
`restore`. Forks and restores allocate separate machine identities, retained disks
and SSH host keys. Connections are published only after guest preparation and a
verified SSH handshake. Inherited applications may contact external services before
that boundary, and replacing SSH keys does not sanitize captured RAM secrets.
Checkpoints stay on the same host and pinned runtime/profile; there is no promise
of migration to a different CPU/runtime or a silent cold-boot substitute.

Linux live descendants share their native runtime store while owning separate
machine records and disks. Ancestor deletion is conservatively refused while a
descendant depends on that store; no cascading deletion or reference-graph garbage
collector was added. Mac branches and checkpoints require a stopped source and
use Tart's retained disk clones, not RAM continuation.

```sh
clankerbox --config CONFIG fork SOURCE experiment --key PUBLIC_KEY_FILE
clankerbox --config CONFIG checkpoint create SOURCE
clankerbox --config CONFIG checkpoint list
clankerbox --config CONFIG checkpoint inspect CHECKPOINT_ID
clankerbox --config CONFIG restore CHECKPOINT_ID recovered --key PUBLIC_KEY_FILE
clankerbox --config CONFIG checkpoint delete CHECKPOINT_ID
```

Mutations wait before returning resource summaries. For manual polling, use
`--json checkpoint create SOURCE --async` (the async flag follows the nested
action). Checkpoint
commands address immutable checkpoint IDs; restore creates a new machine rather
than overwriting an existing workspace. A pre-upgrade Linux source needs an
explicit stop/start to enable branchable supervision; capture does not secretly
restart its workload.

### Executed checks and review

- Controller-restart reconnection passes on Linux and Mac. The CLI keeps its local
  endpoint reservation, service access becomes unavailable during the outage, and
  forwarding recovers without changing guest process identity or SSH host keys.
  Evidence: `.work/linux-controller-reconnect.json` and
  `.work/mac-controller-reconnect.json`.
- Mac fork, independent disk writes, stable child identity across cold restart,
  checkpoint capture, source deletion, two distinct restores, checkpoint deletion
  and independent retained restarts all pass. Its disposable machines and
  checkpoint were deleted through the API. Evidence:
  `.work/mac-live-checkpoints-m4.json`.
- Linux live branching preserved the synthetic RAM process token/PID and produced
  independent disks and SSH identity. Parent cold restart exposed a native smolvm
  status bug: a retained child from an earlier live generation caused a healthy
  new execution to be reported as frozen. The fork's `src/agent/state_probe.rs`
  now reuses the existing restart-blocking lineage rule, retaining the legacy
  frozen guard. Native restart-guard and state-probe tests pass; read-only review
  found no actionable issue. The patched binary was installed atomically and the
  existing start operation reconciled successfully without another boot. Source
  and child retained their separate disk contents. Evidence:
  `.work/smolvm-state-build.log`, `.work/runtime-state-review.md`,
  `.work/smolvm-state-install.txt` and `.work/linux-lineage-fix-verification.json`.
  The complete fork-only harness then passed, including parent restart with a
  retained descendant and ancestor-deletion refusal; its disposable source and
  child were deleted through the API. Evidence: `.work/linux-live-fork-m4-fixed.json`.
- Product race tests and vet pass, as do the separate historical spike suites.
  Deslop/ponytail review findings were validated and fixed: a rejected capture now
  settles its generation instead of stranding the source; a redundant SQL query
  and membership helper were removed. Follow-up review found no actionable issue.
  A separate reconnect-fixture finding was also fixed: outage verification checks
  TCP reachability, rather than mistaking TCP TIME_WAIT for a retained listener.

### Resolved infrastructure prerequisites and remaining limits

Linux portable-checkpoint acceptance initially failed its prerequisite: native
capture rejects custom DNS, and the default resolver at `1.1.1.1:53/UDP` was
unreachable from this host. The owner updated the provider firewall; UDP DNS now
returns NOERROR. The custom `dns` field was removed from the canonical Linux helper
config in personal-cloud and deployed atomically with the previous file retained.
Only new machines use the default; existing native DNS settings were not rewritten.
A fresh disposable passed retained lifecycle and certificate-verified guest HTTPS
to GitHub (200): `.work/linux-portable-lifecycle.json` and
`.work/linux-portable-dns-https.txt`. No networking rewrite or runtime workaround
was needed. The config review found no actionable issue.

The full Linux fork/checkpoint/restore harness then passed over private HTTPS:
live RAM process continuity, independent child disk/SSH identity, parent restart
with a retained descendant, ancestor-deletion refusal, portable capture, source
deletion, and two independent restores preserving the captured process token/PID
and disk state. After independent writes, both restores survived checkpoint
deletion and retained cold restart. All of this run's machines and its checkpoint
were deleted through the API. Evidence: `.work/linux-live-checkpoints-m4.json`.

This remains synthetic acceptance; a current real-agent portable-profile run,
host reboot/power-loss, pressure, long retention and operational backup integration
are not certified by it.

During acceptance, private HTTPS ingress began returning “edge ingress has no
route for this host.” The controller itself remains reachable by authorized SSH;
an authenticated local relay allowed independent runtime acceptance to continue.
After owner approval, the live Caddyfile was compared with the canonical config:
the only difference was the missing Clankerbox admin-only route and deny handler.
The existing validating deployment script installed that config and gracefully
reloaded Caddy, retaining its prior-file rollback. Authenticated profile listing
now succeeds over private HTTPS; missing API credentials return 401 and a
non-admin ingress source returns 403. Both Caddy config variants validate.
Evidence: `.work/Caddyfile.live-before`, `.work/ingress-restored-profiles.json`
and `.work/ingress-restored-check.txt`. No unrelated routes or host firewall
rules were changed.

The pre-fix DNS recheck observed an outgoing UDP query on the host's physical interface
and no reply; TCP DNS to Cloudflare and UDP DNS to Hetzner both worked. Host nftables
does not block this destination. That is consistent with the provider's stateless
firewall, but its live rules could not be inspected without Robot access.
The owner's existing reply rule required TCP ACK and did not cover UDP. The
additional incoming IPv4 rule accepts UDP from `1.1.1.1/32`, source port 53,
to `203.0.113.10/32`; the requested range was `32768-60999` (the observed host
ephemeral range), with the owner's existing `32768-65535` range also acceptable.
If egress is filtered, outgoing UDP to `1.1.1.1:53` must also be permitted.
Evidence: `.work/dns-provider-recheck.txt`; see
[Hetzner's stateless firewall documentation](https://docs.hetzner.com/robot/dedicated-server/firewall).

## Machine CLI acceptance

On 2026-09-07, the redesigned local CLI was exercised against the existing private
HTTPS controller and unchanged Linux/Mac helpers. No controller redeployment or
new guest application dependency was needed.

- Linux and Mac: positional create with profile-aware host selection and public
  key fallback, default wait returning running machines, literal exec arguments,
  interactive SSH holding automatic HTTP forwarding until exit, ordinary
  external SSH aliases, and explicit stop/start/delete.
- Linux: live fork and RAM checkpoint/restore retained a test file; checkpoint
  deletion and child cleanup completed. Standalone `connect` served HTTP and
  external SCP transferred a file verified byte-for-byte. JSON/async stop was
  inspected to completion. A deliberately tiny start timeout returned accepted
  IDs; the operation subsequently finished without resubmission. Exec preserved
  exit status 37, including after that start.
- Mac: stopped-source disk fork retained a file in the guest home directory.
  The first probe used `/tmp`, which was absent after the cold fork boot; the
  persistent-home probe passed. This does not promise temporary-file retention.
- A running-machine deletion was rejected as expected; cleanup used explicit
  stop followed by delete. The guide now makes that prerequisite explicit.

The requested code review identified one valid local-viewer
diagnostic regression. Silent exit propagation is now limited to SSH, with an
executable regression test for viewer failure. Full race-enabled tests and lint
passed, including literal exec streams, status 37/255, owner lifetime, config
defaults, output modes, wait failures and cancellation without duplicate mutation.

These are disposable toy checks, not a new certification of VNC rendering,
Mac checkpoint restore, controller outages, long retention or backup behavior.
Earlier runtime acceptance remains separate. All machines and checkpoints from
this CLI round were deleted after verification.

## 2026-09-09: Terminal sessions

Implemented the guest session daemon (`cmd/clankerbox-guest`,
`internal/guest/*`), the controller guest link, session stream and list
endpoints, machine labels, the change-notification stream, host-side guest
preparation (`--guest-prepare`), and the `sessions`, `labels`, and `events`
CLI commands, following `docs/terminal-sessions.md`.

### Executed checks and review

- `go test ./...` and `go test -race` on the guest packages pass on macOS,
  including real PTY sessions, exactly-once attach and resume, input dedup,
  ring eviction, resize forcing snapshots, slow-subscriber drops, exit status
  and signal reporting, lost-record conversion on daemon restart, singleton
  lock behavior, the proxy bridge, and the controller link against a fake guest
  sshd bridging to a real daemon.
- `make lint` passes with the repository configuration.
- `make build` cross-builds `bin/clankerbox-guest-linux-amd64` and
  `bin/clankerbox-guest-darwin-arm64`.
- Two independent design reviews were incorporated before implementation.

### Review rounds and fixes (2026-09-09)

Three independent reviews of the uncommitted change set were validated and
implemented together: the proxy now ends when the daemon side does and closes
its socket on cancellation; `lookup` copies session records under the session
lock (the race the fingerprint change introduced); stopped attachments always
unregister; the keepalive is a daemon hello probe that refreshes the cached
hello; `session.list` uses an uncounted control stream; child labels are merged
over inherited ones; the change digest excludes observation freshness; the VT
continuation limit is 8 MiB so snapshots fit the 32 MiB cap; unused VT
callbacks, dead channels and alternatives were removed.

### Live qualification (2026-09-09)

Deployed to the private controller and both runtime hosts (record in the
personal-cloud controller runbook). On the running Linux machine the controller
installed the guest daemon through `smolvm machine exec -i`, authorized the
terminal key with the forced `clankerbox-guest proxy` command, and reported the
link `ready` with the pinned `wasm_sha256`. From the desk, a browser terminal on
that machine survived a page reload, a desk restart (snapshot reattach), and a
controller restart (resume from the committed offset), always in the same shell
process; a hidden viewer did not shrink the shared grid; ending the terminal kept
its final screen. `sessions`, `labels`, and `events` worked against the live API.
A machine created from the canvas picker became running with its guest link
ready within seconds, was stopped and deleted from its card, and its card showed
the deletion. Not exercised live: macOS guests, link suspension across a fork or
checkpoint, and a daemon-only restart inside a guest.

### Review round two (2026-09-09)

A second review of the uncommitted work produced eleven findings; eight were
implemented, three in part. Guest client calls are now bounded by their context
(cancellation closes the connection, which also releases a write the peer is not
consuming); the event queue is an explicit frame bound and `Close` releases a
reader parked on it; fork/restore validate the merged label map before it is
saved; the spec clarifies lost-create recovery, and stale comments were removed.
On the desk side, ending a terminal
always goes through the guest, and attach/create replies refresh informational
session fields. A follow-up serialized `wazero.NewRuntime` in `vt.NewLoader`:
wazero 1.12 caches its version string in an unsynchronized global, and tests
that start several daemons in one process tripped the race detector
intermittently.

### Wire revision 2 (2026-09-09)

A protocol design review led to one coordinated clean break across Clankerbox
and Clankerdesk. The guest protocol now has one supported wire revision,
compared exactly at hello; the major/minor pair, the capability list, and the
JSON capability ledger are gone. `session.open` replaces `session.attach` and
answers with the whole bootstrap in one reply: `resume`, `snapshot` (with the
byte count the SNAPSHOT_DATA frames carry), `unavailable`, or `ended` with the
final view while this daemon still holds the terminal. The separate snapshot
event, the input identity and its duplicate cache, the manager-wide inventory
feed (`events.subscribe`), and the callerless `session.inspect`, `session.read`,
`session.signal`, and `session.remove` operations were deleted; attachments still
receive ordered session, resize, and gap events. Interrupting a command is input:
the consumer writes the Ctrl-C byte and the line discipline or the raw-mode
program handles it as a keyboard would. `protocol/messages.json` is written by
the Go tests and vendored by Clankerdesk, whose typed operation table decodes
every entry. On the desk side a per-terminal attachment module owns the mirror,
cursor, and link; the terminal service keeps the catalog, viewers, and reconnect
policy. Machine submissions retry the identical request under one idempotency
key while the transport fails, inspections coalesce per machine, and cards show
the controller's observation health.
A review of that change found that replies were HTML-escaped, so an ended
view over a maximal grid could exceed the frame limit and close the
connection; bodies are now encoded compactly and a view that still cannot be
framed is omitted from the ended reply. The desk's attachment module gained
the same-chunk closure, bad-frame-after-hello, deliberate-close, and
create-retry cases it had promised, and the machine service retries only
identified transport failures and shares slow inspections while they run.
A second review pointed out that omitting an oversized final view traded a
framing failure for data loss; the ended reply now announces the view's byte
count and its text follows as SNAPSHOT_DATA frames, the same path a snapshot
takes, which also retired the size check. The desk's attachment module owns
its socket from the start of an opening, so a close during the handshake
reaches it and a disposed terminal never sends a request; the controller
client raises its unreachable error only for the exchange itself.
A third review noted that a final view whose frames failed to write left the
connection open with its announced bytes outstanding; a failed view transfer
now closes the sink like a failed stream, and a session test covers both the
delivered and the failed transfer.

### Architecture review round (2026-09-10)

An architecture review of the wire revision 2 work confirmed eight findings and
a cleanup, resolved as a few contracts. On the guest, an ended session is now
its record plus its final screen: the text and cursor are captured once at exit
and the terminal and the output ring are released, since nothing resumes an
ended session; manifests are written through `statefs` (fsync of file and
directory) and every discarded persistence error is logged, with the in-memory
record staying authoritative until a restart; and `session.create` carries
`created_at`, so a create the daemon does not remember that is older than the
24 h horizon is refused as `expired` and never started, while ended sessions
are remembered for longer, closing the window in which a desk that had been
away could start a second process. The controller names the guest link status
in its refusal code (`guest_incompatible`, `guest_unavailable`, and so on).
On the desk, a terminal is finalized only from the ordered exit event on its
stream or from the guest's ended view, never from the `session.end` reply, so
the recorded screen holds the last output whatever order the daemon's writers
took; the exited status and the screen are one catalog write; a pending create
has three exits (confirmed, refused, or abandoned by `terminal.end` when its
machine cannot be reached), an unknown machine finalizes the row instead of
retrying forever and binding checks the machine exists; every wait a workspace
worker can observe fits the supervisor's 20 s bound (guest replies 15 s and the
link closes, controller calls 5 s, create answers after 10 s at most); viewers
get a bootstrap allowance so a snapshot larger than the live backlog limit is
never counted as backlog; and the workspace binding moved to the terminal
capability, which removed the machine service's dependency on the terminal
engine.
A review of that round found six gaps in the failure paths, all closed. The
guest quarantines a record it cannot read as a `lost` session instead of
forgetting its id, and refuses a create dated more than an hour ahead of its
clock, so the no-replay guarantee no longer depends on intact manifests or
synchronized clocks. The desk drops a handshake in flight when a pending
create is abandoned, so the late hello never sends the create; bounds a
bootstrap whose announced bytes stop arriving with the same 15 s deadline as
a reply; gives the stream upgrade a wall-clock deadline and settles a refusal
that ends early; keeps a finalized session whose catalog write fails, with its
mirror answering reads, and retries the write every 5 s while lookups prefer
the live owner over its row; and accumulates a viewer's bootstrap allowance
across back-to-back snapshots. The fake controller now refuses streams to a
stopped machine with the real controller's 409, and the desk reports such
refusals as `machine <state>`.
A second review, on simplicity and correctness, found that the quarantined
record's empty grid reached the desk's catalog and broke its schema, that a
failed catalog write skipped closing an abandoned handshake, and that a new
record directory was not durable through its parents. The desk now takes
nothing but the outcome from a lost record and ignores late frames for a
finalized session; the handshake is dropped before the catalog write; and the
guest syncs the parent directories when a record directory is new.
Deployed on 2026-09-10 (server `7a8bc92d…`, Linux guest `2590858e…`, Mac
guest `d4235acd…`, CLI `90362b23…`) and verified live from a local desk with
a disposable Linux machine: exit codes and markers recorded through the
stream, a flood ended mid-output with its last line recorded, an exit during a
controller restart recorded from the captured view, a pending terminal on a
stopped machine reported `machine stopped` and abandoned on request, and an
unknown machine finalized at once. Details in the controller README of
personal-cloud.
A completion review then measured four remaining failure paths. The guest's
post-spawn record write is now logged rather than fatal, like every later
write, so a child that already runs never has its id deleted; the desk's
`end` answers with the finalized session when the ordered exit retired the
link before the reply arrived; a viewer may have one bootstrap in flight, and
one still receiving a snapshot when the next is needed is shed rather than
credited twice; a create the catalog cannot record leaves nothing behind;
controller refusal codes and a guest's `lost` record become the terminal's
reason; and the supervisor's bound is 30 s, above the longest composed
operation. The watchdog itself, which cannot tell a hung worker from host work
that is legitimately slow, is left for a later design pass.
