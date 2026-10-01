# TypeScript/Effect rewrite — plan

Status: planned. All design decisions are closed (2026-10-01); the phase-0 spikes
gate the shape of guest access before packages are built. The findings behind
this revision are in [design-audit.md](design-audit.md), which is deleted with
this plan.

clankerbox is rewritten from scratch in TypeScript on Effect 4 as a clean break.
No persisted state is migrated: production is destroyed and redeployed at
cut-over. The Go code is replaced in this branch and deleted before merge. There
is never a release where both implementations ship.

**What clankerbox is after the rewrite:** it runs machines, and says where each
one is reachable. Lifecycle (create, start, stop, delete, RAM fork, checkpoints),
profiles, a small preparation contract run over the runtime's own exec, and a
`host:port` plus SSH host key for each port a profile exposes. Everything a user
or app does *inside* a guest (shells, terminal sessions, file copy) goes through
software the profile installs, normally sshd. Clankerdesk's terminal sessions
move into a session daemon that Clankerdesk owns and ships in its own profile
([Handed to Clankerdesk](#handed-to-clankerdesk)).

## Settled decisions

| Area | Decision |
| --- | --- |
| Scope | CLI, controller and host, plus all Python tooling (live harnesses, release bundling, image staging, `work_runs`). There is no clankerbox guest daemon. |
| Runtime | Node 26.10.0 (latest patch at each release), shipped as Node SEA single-executable binaries. |
| Effect | `effect` / `@effect/platform-node` `4.0.0-rc.118`, the latest rc. HTTP and CLI are top-level modules in this rc (`effect/http`, `effect/cli`). |
| RC alignment | clankerbox, Clankerdesk and clankerauth-sdk all target `4.0.0-rc.118`. The contract package is Effect-native, so two RC copies would break Schema identity at runtime. Move all three to a new RC together. |
| Contract | [effect-actions](https://github.com/gjermundgaraba/effect-actions) 0.8.0 for every call; all calls are unary HTTP. HTTP input is closed: undeclared fields are refused. |
| Auth | clankerauth 0.11.1 offline API keys and JWTs on both the controller API and the host API, through `@gjermundgaraba/clankerauth-sdk` 0.11.1 and `Resource.make`. Keys are checked against a signed key list per resource. An unknown key triggers a key-list read (at most one per 5 s), so new keys work within seconds; revocation takes about a minute; the last list stays valid for 24 hours during an issuer outage. Tests use the SDK's `/testing` fake issuer, and dev mode uses `clankerauth-dev`. |
| Network | Controller, hosts and clients share the operator's Tailscale tailnet (personal-cloud work, outside this plan). There is no TLS on any clankerbox hop: the tailnet encrypts and authenticates, and clankerauth authorizes each request. |
| Deleted auth | Static bearer token file, ingress client-CA/peer-ID mode, controller→host client certificates (`tls_cert`/`tls_key`/`peer_id`, `controller_id`), host server certificates and `tls_ca`, the `pki` directories, Unix peer-credential checks, and every guest-side credential (host CA, per-epoch certificates, bindings). |
| State | SQLite through `node:sqlite` on each host only. The controller has no database. No migrations; old `controller.db`/`host.db` and guest images are discarded. |
| Production | `personal-cloud` runs 0.11.0 with a Linux smolvm host (Hetzner) and a Mac Tart host. At cut-over, every 0.11.0 machine and checkpoint is destroyed, the TS release is deployed, and machines are recreated from profiles. The Linux host runs smolvm as root (D11). |
| SDK | `packages/contract` (Schemas and the ActionHttpClient) is published as the next major of `@gjermundgaraba/clankerbox-sdk`. It is versioned with the clankerbox binaries, so there is no separate `sdk-v*` tag and no pairing table. |
| MCP | None. |
| Tooling | vite-plus 1.0.0 (`vp`), pnpm 12, TypeScript 7, laid out like `/private/tmp/monorepo-example`. The lint setup (typeAware, typeCheck, anti-slop plugin) mirrors clankerauth. |
| Dependency floors | smolvm 1.22.0, Tart ≥ 2.40.1, tart-guest-agent ≥ 0.15.0, Softnet 0.24.0 (macOS 26 hosts), Node 26.10.0, clankerauth-sdk 0.11.1. See [The design rule](#the-design-rule), question 5. |

## The design rule

Every mechanism that wraps a dependency answers five questions before it is
built, and again at every dependency bump:

1. **Duplicated bookkeeping.** Does the dependency (or another part of
   clankerbox) already track this? Example: smolvm tracks fork lineage and
   refuses deleting a fork base; the Go code checked it again in the controller
   and the host.
2. **Owning what the dependency owns.** Are we deleting its files or managing its
   processes, and so needing proofs it doesn't? Example: `abandonFailedBranch`.
3. **Unrecorded choices.** Every layout choice, limit and timeout carries a
   recorded reason. Example: one smolvm inventory per machine on Linux had none.
4. **Our comments are not evidence.** "Keep, because X" in old code is checked
   against the dependency's source or docs at the pinned version.
5. **Re-audit on every bump.** The rewrite uses the latest release of each
   dependency. A bump re-checks that dependency's claims, not just the tests,
   because what a dependency guarantees is exactly what changes between releases.
   The bump skills carry the list of claims per dependency.

## Delivery

- **Branch:** everything is built on `rewrite-to-effect`, with one or more commits
  per phase, pushed as work lands. There is one PR, at cut-over. Commits carry no
  AI attribution trailers.
- **Review points:** after the phase-0 spikes (they gate guest access, D2), then
  at the end of each phase with a summary.
- **Live test machines:**
  - this Apple Silicon Mac: smolvm on macOS, and Tart
  - `ssh clanker@37.27.63.112`: Linux/amd64 with KVM, smolvm on Linux, and the
    linux-amd64 binary. This is the production personal-cloud Linux host. You've
    approved using it while its controller is down.
    - Work stays under `~/clankerbox-rewrite/`.
    - Never touch the production `~/clankerbox`, its `clankerbox-host.service` or
      its VMs.
    - Never restart `user@1000`.
    - Root-mode spikes (D11) need your approval first: they run smolvm as root
      and create system units, outside the owned root.
- **Reusable VM seeds:** new seeds for smolvm 1.22.0 and Tart 2.40.1 go into the
  main checkout's `.work/inputs` with provenance and a ready marker, and are
  always used through private clones. The existing `smolvm-1.19.0-images`,
  `tart-2.38.0` and `tart-local` seeds serve only until then.
- **This plan:** deleted in the final commit before the cut-over merge.

### Test machine footprint and final cleanup

Everything the rewrite creates on a test machine is removed when the work ends.
This applies to both the Linux machine and this Mac. The rules:

- **One owned root per machine.**
  - Linux: `~/clankerbox-rewrite/`. The pre-existing `~/clankerbox` is not ours;
    never touch it.
  - Mac: this worktree's `.work/`.

  Runs, scratch, Node toolchains, SEA builds, bundles, VM clones and dev
  environments all live under that root. Nothing goes into shared locations such
  as a global npm prefix or `/usr/local`.
- **Every native resource is named and recorded.** Resources carry a
  `clankerbox-rewrite` prefix: systemd units, launchd jobs, smolvm machines,
  Tart VMs and listening ports. Each one is recorded in its run's evidence, per
  AGENTS.md, and a run's teardown stops its resources before scratch is deleted.
- **Machine changes are kept in a ledger.** Every change outside the owned root
  goes into `CLEANUP.md` under that root. So far there is one: `clanker` was added
  to the `kvm` group on 2026-09-30. At the end, you decide whether each change is
  reverted.
- **Final cleanup, the last step of the whole effort:**
  1. Stop every recorded process, unit, job and VM.
  2. Confirm none remain, by name prefix and by the recorded IDs.
  3. Delete both owned roots and any seed clones.
  4. Walk the ledger with you.
  5. Report what was removed, and anything deliberately kept, with size and reason.

  Reusable seeds in the main checkout's `.work/inputs` are not ours to delete.

## Architecture

- **Controller: stateless.** It authenticates the caller, routes by the host
  prefix in every ID, and fans out for lists and name lookups. It has no
  database, queue, capacity table or profile catalog. If a host is down, calls
  for that host fail `Unavailable` and the caller retries with the same
  idempotency key.
- **Host: owns everything durable** for its machines: machines, operations,
  idempotency keys, capacity, profiles and builds, checkpoints, and port
  allocations. Machine state (running, stopped, missing) is always read from the
  runtime, never stored.
- **Runtimes:** smolvm (Linux guests, RAM forks, checkpoints) through its CLI, and
  Tart (macOS guests, disk copies). Each is one module behind a shared `Runtime`
  interface; shared paths (journal, preparation, port allocation, supervision)
  are written once.
- **Guest contract: preparation over the runtime's exec.** No clankerbox binary
  runs in a guest. See D2.
- **Guest access: the profile's.** A profile declares the guest ports it exposes;
  the host publishes each on its tailnet address and reports `host:port` and the
  SSH host key. See D2.

## Target layout

```
package.json            # vp scripts: ready = check + test + build
pnpm-workspace.yaml     # apps/*, packages/*, tools/*; catalog pins below
vite.config.ts          # lint/fmt/staged/run.cache, as in clankerauth
tsconfig.json
apps/
  clankerbox/           # the only binary: `clankerbox <cli…> | server | host`
packages/
  contract/             # Schemas, ActionGroups (machine, checkpoint, profile, host, operation), errors
  controller/           # auth, routing by host prefix, fan-out
  host/                 # journal, lifecycle, runtimes (smolvm, tart), supervisor, builds, checkpoints, preparation, ports, tart forwarder
  cli/                  # ActionCliClient commands, `ssh`, `dev`
  state/                # private-dir rules, sqlite open, atomic replace, owner lock
tools/
  release/              # bundle, prepared images, notices, SEA build + signing (replaces scripts/release, images/*.py)
  work-runs/            # run/list/clean with Effect Scope teardown (replaces scripts/work_runs.py)
  oxlint/               # anti-slop plugin, installed from upstream by the install-anti-slop skill
tests/live/             # gated live acceptance project (replaces tests/*.py, protocol/test/*)
images/                 # recipes and package locks (data only)
```

Catalog: effect, @effect/platform-node, @gjermundgaraba/effect-actions,
@gjermundgaraba/clankerauth-sdk, @gjermundgaraba/clankerauth-dev,
typescript 7.0.2, vite-plus 1.0.0, @types/node 26. No native addons.

**One multi-role binary per platform** replaces the four Go binaries. A SEA is
about 150 MB, so one binary per platform. Targets:

- darwin-arm64: CLI, controller, host.
- linux-amd64: CLI, controller, host.

The linux-arm64 target existed only for the guest daemon inside Linux images
built on Apple Silicon, and goes with it.

Units run `process.execPath host`. `clankerbox dev` runs the controller as an
in-process Layer, which removes `--ready-file` and the child-process probe loop.

## Feature scope

Rule: a feature with no real consumer is deleted.

The real consumers are:
- the clankerbox CLI, as used by the operator
- Clankerdesk
- the production personal-cloud deployment
- the `clankerbox-profiles` recipes
- clankercreds

Usage by tests, docs or harnesses alone doesn't count.

**Kept:**

| Area | Features |
| --- | --- |
| Lifecycle | create, start, stop, delete, fork (RAM forks), checkpoint capture/get/list/delete, restore, operation inspection, idempotency keys on every mutation |
| Runtimes | smolvm (Linux guests) and Tart (macOS guests), both in production |
| Profiles | publish (with `--wait`), build logs, cancel, profile and revision deletion, bases listing. Profile fields `id`, `host_id`, `base_id`, `cpu`, `ram_mib`, `storage_gib`, `overlay_gib`, `expose`, plus `setup.sh` and `files/` |
| Preparation | `/var/lib/clankerbox/machine-id` (clankercreds reads it), and `start` in `/etc/clankerbox/machine.json` |
| Access | per machine, one endpoint `{name, host, port}` per exposed guest port, and the guest's SSH host public key |
| CLI | `ssh MACHINE [ssh args…]`; `hosts`; `machines`; `checkpoint list`; `operation`; `--json`, `--async`, `--timeout`, `--idempotency-key` |
| Dev | `dev` with `--state-dir`, `--cpus`, `--ram-mib`, `--bundle`; `dev stop`; `dev destroy` |

**Deleted:**
- **Sessions in clankerbox:** the guest daemon, PTY and pipe sessions, the session API and its stream, engine snapshots, the query filter, `clankerbox shell` and `clankerbox sessions`. Clankerdesk's sessions move to its own daemon ([Handed to Clankerdesk](#handed-to-clankerdesk)); shells and file copy use ssh, scp and rsync.
- **`machine.json` `env` and `start.timeout_seconds`.** The profile writes guest environment itself (for example `/etc/environment` in `setup.sh`). The start command runs detached, and nothing waits for it, so its timeout and the 120 s session gate (`internal/guest/daemon/service.go:236`) go.
- **Response fields no consumer reads:**
  - Machine: `generation`, `accepted_generation`, `desired_state`, `prepared`, `observed_at`, `created_at`, `source_machine_id`, `checkpoint_id`, `guest`
  - Operation: `generation`, `created_at`, `updated_at`
  - public Checkpoint: `source_generation`, `created_at`, `runtime_pin`, `profile`. The public and host checkpoint messages become separate messages.
  - ProfileBuild: `upload_id`, `recipe`, `base`, `created_at`, `updated_at`
  - Profile listing: `base_id`, `storage_gib`, `overlay_gib`
- **Error reasons never sent:** `UNAUTHENTICATED`, `PERMISSION_DENIED`. HTTP 401/403 carry authentication failures.
- **Labels (D6):** machine labels everywhere.
- **CLI:** the `guest` command, `labels`, `profile init`, `profile revisions`, `profile publish --build-id` resume, `default_host` and `create --host`.
- **Host knobs:** `port_lease_root`, `port_min/port_max` (D2 uses a fixed range), `dns`, `launchctl_path`, `launchd_domain`, `systemctl_path`, `tls_cert`, `tls_key`, `tls_ca`.
- **Dev:** bundle relocation, sticky `--cpus`/`--ram-mib`, per-project default state-dir hashing, `--listen`.

## Simplification inventory

Reviews of the controller, host, guest and CLI/dev/tooling, followed by the
dependency audit in [design-audit.md](design-audit.md), produced the items
below. Each is labelled:

- **delete**: dead or compatibility-only; remove outright.
- **collapse**: two paths do one job; merge them.
- **keep**: load-bearing; the failure mode it prevents is named.

Product decisions are under [Decisions](#decisions).

### Contract and wire

- **delete** `internal/rpcmodel` (~1.1k lines of proto↔model mapping). One Effect Schema per resource is both the domain type and the wire type.
- **delete** the session service, the RPC stream, SchemaBinary and WebSockets. Every call is a unary effect-actions call.
- **collapse** the 22 `ErrorReason` values into about 7 tagged errors: Invalid, NotFound, Conflict{kind}, Precondition, Capacity, Unavailable, Internal. `retryable` is derived from the tag. Drop the unused `ErrorDetail.resource_id`/`operation_id` and all reserved fields. Clankerdesk branches on the refusal reasons that mean "not accepted" (`machine-recovery.ts:32-43`); each must survive as a tag or a `kind`, or be dropped together with Clankerdesk's branch. `Unavailable` must not be a refusal, so an offline-host submission stays unconfirmed and is replayed with the same key.
- **collapse** the three CLI JSON encodings into one, the Schema encoding.
- **keep** the CLI's `{error:{message,code,reason,retryable}}` object and exit codes 255/130/128+n. Without them, scripts can't tell a CLI failure from a remote exit.
- **delete** `capabilities` string lists and branch on `runtime`. **keep** `Checkpoint.kind` (`ram | disk`), derived from the runtime, because Clankerdesk's UI reads it. Also delete `Branchable`, which always equals smolvm.
- **delete** duplicate identity fields: `Machine.profile`/`host` next to the pinned profile, `Checkpoint.host`, and `CreateMachine.host_id` (the profile pins the host). The CLI `default_host` goes with them.
- **collapse** IDs to host-qualified IDs (`<host>.<id>`) for machines, checkpoints, operations and builds, so the stateless controller routes by prefix. Names are unique per host and resolved by fan-out; ID-shaped names are forbidden.

### Controller

The controller becomes a stateless router (audit, host core). This deletes,
rather than collapses, nearly everything the Go controller did:

- **delete** the database, admission pipelines, operation targets, the queue and its worker, the 5 s resubmit loop, reservations, `DesiredState`, the observation cache, the generation fence, the offline duplicate check, checkpoint tombstones, capacity, the profile catalog and the build worker. Each moves to the host or has no job without controller state.
- **keep** fan-out with per-host results: a list returns what reachable hosts answered and names the unreachable ones, rather than failing whole.
- **keep** clankerauth on every call, so the host can trust the controller only through the key, not the network.
- **delete** hand-written shutdown (Effect scopes).

### Host

**Journal and operations**

- **collapse** the host work loop, `acceptOnly`, synthesized statuses, the second fingerprint check and three locks into one owner lock for the process lifetime, a `Semaphore(1)` for native mutations, and journal-then-fork-fiber.
- **collapse** the journal to one durable write before a native effect: `accepted → started → succeeded | failed`. At startup a `started` row becomes `failed` with `uncertain: true`; nothing is replayed past `started` (D5).
- **keep** writing `started` before each native effect. Without it a RAM child gets cold-booted twice, or `create` adopts a foreign VM.
- **collapse** native errors into certain refusals (`failed`) and everything else (`failed`, `uncertain`). Nothing is released without an explicit delete, so the Go "abandon failed branch" proofs go.
- **collapse** idempotency to key + action: a known key with the same action returns the existing operation; a different action is `Conflict`. No fingerprints, no horizon; operations are kept.
- **collapse** busy checks onto real operation columns (`machine_id`, `source_id`, `checkpoint_id`, `revision_id`); revision references are enforced by foreign keys. This replaces the revision reference fence.
- **collapse** builder and validation VMs into ordinary machine rows, so capacity counts them and a failed cleanup is an ordinary delete.
- **collapse** profiles into `builds` plus `profiles(name → build_id)` on the host. A revision is a succeeded build, and the upload ID is the build ID. This deletes `ProfileRevision`/`ListProfileRevisions` and the `recipe_uploads` table.
- **keep** a separate fiber for builds; they can run for an hour and would otherwise block lifecycle work.
- **keep** capacity on the host, from host config (D7).
- **keep** the per-runtime source-state rule: smolvm forks a running VM, Tart copies a stopped disk (Tart's clone doesn't require a stopped source, `Clone.swift:122-128`).
- **keep** recording completion even when the caller has cancelled, so cancellation can't lose an ambiguous result.

**Runtimes: smolvm**

- **collapse** to one smolvm inventory per host, on both OSes (D8). This deletes `StoreID`, per-store template staging and the cross-store port problem.
- **delete** the backing-store dependency checks (both `machineDependencies` copies): smolvm's `delete_vm` takes the fork-source lock and refuses deleting a fork base before stopping anything. Map its error to `Precondition`.
- **collapse** re-inspection into trusting smolvm's exit codes: `machine start` returns after the agent is ready, `stop` after the process is dead, `exec` refuses a stopped machine, delete removes the record only after death and storage removal. Delete `waitState` polling, the pre-exec inspect and the 3–4 inspections per start/delete. Read one machine with `machine status --name X --json`, never `machine ls`.
- **keep** the smolvm CLI; not `smolvm serve` and not the `smolmachines` Node SDK (design-audit.md has the reasons).
- **collapse** the supervisor matrix into `Supervisor.launch(label, argv, env)`:
  - Linux: `systemd-run --collect` with kill properties, on the system manager in production (root, D11) and the user manager in dev; no unit files, no daemon-reload. If spike P4 shows `SMOLVM_VM_USE_SCOPE` gives each VM its own cgroup, root mode uses that instead.
  - macOS: one plist renderer.

  **keep** one supervised job per VM, because the CLI starts the VMM in the caller's cgroup and a host restart would otherwise kill the VMs. Never set `SMOLVM_BOOT_BINARY` (it arms a parent-death watchdog).
- **keep** VM jobs referencing only smolvm or tart, installed under a directory keyed by runtime digest, never the clankerbox binary. A clankerbox release that doesn't change the runtime then leaves running VMs alone.
- **collapse** stop into one rule for both runtimes: graceful, bounded wait, then forced. On smolvm, drop `runtime.patch` hunk 4 (`SMOLVM_STOP_REQUIRE_ACK`): upstream `stop` already requires the guest's ack, and the hunk only forbids the last-resort kill, which D5's "stop ends in a confirmed state" needs.
- **collapse** the checkpoint pin to `(runtimeDigest, revisionId)`. smolvm records and enforces sizes, platform, CPU contract and network; it does not check the engine build or the agent, so the runtime digest stays ours.
- **delete** the post-capture checks and re-chmod: smolvm's capture is atomic. Keep removing `checkpoints/<id>/` after a crash, as hygiene.
- **collapse** `pendingRAMFiles` (which re-derives smolvm's private VM directory) into one check on the path from `smolvm machine data-dir`, and drop `SMOLVM_DISABLE_READONLY_RESTORE=1`.
- **keep** the per-machine rootfs copy: the guest can write its lower through `/oldroot`, so the copy is an isolation boundary. Fix restore to copy with reflink/clone like create does (today `restoreRAM` runs plain `cp -a`).
- **delete** the `DNS` knob: smolvm's gateway relays DNS, and smolvm refuses capturing a machine with custom DNS.

**Runtimes: Tart**

- **collapse** Softnet flags to `--net-softnet-block=@host`. Blocking `@host` also blocks gateway DNS, which is why the image pins public resolvers.
- **delete** `tart ip`, `HOME=<root>` for tart (test the keychain on removal) and the refusal to replace a live launchd job. Write the plist once at create; start is `launchctl print` → bootstrap if absent → `kickstart` without `-k`.
- **collapse** to `tart set --random-serial` once per clone; delete `--random-mac` (clone already regenerates a colliding MAC).
- **delete** clone bookkeeping: Tart builds clones in a temp directory under a lock and garbage-collects interrupted ones. Since 2.40.1 clone refuses an existing destination; map that to `Precondition` and never pass `--overwrite`.
- **delete** the before/after inspections around `tart delete`: exit 2 means missing, and from 2.40.0 a running VM exits 1.
- **keep** stop as in-guest `shutdown -h now`, then `tart stop --timeout 0` as the forced fallback. Today there is none, so a hung guest fails stop after 90 s.
- **keep** the two-VM limit as a cheap admission count from `tart list` (Apple enforces it system-wide), and map the native refusal to `Capacity`.
- **keep** tart-guest-agent as a root LaunchDaemon in image preparation (agent ≥ 0.15.0). This deletes the `sudo -n` relay, the sudoers dependency and `privilegedScript`.

**Preparation, access and the rest**

- **delete** the guest daemon and everything that served it: guest binary staging, the per-start `sha256sum`, the guest registry, `guest connect`, the guest link, `binding.json`, and the orphan-reaper requirement.
- **collapse** preparation into one host-side script run over `Runtime.exec` after every start, fork and restore (D2). The script ships inside the host binary, so a guest image never contains clankerbox code.
- **collapse** the three exec wrappers and two shells into one `Runtime.exec(machine, argv, stdio)` per runtime.
- **collapse** the two-phase owner marker into one init: build in a temp directory, then rename.
- **delete** single-value knobs: `HostOS` (from `process.platform`), optional `HostID`, `ControllerID`, `SystemdUser`/`LaunchdDomain`, and the `systemctl`/`launchctl` path knobs.
- **delete** dead state: the `"inspect"` branch in `Execute`, the persisted `Manifest.endpoint`, the duplicate fork architecture check, and the requirement that `CancelProfileBuild` carry the full recipe (cancel by ID instead).
- **keep** discarding an interrupted capture, so partial RAM artifacts are never published.
- **keep** the separate validation VM, so an unbootable revision never goes live.
- **keep** build outcome separate from cleanup state, as one tagged union, so a transient cleanup failure doesn't discard validated work.
- **keep** symlink-confined rootfs extraction. Node has no `os.Root`, so reject any entry under a symlink the archive created.

### CLI, dev and tooling

- **collapse** `shell` into `clankerbox ssh MACHINE [ssh args…]`: it looks up the machine's `ssh` endpoint and host key, writes a one-line known-hosts file and execs the system `ssh`. Ports change on fork and restore, so typing them by hand isn't practical.
- **collapse** dev teardown into two separate commands:
  - `dev stop`: the host stops every VM and confirms none is running, then the host service stops. Everything on disk is kept.
  - `dev destroy`: `dev stop`, then remove the owned roots.

  This deletes the teardown journal, the one-use token, the private controller and the dependency-ordered deletion graph. Three requirements are loosened:
  - Destroy doesn't delete machines and checkpoints through the API. Every Tart VM and the smolvm store live under the host root, so removing the root is safe once nothing is running.
  - Stop doesn't settle operations or cancel builds first. It is a crash-safe shutdown, and the host journal handles interrupted work on the next start.
  - The allow-list of known entries becomes an owner marker: destroy removes a root only if it carries the marker written at init, and init refuses a non-empty directory without one.

  **keep** the "confirm none running" check, so disks are never deleted under running VMs.
- **collapse** dev auth into `@gjermundgaraba/clankerauth-dev`. This deletes token generation, token files, the 32-byte/0600 checks, the bearer readiness probe and `teardown-token`.
- **collapse** the two dev state roots into one. The default `--state-dir` is a fixed `~/.clankerbox/dev` rather than a per-project hash. The short runtime root is keyed by a hash of the state dir. **keep** the short path; macOS socket paths are limited.
- Dev publishes exposed ports on loopback and reports `127.0.0.1:port`, so dev needs no tailnet.
- **delete** bundle relocation repair, because units point at `process.execPath` of a fixed install.
- **delete** the env `Version: 2`, `manifest_format: 3` and `clankerbox-prepared-v2` markers. **keep** the marker for operator Tart seeds, so an unprepared seed isn't booted.
- **collapse** the manifest to `{version, platform, runtimeDigest, imageDigest, files}`. **keep** full digest verification, so a RAM checkpoint never restores on a different engine or image.
- **collapse** CLI flag drift into shared `--json/--async/--timeout/--idempotency-key` options:
  - `profile publish` waits by default, like lifecycle commands.
  - Delete the `profiles` alias of `profile list`, and `dev --listen`. Dev picks a port once and keeps it in its state, so the URL is stable across restarts.
  - Merge `client.json` and `connection.json`. Clankerdesk's real-clankerbox harness migrates with the release; these aren't compatibility constraints.
- **collapse** duplicated pins (Ubuntu/Node/agent/Cargo.lock across `stage-linux.py`, `pins.json`, `source.json` and image sources) into one `release-inputs.json` keyed by platform. It includes the Node SEA base binaries.
- **delete** `prepare-templates.py` and `template-provenance.json`: a one-off v0.3.0 reproduction whose outputs are already pinned.
- **keep** `runtime.patch` (hunks 1–3; hunk 4 goes, see smolvm), the engine pins and the LGPL/GPL notices, which are redistribution obligations. Add Node's LICENSE and pnpm dependency notices.
- **collapse** the live harnesses (3 Python harnesses, a benchmark and 3 Node scripts, chained through `--keep/--resume/--lifecycle-result`) into one gated `tests/live` project:
  - It owns its machines, with deterministic idempotency keys.
  - Delete the smolvm-1.16 `--trim-before-fork`/`--engine-vms` guards and the `real-vm.mjs` debug actions.
  - Delete the Python unit tests of harness helpers.
- **collapse** `work_runs.py` into `Effect.Scope` finalizers plus `run/list/clean`. **keep** `needs_teardown` and the refusal to clean a running run.
- **delete** historical docs: 6 qualification records (808 lines), `docs/runtime-profile-qualification.md`, `docs/terminal-sessions.md`, `docs/plans/*` (this plan last, just before the merge) and the performance "qualified comparison". Move the requalification checklists into the bump skills, together with the per-dependency claims of design rule question 5.
- **collapse** ADRs into a fresh set that drops the superseded banners, with new ADRs for TS/Effect, clankerauth, SEA, the stateless controller and profile-owned guest access.
- **collapse** CI into one vite-plus job plus a SEA build smoke test on 2 targets.

## Decisions

Numbers are stable: withdrawn decisions keep their number.

- **D1. Terminal stream transport. Withdrawn** with sessions (D2). The
  credit-window design moves to Clankerdesk, where SSH channel windows replace it.
- **D2. Guest access. Decided: the profile owns it; clankerbox publishes ports
  and prepares machines.**
  - **Profile side.** A profile installs whatever serves the guest (normally
    sshd; Clankerdesk's profile adds its session daemon) and declares
    `expose: {name: guestPort}` in `profile.json`, for example `{"ssh": 22}`.
    `expose` is in `profile.json` because the host reads it at create;
    `machine.json` is written into the guest and read there.
  - **Preparation (one script, three triggers).** After every start, fork and
    restore, the host runs its preparation script over `Runtime.exec` as root:
    1. Compare `/var/lib/clankerbox/machine-id` with the expected host-qualified
       machine ID. On a mismatch (create, fork, restore) write the ID and re-mint
       the SSH host keys. smolvm already re-mints them on fork, but not on
       restore, and neither touches a running sshd.
    2. If sshd is running and the ID changed, `SIGHUP` it so it loads the new
       keys (a RAM child resumes with the old keys in memory).
    3. If this was a cold start (no marker in `/run`, which a reboot clears and a
       RAM fork or restore keeps), write the marker and launch `start` from
       `/etc/clankerbox/machine.json`
       detached: `smolvm machine exec --detach` on smolvm (the agent is PID 1 and
       there is no init); on Tart, the same through `tart exec` (spike P3).
       smolvm's `create --init` runs only on first boot despite its help text, so
       it isn't used.
    4. Print the SSH host public key, if there is one.

    The machine-ID comparison makes preparation self-repairing and removes the
    `prepared` flag: a crashed preparation is simply run again on the next call.
  - **Publishing on smolvm.** A machine with a non-empty `expose` is created with
    `--net --net-backend virtio-net` and `-p hostPort:guestPort` per entry.
    `SMOLVM_PUBLISH_ADDR` (the host's tailnet address; loopback in dev) and an
    explicit `SMOLVM_EGRESS_FLOOR` are set in the VM job's environment, because
    setting the publish address alone switches the egress floor to strict.
    Machines that expose nothing stay on the default backend.
  - **Port allocation.** The host picks host ports from 10000–19999: below
    smolvm's fork range (20000–32000) and the Linux ephemeral range (32768 and
    up), so neither smolvm nor the kernel hands one out. It excludes
    ports on its machine rows, and confirms each with a bind probe. Forks get
    fresh ports from smolvm, which the host reads back from
    `machine status --json`. A restore reuses the checkpoint's ports verbatim,
    so the host allocates new ones and applies them with `machine update` before
    start.
  - **Publishing on Tart.** Tart has no port publishing, and the guest's Softnet
    address is reachable only from the Mac. The host process runs a forwarder:
    for each exposed port of a running machine it listens on
    `publishAddress:hostPort`, and each accepted connection runs
    `tart exec -i <vm> nc 127.0.0.1 <guestPort>`. No guest IP, no Softnet
    exception and no Local Network permission (D9 stands). Each connection costs
    about 560 ms to open (S3); a host restart drops open Tart connections,
    whereas smolvm's listeners live in the VMM.
  - **Reported to clients.** `Machine.endpoints: [{name, host, port}]` and
    `Machine.hostKey` (the public key line). Clients pin the key; that replaces
    the expected-machine-ID check on every guest connect.
  - **Security.** Anything on the tailnet can reach a published port; sshd's
    keys and the pinned host key are the protection. Guests themselves are
    floored away from private ranges by smolvm and Softnet.
  - **Fallback if phase-0 spike P1 fails:** no published ports;
    `clankerbox pipe MACHINE PORT` carries bytes over `Runtime.exec` into the
    guest's `nc`, used as an ssh `ProxyCommand` (and as a custom socket by
    Clankerdesk's ssh client). Ownership stays the same; clankerbox becomes a
    byte pipe in the data path. smolvm's `--expose-socket` is the other fallback.
- **D3. Reconnect catch-up for mirrors. Withdrawn** with sessions; Clankerdesk's
  daemon keeps snapshot-only reconnect.
- **D4. Dev host under launchd/systemd. Decided:** keep it, so VMs survive Ctrl-C
  and a closed terminal. It gets smaller through the `Supervisor.launch` collapse
  and the fixed install path.
- **D5. Operation outcome. Decided:** `pending | succeeded | failed`, and `failed`
  carries `uncertain: boolean`.
  - **The host can't confirm the result** (a native error that isn't a certain
    refusal, or a `started` row found at startup): `failed`, `uncertain: true`.
    The machine shows whatever the runtime reports, possibly `missing`.
  - **No answer from the host:** the controller returns `Unavailable`; the
    caller retries with the same idempotency key, and the host answers from its
    operation row.
  - **Way out:** `stop` and `delete` are always admitted and cope with leftover
    native state, including a live orphan VM process. Phase 3 verifies this per
    runtime.
- **D6. Labels. Decided: delete them.** Nothing in clankerbox reads labels.
  Clankerdesk's one use, a workspace ownership check (`terminals.ts:558`), moves
  to its own allocations table.
- **D7. Host capacity. Decided: configured on the host** (reverses the earlier
  controller-side choice, which needed controller state).
- **D8. smolvm store layout. Decided:** one inventory per host on both OSes, with
  templates staged once per runtime digest at startup (pending spike P8).
- **D9. macOS Local Network permission. Resolved by S4 and D2.** The Tart
  forwarder reaches guests through `tart exec`, not their IP. The only remaining
  local-network connection is the host reading clankerauth's key list, and only
  if the issuer resolves to a LAN address; if it does, ship darwin as an `.app`
  wrapper (codesign binds its `Info.plist`). Spike P2 also checks that accepting
  connections on the tailnet interface needs no permission.
- **D10. Host-hop TLS. Decided: none** (see Network in
  [Settled decisions](#settled-decisions)).
- **D11. smolvm as root. Decided: root on the production Linux host, unprivileged
  in dev** (laptops, and smolvm on macOS). Root turns on smolvm's per-VM uid drop,
  so a VM escape lands in a uid that owns nothing else (today it lands as
  `clanker`, which owns every VM and the host database); it also lets restores
  use a copy-on-write disk and shared read-only RAM. Gated by spike P4. Deploy
  changes in phase 8: system units, host state out of `/home/clanker`, and the
  `skuid 1000` egress rule in `hetzner-wg-guard.nft` becomes a uid-range or
  cgroup match.
- **D12. Multi-host placement. Future.** With a stateless controller, a same-key
  retry reaches the same host only while profile → host is unique. Several hosts
  per platform will need either every pool host reachable at placement or a
  key → host record. Not built now.

## Handed to Clankerdesk

Clankerdesk's terminal sessions move into a session daemon that Clankerdesk
builds, ships in its profile and upgrades itself. It is reached through the
guest's sshd: Clankerdesk opens one SSH connection per machine, multiplexes
sessions over it, and runs `sessiond connect` (or a streamlocal forward) into
the daemon's Unix socket. sshd provides auth, encryption, flow control and
identity (the pinned host key). Clankerdesk keeps LOST, final screens and exit
codes.

**What clankerbox owes it:** `Machine.endpoints` (an `ssh` entry), `Machine.hostKey`,
the machine-ID file, and a profile with `expose: {"ssh": 22}`. Nothing else.

**Design carried over from this plan's session work, still valid for the daemon:**

- One `Input` in flight per attachment (up to 4 MiB), written fully before the
  reply; no budgets, offsets or acks. Output backpressure comes from the SSH
  channel window instead of D1's credit window.
- Snapshot-only reconnect (D3) with the Ghostty engine; never compare snapshot
  bytes for equality. Snapshots reach about 3.5 MB.
- Create idempotency by session ID: an unknown ID starts, a known ID opens.
- The lossy tail plus Gap for PTY output; one write lock per session plus a
  bounded reply queue, so a DA/CPR reply never lands inside a paste.
- The end ladder `kill(-pid, SIGHUP)` → TERM → KILL, with an exit flag checked
  before each signal.
- Registering the subscriber before launch; the 2 s idle drain after exit.
- A per-guest session cap (a terminal is 7.4 MiB typical, 34 MiB worst case, and
  never shrinks).
- **An orphan reaper on smolvm.** The smolvm agent is PID 1 without a
  `waitpid(-1)` loop, and Node can't be a subreaper, so the daemon runs under a
  `tini -s`-style wrapper.
- S1 (node-pty in a SEA: read with `tty.ReadStream`, write with `fs.writeSync`
  and EAGAIN backoff, node-pty 1.2.0-beta for the macOS fd leaks) and S2
  (Ghostty VT in Node) results, in `spikes/` until the scaffold phase, then in
  Clankerdesk.
- Open items from the audit: PTY master fds leaking across sessions on Linux,
  `child_process` children inheriting PTY masters, and zmx 0.8.1 as an
  off-the-shelf alternative (design-audit.md, decision 9).

## Spikes

### Done (2026-09-30)

Code and notes are under `spikes/`, deleted in the scaffold phase once folded in.

- **S1, S2:** handed to Clankerdesk (above).
- **S3, exec-channel transport: pass.** On smolvm (macOS and Linux) and Tart:
  echo round trips of 0.2–0.9 ms, bulk 70–250 MiB/s, idle streams surviving
  11+ minutes. The first exec costs about 150–215 ms on smolvm and about 560 ms
  on Tart. These numbers size the Tart forwarder and the D2 fallback.
- **S4, SEA build and signing: pass.**
  - `node --build-sea` builds every target from one machine, given each target's
    official Node binary. No postject is needed.
  - Binaries are about 144–151 MB, and start in about 42 ms.
  - darwin needs the hardened runtime with `allow-jit`. (`disable-library-validation`
    was for `pty.node` and goes with it.)
  - Pin the Node archives by SHASUMS256.
- **S5, clankerauth 0.11.0: pass (10/10).** Dev mode embeds
  `startDisposableIssuer` in-process, with `dataDir` and a fixed port so keys
  survive restarts. Tests use the SDK's `startFakeIssuer` with a `Clock` override.

### Phase 0 (before building packages; gates D2 and D11)

| Spike | Gates |
| --- | --- |
| **P1. Published ports on smolvm**, Linux test host: a virtio-net machine with `-p` on a non-loopback address and a pinned `SMOLVM_EGRESS_FLOOR`; sshd from a profile; RAM fork (fresh port from smolvm, host key re-minted, sshd `SIGHUP`); restore beside a running source and a second restore from the same checkpoint (the `machine update` port swap, key re-mint in preparation); RAM fork and checkpoint on virtio-net; ssh, scp and rsync from another machine. Also: whether TSI serves `-p` (smolvm's detach help suggests so), which would avoid virtio-net for checkpoint-free machines. | D2, or its fallback |
| **P2. Tart forwarder:** listener → `tart exec -i` → guest `nc 127.0.0.1 22`; ssh and rsync throughput, idle survival, and that accepting on the tailnet interface needs no Local Network permission. | D2 on Tart, D9 |
| **P3. Preparation:** the script over exec on both runtimes; `smolvm machine exec --detach` keeps `start` alive after exec returns; the Tart equivalent (`tart exec` with `nohup`/`setsid`, or `launchctl submit`). | D2 |
| **P4. smolvm as root:** the per-machine rootfs is readable by the dropped per-VM uid; copy-on-write restore works; whether `SMOLVM_VM_USE_SCOPE` replaces `systemd-run`. Needs your approval on the test host. | D11 |
| **P5. Re-run S4 and S5** on Node 26.10.0 (26.9.0 changed the Linux `--build-sea` layout for non-PIE inputs) and clankerauth-sdk 0.11.1. | phase 1 |

### Phase 3 (host)

| Spike | Gates |
| --- | --- |
| P6. smolvm `pack create --from-vm` as profile capture: works on our Ubuntu lower, keeps ownership (the tar path drops uid/gid, xattrs and capabilities today), pack time and size. It produces delta-on-base revisions, against ADR 0008's "self-contained". | builds |
| P7. The 2.1 GiB agent rootfs in every checkpoint: capture tars the whole lower and restore unpacks it again; smolvm assumes ~29 MB. Measure with smolvm's `restore_*` log spans before designing. | checkpoints |
| P8. Read-only template install making `stageTemplates` unnecessary; whether the compact 512 MiB templates are still needed. | D8 |
| P9. smolvm `--store` checkpoints instead of single files: the restore cache, `checkpoint-warm` and dedupe apply only to store checkpoints; the agent rootfs tar cache applies only to single files. Measure both. | checkpoints |
| P10. macOS smolvm: one host launchd job with `AbandonProcessGroup` versus one plist per VM. | supervisor |
| P11. Tart third VM: fast refusal or a hang until timeout. | Tart capacity |
| P12. Concurrent smolvm CLI calls against one inventory (gates raising the native-call semaphore). | lifecycle |
| P13. `runtime.patch` hunk 1 (overlay `index=off,…`): does ESTALE reproduce without it? Hunk 3 is an upstream inconsistency worth sending upstream; hunk 2 is test-only. | release |

## Phases

Each phase ends with `vp run ready` green. The live tests run where hardware allows.

0. **Spikes P1–P5.** Review point: if P1 fails, switch D2 to its fallback before
   phase 2; nothing else in the plan changes.
1. **Scaffold.** Root workspace, catalog, lint and CI. Scaffold the
   `apps/clankerbox` role dispatcher and the SEA build for 2 targets, with a
   hello-world per role.
2. **Contract.** Schemas, the tagged errors, host-qualified IDs and the
   ActionGroups (machine, checkpoint, profile, host, operation).
3. **Host.**
   - Journal, lifecycle, the smolvm and Tart runtimes, the supervisor, builds and
     checkpoints, with spikes P6–P13.
   - Preparation, port allocation, smolvm publishing and the Tart forwarder (D2).
   - The clankerauth resource.
   - `stop` and `delete` on every runtime after an interrupted operation (D5).

   Unit tests use a fake runtime layer; the live tests use real VMs.
4. **Controller.** Auth, routing by host prefix, fan-out and name resolution.
5. **CLI and dev.** ActionCliClient commands, `ssh`, and `dev` with
   clankerauth-dev.
6. **Tooling.** `tools/release` (bundle, images, notices, SEA), `tools/work-runs`
   and `tests/live`. Rewrite AGENTS.md, `WORK_RUNS.md`, the README, docs and ADRs.
7. **Cut over.** Delete `cmd/`, `internal/`, `gen/`, `protocol/`, `go.mod`/`go.sum`,
   `.golangci.yml`, the Makefile, the Python tooling and the historical docs.
   Change `publish-sdk.yml` to publish `packages/contract` on release tags.
   Migrate Clankerdesk in the same coordinated release. Its session daemon
   ([Handed to Clankerdesk](#handed-to-clankerdesk)) is Clankerdesk's own work
   and must be ready before this phase. On the clankerbox contract side:
   - `clankerbox.ts`, `guest-terminal.ts` and `guest-mirror.ts`: sessions go
     through the daemon over ssh, using `endpoints` and `hostKey`.
   - the ownership check in `terminals.ts`, which moves from labels to its allocations table
   - `GetMachine` answering `NotFound` means deleted (today it reads `machine.deleted`, `machines.ts:366,379`); checkpoint deletion (`checkpoints.ts:155`): `status === "deleted"` becomes `NotFound`
   - operation status (D5): `unresolved` becomes `failed` with `uncertain`, and `running` merges into `pending`. The sites are `checkpoint-client.tsx:190`, `machine-recovery.ts:96`, `checkpoints.ts:231` and `machines.ts:363`. The close path can stop and delete after an uncertain failure.
   - `admissionRefusals` (`machine-recovery.ts:32-43`) maps to the new tags, with `Unavailable` left out
   - error-reason branches, updated to the tagged errors
   - the checkpoint dialog says Tart needs a stopped source but never stops it: Clankerdesk adds the stop
   - the real-clankerbox harness, updated for the new dev mode and config files

   Run the full live acceptance suite on Apple Silicon (smolvm and Tart) and on
   Linux/amd64 with KVM, then merge.
8. **Redeploy production.** In personal-cloud: destroy the 0.11.0 machines and
   checkpoints on both hosts; move the hosts and the controller onto the tailnet
   (if not already done) and delete the clankerbox WireGuard link, the PKI and the
   UniFi rule; run the Linux host as root (D11: system units, state out of
   `/home/clanker`, the `skuid 1000` egress rule); deploy the TS release with
   clankerauth keys; republish the profiles (`linux-dev`, `mac-xcode`,
   `gg-linux-dev`) with sshd and `expose`, moving `gg-linux-dev`'s `env` into its
   `setup.sh`.
9. **Clean up the test machines,** following
   [Test machine footprint and final cleanup](#test-machine-footprint-and-final-cleanup).

## Validation

- `vp check`, `vp run -r test` and `vp run -r build` on every change.
- SEA smoke tests on each target: every role starts and `--help` works.
- Live acceptance, which must cover:
  - create/start/stop/delete
  - RAM fork, and checkpoint capture/restore/delete
  - profile publish/cancel
  - `clankerbox ssh` into a machine on each runtime, with the pinned host key;
    scp and rsync of a binary file, compared by hash
  - a fork and two restores of one checkpoint: each gets its own port and host
    key, and ssh works into all of them while the source runs
  - host restart keeping VMs, smolvm's published ports, and the machine-ID file;
    Tart endpoints coming back after the forwarder restarts
  - `stop` and `delete` after an interrupted operation
  - `dev stop` keeping disks and checkpoints, and `dev destroy` removing them
  - `--json` error classification
- Clankerdesk's real-clankerbox suite passes against the TS release before merge.
- Every live run goes through the `work-runs` tool, following AGENTS.md teardown
  rules.
