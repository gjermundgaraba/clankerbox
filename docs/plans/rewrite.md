# TypeScript/Effect rewrite: plan

Status: planned, 2026-10-01. Every design decision below is closed. The phase-0
spikes still gate details of guest access and disk sizing. The evidence behind
the decisions is in [evidence.md](evidence.md). Both files are deleted in the
last commit before the merge.

clankerbox is rewritten from scratch in TypeScript on Effect 4, as a clean break.
No persisted state is migrated. Production is destroyed and redeployed at
cut-over, and there is never a release where both implementations ship.

The branch is already in the shape that delivery requires:

1. `88969a9` is the last state of the old tree: the Go code, the Python tooling,
   the old plan and design audit, and the review spikes.
2. `4898a3e` deletes everything.
3. The next commit adds these plans. Nothing else is started before it.

The Go implementation can be read at `main` (`c112847`) and at `88969a9`. Read it
there and don't restore it. evidence.md cites it as `G:path:line` at `c112847`.

**What clankerbox is after the rewrite:**

- It runs machines and reports where each one is reachable. Lifecycle covers
  create, start, stop, delete, RAM fork, checkpoints and restore.
- Profiles are captured machines.
- A small preparation contract runs over each runtime's own exec.
- Each port a profile exposes is reported as a `host:port`, together with the
  guest's SSH host key.
- Clients talk to hosts directly; there is no controller.
- Anything done *inside* a guest (shells, terminals, file copy) goes through
  software the profile installs, normally sshd.

## Settled decisions

| Area | Decision |
| --- | --- |
| Scope | The `clankerbox` binary (CLI and host), the SDK with its client library, release tooling and live tests. There is no controller and no guest daemon. |
| Runtime | Node 26.10.0 (the latest patch at each release), shipped as Node SEA single-executable binaries. |
| Effect | `effect` and `@effect/platform-node` **4.0.0**, the first stable release, published 2026-10-01. Before using `effect/http` and `effect/cli` (top-level modules in rc.118), check where they live at 4.0.0. |
| Contract | [effect-actions](https://github.com/gjermundgaraba/effect-actions) **0.9.0** for every call. All calls are unary HTTP. Input is closed: undeclared fields are refused. |
| SDK | `packages/contract` (Schemas, action groups, errors and the client library) is published as the next major of `@gjermundgaraba/clankerbox-sdk`, versioned with the binaries. `effect` is a peer dependency, `^4.0.0`, so a consumer has a single copy and Schema identity holds. There is no separate `sdk-v*` tag and no pairing table. |
| Auth | clankerauth **0.12.0** offline API keys and JWTs on the host API, through `@gjermundgaraba/clankerauth-sdk` and `Resource.make`. Each host is one resource, and one client key can carry grants on several hosts. At 0.11.1 the behaviour was: an unknown key triggers a key-list read (at most one per 5 s), revocation takes about a minute, and the last list stays valid for 24 hours during an issuer outage. Re-check this at 0.12.0 (P5). Tests use the SDK's `/testing` fake issuer, and dev mode uses `clankerauth-dev`. |
| Network | Hosts and clients share the operator's Tailscale tailnet (personal-cloud work, outside this plan). No hop uses TLS: the tailnet encrypts and authenticates, and clankerauth authorizes each request. A tailnet ACL should limit who can reach the host API port. |
| State | SQLite through `node:sqlite`, on each host. No migrations, and no client-side state beyond configuration. |
| Production | personal-cloud runs 0.11.0 with a Linux smolvm host (Hetzner) and a Mac Tart host. At cut-over, every 0.11.0 machine and checkpoint is destroyed, the new release is deployed, and the profiles are captured again. The Linux host runs smolvm as root. |
| MCP | None. |
| Tooling | vite-plus 1.0.0 (`vp`), pnpm 12, TypeScript 7.0.2, laid out like `/private/tmp/monorepo-example`. The lint setup (typeAware, typeCheck, the anti-slop plugin) mirrors clankerauth. Live runs use `scripts/work_runs.py`, restored unchanged in phase 0. |
| Dependency floors | smolvm 1.22.0 with a one-line patch to `smolvm-bin` (see [Release](#release)), Tart ≥ 2.40.1, tart-guest-agent ≥ 0.15.0, Softnet 0.24.0 (macOS 26 hosts), Node 26.10.0, clankerauth-sdk 0.12.0. |

## The design rule

Before building any mechanism that wraps a dependency, answer five questions,
and answer them again at every bump of that dependency:

1. **Duplicated bookkeeping.** Does the dependency already track this? Example:
   smolvm tracks fork lineage and refuses deleting a fork base.
2. **Owning what the dependency owns.** Are we deleting its files or managing its
   processes, and so needing proofs it doesn't need?
3. **Unrecorded choices.** Every layout choice, limit and timeout carries a
   recorded reason.
4. **Our comments are not evidence.** Check every claim against the
   dependency's source or docs at the pinned version.
5. **Re-audit on every bump.** A bump re-checks that dependency's claims, not
   just the tests. The bump skills carry the list of claims per dependency (start
   from evidence.md).

## Architecture

- **Clients:** the CLI and SDK users talk to hosts directly. A client holds a
  host list `[{id, url}]` and one clankerauth key covering those hosts.
  - The client library routes each call by the host part of the ID.
  - Lists fan out to every host. They return what reachable hosts answered and
    name the unreachable ones, rather than failing whole.
  - Profiles pin their host, so `create` from a profile goes to that host.
- **Host:** owns everything durable for its machines: machines, checkpoints,
  profiles and their revisions, and port allocations. Machine state (`running`,
  `stopped`, `missing`) is always read from the runtime, never stored.
- **Runtimes:** smolvm (Linux guests, RAM forks, checkpoints) through its CLI, and
  Tart (macOS guests, disk copies). Each is one module behind a shared `Runtime`
  interface. Only demonstrated common paths are shared (journal, preparation,
  port allocation, supervision); fork, checkpoint and access stay
  runtime-specific where that is smaller.
- **Guest contract:** preparation over the runtime's exec. No clankerbox binary
  runs in a guest.
- **Guest access:** the profile's. A profile declares the guest ports it
  exposes. The host publishes each one and reports it as `host:port`, together
  with the SSH host key.
- **Multiple hosts per platform:** not built. Placement is by profile → host,
  which is unique. A future pool would need either fan-out placement in the
  client or a key → host record.

## Target layout

```
package.json            # vp scripts: ready = check + test + build
pnpm-workspace.yaml     # apps/*, packages/*, tools/*; catalog pins below
vite.config.ts          # lint/fmt/staged/run.cache, as in clankerauth
tsconfig.json
apps/
  clankerbox/           # the only binary: `clankerbox <cli…> | host`
packages/
  contract/             # Schemas, action groups (machine, checkpoint, profile, host), errors, client library (host list, routing, fan-out)
  host/                 # journal, lifecycle, runtimes (smolvm, tart), supervisor, profiles, checkpoints, preparation, ports, tart forwarder
  cli/                  # commands, `ssh`, `dev`
  state/                # private-dir rules, sqlite open, atomic replace, owner lock
tools/
  release/              # SEA build and signing, patched smolvm-bin, bundle, notices
  tart-seed/            # prepares an operator Tart seed (tart-guest-agent as a root LaunchDaemon, prepared marker)
  oxlint/               # anti-slop plugin, installed from upstream by the install-anti-slop skill
scripts/work_runs.py    # restored unchanged from main, with WORK_RUNS.md
tests/live/             # gated live acceptance project, TypeScript, using the SDK
```

Catalog: effect, @effect/platform-node, @gjermundgaraba/effect-actions,
@gjermundgaraba/clankerauth-sdk, @gjermundgaraba/clankerauth-dev,
typescript 7.0.2, vite-plus 1.0.0, @types/node 26. No native addons.

**One multi-role SEA binary per platform**, about 150 MB each (about 45 MB
gzipped):

- darwin-arm64: CLI and host.
- linux-amd64: CLI and host.

Units run `process.execPath host`. VM jobs never reference this binary (see
[Supervision](#supervision)).

## API contract

**IDs and names**

- Every machine, checkpoint and profile has an ID of the form `<host>_<name>`.
  - The client chooses the name.
  - Names are unique per host and per resource type.
  - Host IDs must not contain `_`, and the ID splits at the first `_`.
  - The whole ID must match `^[A-Za-z0-9_-]{1,62}$`.
  - A name must start with a letter.
  - The host passes the name, not the ID, to smolvm, Tart and systemd scope
    names. Phase 2 checks that their name rules accept this grammar.
- The separator is `_` and the 62-character limit applies because the ID is
  written to `/var/lib/clankerbox/machine-id`. clankercreds accepts only that
  pattern there, and on a mismatch silently falls back to an identity that forks
  would share.
- The CLI accepts a bare name and resolves it by fan-out. More than one match is
  `Invalid`, and the error names the candidates.

**No idempotency keys, no operations resource**

- `create`, `fork`, `restore`, checkpoint `capture` and `profile capture` take
  the new resource's name. If that name already exists, the call fails with
  `Conflict{kind: "exists"}`. A client retrying after a lost reply reads the
  resource by name and decides for itself whether it is its own.
- `start` on a running machine and `stop` on a stopped one succeed without doing
  anything; a no-op `start` doesn't run preparation. `delete` of a missing resource is `NotFound`, which clients treat as
  done.
- **Invariant: an error reply means nothing was written.** Validation and
  admission finish before the host writes any row. Writing the row is the last
  step that can fail before a success reply. Phase 3 proves this for every
  mutation.
- Mutations return the resource immediately, with `pending` set, and the work
  continues in a fiber. Clients poll `get`. The CLI waits by default, up to
  `--timeout`.

**Resources**

- **Machine:**
  - `id`, `name`, `host`, `runtime`
  - `profile` (`{name, revision}`) or `base`
  - `cpu`, `ramMib`, `diskGib`
  - `state`, read from the runtime: `running | stopped | missing`
  - `pending?: {action}`
  - `lastFailure?: {action, message}`
  - `endpoints: [{name, host, port}]`
  - `hostKey?`
- **Checkpoint:** `id`, `name`, `machine`, `kind` (`ram | disk`, from the runtime),
  `status` (`pending | ready | failed`), `lastFailure?`.
- **Profile:** `id`, `name`, `host`, `runtime`, `current` revision, the revision
  list, and the spec captured from the source machine (`cpu`, `ramMib`, disk
  size, `expose`). A revision has a `status` (`pending | ready | failed`).
- **Host:** `id`, `runtime`, `version`, bases.

**Errors:** seven tagged errors:

- `Invalid`
- `NotFound`
- `Conflict{kind}`, where `kind` is `exists`, `busy` or `references`
- `Precondition`
- `Capacity` (a native refusal only)
- `Unavailable` (the host is unreachable; the client may retry)
- `Internal`

`retryable` is derived from the tag. HTTP 401/403 carry authentication failures.

## Feature scope

Rule: a feature with no real consumer is deleted. The real consumers are the
operator's CLI, the SDK's API clients, the production personal-cloud deployment,
the `clankerbox-profiles` repository and clankercreds. A feature used only by
tests, docs or harnesses doesn't count.

**Kept:**

| Area | Features |
| --- | --- |
| Lifecycle | create from a profile (its spec, unchanged) or from a base (with `cpu`, `ramMib`, disk size and `expose` given at create), start, stop, delete, RAM fork (smolvm) and stopped-disk fork (Tart), checkpoint capture/get/list/delete, restore |
| Runtimes | smolvm (Linux guests) and Tart (macOS guests), both in production. smolvm on macOS for dev. |
| Profiles | capture from a stopped machine, list, delete a profile or one unreferenced revision, point a profile at an older revision, list bases |
| Preparation | `/var/lib/clankerbox/machine-id` (clankercreds reads it), and `/etc/clankerbox/start` run after every activation |
| Access | per machine, one endpoint `{name, host, port}` per exposed guest port, and the guest's SSH host public key |
| CLI | `hosts`, `machines`, `create NAME (--profile P \| --base B --cpu N --ram-mib N --disk-gib N [--expose name=port]…)`, `start`, `stop`, `delete`, `fork`, `checkpoint capture/list/get/delete`, `restore`, `profile capture/list/delete/use/bases`, `ssh MACHINE [ssh args…]`; `--json`, `--timeout` |
| Dev | `dev` (with `--state-dir`), `dev stop`, `dev destroy` |

**Not carried over from the Go implementation:**

- **The controller:** its database, admission queue, resubmit loop,
  reservations, observation cache, generation fence, tombstones and profile
  catalog.
- **Idempotency keys:** fingerprints, operations and the `operation` command.
  Also `--async`, `--idempotency-key`, the `uncertain` outcome and its replay
  rules.
- **Profile builds:** recipe uploads, builder and validation VMs, the build
  worker, build logs, cancel and the one-hour deadline. `profile init`,
  `profile revisions` and `publish --build-id`.
- **Capacity accounting and its config:** Tart's native VM limit maps to
  `Capacity`, and there is no admission count. Machine scopes limit each VM to
  its own RAM.
- **Labels and `capabilities` string lists:** `Branchable` was always smolvm.
- **Guest-side machinery:** the guest daemon, sessions, `shell`, `sessions` and
  `guest`. Also the expected-machine-ID check on every connect, and every
  guest-side credential (host CA, per-epoch certificates, bindings).
- **TLS and the old auth:** TLS on any hop, PKI, the static bearer token, client
  certificates and Unix peer-credential checks.
- **Machine and checkpoint fields nobody reads:** `generation`,
  `accepted_generation`, `desired_state`, `prepared`, `observed_at`,
  `created_at`, `source_machine_id`, `runtime_pin` and duplicated host and
  profile fields.
- **`machine.json`:** its `env` (the profile writes guest environment itself) and
  `start.timeout_seconds` (nothing waits for `start`).
- **CLI exit-code contract:** the codes 255/130/128+n. The CLI exits 0 or 1. With
  `--json` it prints `{error: {message, tag, retryable}}`, and `ssh` exits with
  ssh's code.
- **Host knobs:** `port_lease_root`, `port_min/max`, `dns`, `launchctl_path`,
  `launchd_domain`, `systemctl_path`, `tls_*`, `HostOS`, `ControllerID`, and
  `SystemdUser`/`LaunchdDomain`.
- **Dev extras:** the dev host under launchd/systemd, bundle relocation, sticky
  `--cpus`/`--ram-mib`, per-project state-dir hashing, `--listen`, the teardown
  journal and token, and dev's private controller.
- **Our own Linux base image:** `images/stage-linux.py`, package locks, prepared
  markers, compact-template reproduction and the per-machine 2.1 GiB rootfs copy.
  smolvm bases are stock OCI images.
- **Historical docs, ADRs and qualification records:** a short design section in
  the README replaces them.

## Host

### Journal and concurrency

- One owner lock for the process lifetime, and a `Semaphore(1)` for native
  mutations (raising it is gated by P12).
- **Write `pending = {action}` on the resource row when the mutation is
  accepted,** before the reply and before any native effect. Without that write,
  a host restart could replay the action: a RAM child gets cold-booted twice, or
  `create` adopts a foreign VM.
- **On host startup:** a pending row becomes
  `lastFailure: {action, message: "host restarted during <action>"}`, and nothing
  is replayed. The machine shows whatever the runtime reports, possibly
  `missing`.
- **Native errors:** every native error becomes `lastFailure` with the error's
  message. Nothing is released without an explicit delete, so no failure needs a
  proof that it left nothing behind.
- **Busy rule:** one pending action per resource, so a second mutation is
  `Conflict{kind: busy}`. Delete of a revision, a checkpoint or a fork source
  that is still referenced is `Conflict{kind: references}`, enforced by foreign
  keys and smolvm's own fork-base refusal.
- **Stop and delete after a failure:** they are never refused because of an
  earlier failure, and they cope with leftover native state,
  including a live orphan VM process. They can still be refused while another
  action is pending, or when smolvm refuses deleting a fork base (delete the
  children first). The `smolvm-bin` patch keeps a cold-restarted fork source
  stoppable. Phase 3 verifies all of this per runtime.
- **Completion is recorded even when the caller has gone away.**

### Profiles

- **A profile is a captured machine:**
  1. The operator creates a machine from a base, sets it up over ssh
     (clankerbox-profiles keeps its `setup.sh` and `files/`, run by the
     operator), and stops it.
  2. `profile capture NAME --from MACHINE` records a new revision and points
     `NAME` at it.
  3. Rolling back is `profile use NAME REVISION`.
- **smolvm capture:** `smolvm pack create --from-vm` of the stopped machine. The
  pack is self-contained, keeps uid/gid and modes, and drops all xattrs and file
  capabilities (spike P6). Profiles must not rely on file capabilities.
- **Tart capture:** a clone of the stopped VM.
- **Spec:** a revision records the source machine's spec (`cpu`, `ramMib`, disk
  size, `expose`). Machines created from the profile use it unchanged.
- **Capture copies the whole disk, including anything the machine fetched,**
  such as credentials synced by its `start`. Capture right after setup, before
  the machine has run `start` with credentials, or clean up first. Phase 3
  decides whether capture should refuse a machine whose `/etc/resolv.conf` is a
  symlink (see [smolvm](#runtimes-smolvm)).
- **Bases:** each host lists its bases in config.
  - smolvm: an OCI image reference pinned by digest, for example
    `ubuntu:24.04@sha256:…`.
  - Tart: a prepared operator seed, booted only if it carries the prepared
    marker.

### Preparation

One host-side script, shipped inside the host binary, runs as root over
`Runtime.exec` after every create, start, fork and restore. In order:

1. **Identity.** Compare `/var/lib/clankerbox/machine-id` with the machine's ID.
   On a mismatch:
   - Re-mint the SSH host keys where the runtime didn't: a Tart clone, or a
     machine created from a smolvm pack. smolvm re-mints the keys on disk on RAM
     fork and on restore.
   - Restart sshd if it is running. A RAM child's sshd keeps serving the old key
     until restarted (seen on OpenSSH 10.0).
   - Write the machine ID **last** of these steps, so a crash before it repeats
     them.
2. **Start.** Launch `/etc/clankerbox/start` if it exists, detached, on *every*
   activation. On smolvm this uses `smolvm machine exec --detach` (the agent is
   PID 1 and there is no init); on Tart, the equivalent found in P3.
   - The script must be idempotent: it launches sshd and anything else the
     profile needs, and refreshes per-machine state. For example, clankercreds
     sync must run after a fork or restore.
   - The machine ID is written before `start` runs, because clankercreds reads it.
3. **Host key.** Print the SSH host public key, if there is one. It becomes
   `Machine.hostKey`.

A crashed preparation is simply run again on the next activation; no
`prepared` flag is needed.

### Guest access

- **Expose:** the profile's spec carries `expose: {name: guestPort}`, for example
  `{"ssh": 22}`.
- **smolvm:**
  - A machine with a non-empty `expose` is created with
    `--net --net-backend virtio-net` and `-p hostPort:guestPort` per entry. TSI
    also serves `-p`, but checkpoints with published ports require virtio-net.
  - The VM job's environment sets `SMOLVM_PUBLISH_ADDR` (the host's tailnet
    address; unset in dev, so loopback) and `SMOLVM_EGRESS_FLOOR=strict`
    explicitly.
- **Port allocation:**
  - The host picks host ports from 10000–19999: below smolvm's fork range
    (20000–32000) and the Linux ephemeral range (32768 and up). It excludes the
    ports on its machine rows and confirms each one with a bind probe.
  - Forks get fresh ports from smolvm. Read them back from `machine ls -v` or
    the VM's `agent.config.json`; `machine status --json` reports only a count.
  - A restore keeps the checkpoint's ports. The host allocates new ones and
    applies them with `machine update --remove-port … -p …` before start.
- **Tart:**
  - Tart has no port publishing, and the guest's Softnet address is reachable
    only from the Mac.
  - The host runs a forwarder: for each exposed port of a running machine it
    listens on `publishAddress:hostPort`. Each accepted connection runs
    `tart exec -i <vm> nc 127.0.0.1 <guestPort>`.
  - This needs no guest IP, no Softnet exception and no Local Network
    permission.
  - Opening a connection costs about 560 ms. A host restart drops open Tart
    connections, whereas smolvm's listeners live in the VMM.
- **Security:** anything on the tailnet can reach a published port. sshd's keys
  and the pinned host key are the protection. smolvm's strict floor and Softnet
  keep guests away from private ranges. The guest can still reach the host's
  public address, so production adds a firewall rule (see phase 7).

### Supervision

The smolvm CLI starts the VMM in the caller's cgroup, so without its own job a
host restart would kill every VM. `Supervisor.launch(label, argv, env)` covers
four cases:

- **Linux production (root):** set `SMOLVM_VM_USE_SCOPE=1` on every command that
  launches a VM (`start`, `machine branch`, and a restore's `start`). Each VM
  gets its own `system.slice/smolvm-vm-<name>.scope` and survives its launcher.
  No `systemd-run` and no unit files. A restore under scopes has not been run
  (P1).
- **Linux dev (unprivileged):** `systemd-run --user --collect` with kill
  properties, one per VM. Lingering is required.
- **macOS smolvm (dev):** one launchd plist per VM, or one host job with
  `AbandonProcessGroup` (P10).
- **Tart:** the plist is written once at create. Start runs `launchctl print`,
  then bootstrap if the job is absent, then `kickstart` without `-k`.

Two rules for every VM job:

- It references only smolvm or tart, installed under a directory keyed by
  runtime digest, never the clankerbox binary. A release that doesn't change the
  runtime then leaves running VMs alone.
- Never set `SMOLVM_BOOT_BINARY`: it arms a parent-death watchdog.

### Runtimes: smolvm

- **Inventory:** one smolvm inventory per host, on both OSes. Machine names are
  unique per host, which the scope names need anyway. On Linux,
  `SMOLVM_DATA_DIR` places it. On macOS, smolvm resolves paths from `HOME`, and
  the root must stay short because socket paths are limited to 104 bytes.
- **Machines:** run from a stock OCI image, on smolvm's own 48 MiB agent rootfs
  (about 200 MiB of disk per machine).
  - As root, each VM runs as its own uid (2000000 and up), so guests can't write
    the shared agent rootfs.
  - In unprivileged dev they can; that is accepted.
  - A fork child runs under its source's uid, so an escape from a fork reaches
    its source and siblings. Restores get a fresh uid.
- **Profile rule:** install packages with `--no-install-recommends`, or at least
  never install `systemd-resolved`. It turns `/etc/resolv.conf` into a symlink,
  and every later `machine start` then fails (an upstream bug).
- **Trust smolvm's exit codes:**
  - `machine start` returns after the agent is ready.
  - `stop` returns after the process is dead.
  - `exec` refuses a stopped machine.
  - `delete` removes the record only after death and storage removal.

  So there is no state polling and no inspection around calls. To read one
  machine, use `machine status --name X --json`, never `machine ls`; `ls -v` is
  only for ports.
- **Fork:**
  - The host starts every smolvm machine with `--branchable` (check its cost in
    P1).
  - `machine status --json` reports `branchable: false` even when branching
    works, so don't read it.
  - smolvm refuses deleting a fork base before stopping anything; map that to
    `Conflict{kind: references}`.
- **Stop:** graceful, then a bounded wait, then forced. Upstream `stop` requires
  the guest's ack and hard-kills an unreachable VM or an orphaned VMM.
- **Checkpoints:**
  - **Pin:** `(runtimeDigest, revisionId)`. smolvm enforces sizes, platform, CPU
    contract and network, but not the engine build or the agent.
  - **Capture:** smolvm's capture is atomic. After a crash, the host only removes
    `checkpoints/<id>/`, as hygiene. An interrupted capture is discarded, so
    partial RAM artifacts are never published.
  - **Pending RAM files:** an incomplete pending directory makes `start`
    cold-boot silently. Check it once, on the path from
    `smolvm machine data-dir`.
  - **Root restore:** restores share RAM read-only and use a copy-on-write disk
    top (about 0.7 MiB of private disk, against 213 MiB unprivileged).
  - **Checkpoint delete** also removes smolvm's extracted restore cache. It
    outlives the restores, and it is why a second restore takes 0.08 s.
  - P9 decides between `--store` checkpoints and single files.
- **DNS:** no `DNS` knob. smolvm's gateway relays DNS, and smolvm refuses
  capturing a machine with custom DNS.
- **Disk sizing:** one disk-size field per profile. P8 decides whether this needs
  smolvm's compact templates or host `resize2fs`.

### Runtimes: Tart

- **Softnet:** `--net-softnet-block=@host`. Blocking `@host` also blocks gateway
  DNS, which is why seeds pin public resolvers.
- **Removed:** no `tart ip`, no `HOME=<root>` for tart (test the keychain when
  removing it), and no refusal to replace a live launchd job.
- **Clone:** `tart set --random-serial` once per clone. No `--random-mac`, since
  clone already regenerates a colliding MAC.
- **Trust Tart's clone:** it builds in a temp directory under a lock and
  garbage-collects interrupted clones. Since 2.40.1, clone refuses an existing
  destination: map that to `Conflict{kind: exists}` and never pass
  `--overwrite`.
- **Fork, checkpoint and capture need a stopped machine.** Tart's clone doesn't
  require one, so that rule is ours. Refuse a running machine with
  `Precondition`.
- **Delete:** exit 2 means missing; from 2.40.0 a running VM exits 1. No
  inspections around delete.
- **Stop:** in-guest `shutdown -h now`, then `tart stop --timeout 0` as the
  forced fallback.
- **Capacity:** map Apple's two-VM refusal to `Capacity`. If P11 shows it hangs
  instead of refusing, add a count from `tart list` before launch.
- **Guest agent:** tart-guest-agent ≥ 0.15.0 runs as a root LaunchDaemon in seed
  preparation, so no `sudo -n` relay is needed.

### Other host rules

- **One exec per runtime:** `Runtime.exec(machine, argv, stdio)`.
- **State init:** build in a temp directory, then rename. The owner marker is
  written at init.
- **Runtime manifest:** `{version, platform, runtimeDigest, files}`, with full
  digest verification, so a RAM checkpoint never restores on a different engine.

## CLI and dev

- **`clankerbox ssh MACHINE [ssh args…]`:** looks up the machine's `ssh`
  endpoint and host key, writes a one-line known-hosts file, then execs the
  system `ssh`. Ports change on fork and restore, so typing them by hand isn't
  practical.
- **Shared options:** `--json` and `--timeout`. Every mutation waits by default.
- **Client config:** one file holding the host list and the key path.
- **`clankerbox dev`:**
  - Runs a host in the foreground with an embedded `clankerauth-dev` issuer
    (fixed `dataDir` and port, so keys survive restarts).
  - Publishes on loopback.
  - Writes the client config.
  - The state dir defaults to `~/.clankerbox/dev`, and a short runtime root is
    keyed by its hash.
  - VMs are supervised by their own jobs, so stopping `dev` leaves them running.
- **`dev stop`:** stops every VM and confirms none is running. Everything on disk
  is kept. It is a crash-safe shutdown: the journal handles interrupted work on
  the next start.
- **`dev destroy`:**
  - Runs `dev stop`, then removes the owned roots, but only roots that carry the
    owner marker. Init refuses a non-empty directory without one.
  - Every Tart VM and the smolvm store live under the root, so removing it is
    safe once nothing runs.
  - The "confirm none running" check stays, so disks are never deleted under
    running VMs.

## Release

**Node SEA pipeline:** about 40 lines of shell, validated on 26.10.0:

1. Pin the Node archives by SHASUMS256.
2. Download and verify `bin/node` per target.
3. Bundle to one file.
4. Write the per-target config with `"execArgvExtension": "none"`, so the binary
   ignores `NODE_OPTIONS`.
5. Run `node --build-sea` per target, using the same Node version as the
   builder, with no code cache and no snapshot.
6. Ad-hoc sign darwin with the hardened runtime and `allow-jit`.
7. Smoke-test every role on each target.

Notarization isn't needed for curl/tar/scp installs.

**smolvm:**

- **Upstream as-is:** use the `smolvm-1.22.0-*` release tarballs for
  `agent-rootfs`, libkrun, libkrunfw and the templates. Pin the tarball sha256
  and the extracted file hashes.
- **Rebuild only `smolvm-bin`:** build it from the v1.22.0 source with one
  patch. `has_frozen_fork_state` must use `restart_blocking_dependent_clones`
  (`src/agent/state_probe.rs`).
  - Without the patch, a fork source that is cold-restarted while any child
    exists, even a stopped one, reports `frozen` and refuses `stop` and
    `delete --force` until every child is deleted.
  - On macOS, link against a private copy of `libkrun.dylib`, because smolvm's
    `build.rs` re-signs it. Then ad-hoc sign with upstream's entitlements.
- **Upstreaming:** send the fix upstream separately, and drop the patch when a
  tagged release has it. The overlay `index=off` hunk, the stop-ack hunk and the
  test-only hunk of the old patch are gone (evidence.md has the reasons).
- **Unpacking:** extract with `tar --no-same-owner`, or the files keep the CI's
  uid 1001.

**Notices:**

- The upstream tarballs carry no license files, so every redistribution duty is
  ours: smolvm's license, Rust dependency notices from `cargo metadata`, and
  native notices for libkrun, libkrunfw (GPL-2.0/LGPL-2.1), MoltenVK, epoxy and
  virgl.
- Corresponding source covers libkrunfw b8c9994d plus Linux 6.12.95, and libkrun
  3285db74.
- Add Node's LICENSE and the pnpm dependency notices.
- The old license texts are at `c112847:scripts/release/licenses/`.

**Pins:** one `release-inputs.json` keyed by platform, including the Node SEA
base binaries and the smolvm tarballs.

**CI:** one vite-plus job, plus a SEA build smoke test on both targets.
`publish-sdk` publishes `packages/contract` on release tags.

## Phases

Each phase ends with `vp run ready` green. Live tests run where hardware allows.

0. **Restore and spike.**
   - Restore `AGENTS.md`, `scripts/work_runs.py` and `scripts/WORK_RUNS.md`
     unchanged from `main`. Every live run uses them.
   - Then run spikes P1, P2, P3, P5 and P8. If P1 fails, change guest access to
     the fallback in [Spikes](#spikes) before phase 2.
1. **Scaffold.** The root workspace, catalog, lint and CI. Scaffold the
   `apps/clankerbox` role dispatcher and the SEA build for both targets, with a
   hello world per role.
2. **Contract.** Schemas, the tagged errors, `<host>_<name>` IDs, the action
   groups, and the client library (host list, routing, fan-out with partial
   results, name resolution).
3. **Host.**
   - The journal and the error-reply invariant, lifecycle, the smolvm and Tart
     runtimes, supervision, profiles (capture), checkpoints and preparation.
   - Port allocation, smolvm publishing and the Tart forwarder.
   - The clankerauth resource.
   - `stop` and `delete` on every runtime after an interrupted operation.
   - Spikes P9–P12.

   Unit tests use a fake runtime layer; live tests use real VMs.
4. **CLI and dev.** Commands, `ssh`, and `dev` with clankerauth-dev.
5. **Release and live tests.** `tools/release` (SEA, patched `smolvm-bin`,
   bundle, notices), `tools/tart-seed`, and `tests/live`. Then the README design
   section and the bump skills (seeded from evidence.md).
6. **Cut over.**
   - Run the full live acceptance suite on Apple Silicon (smolvm and Tart) and on
     Linux/amd64 with KVM.
   - Release.
   - Publish the SDK major.
   - Delete these plans in the last commit before the merge.
7. **Redeploy production.** In personal-cloud:
   - Destroy the 0.11.0 machines and checkpoints on both hosts, and the
     controller.
   - Move the hosts onto the tailnet if not already done.
   - Delete the clankerbox WireGuard link, the PKI and the UniFi rule.
   - Run the Linux host as root: system units, and host state out of
     `/home/clanker`. As root, smolvm adds others-execute to every directory
     above its data root.
   - **Change the egress guard before any guest runs:** `meta skuid 1000` becomes
     `meta skuid 2000000-101999999`, smolvm's per-VM uid range. Until then, a
     guest can reach services on the host's public address.
   - Decide `SMOLVM_RESTORE_TMPFS`: root restores leave `/dev/shm/smolvm-restore`
     behind, and `=0` turns it off.
   - Deploy with clankerauth keys covering both hosts.
   - Capture the profiles again (`linux-dev`, `mac-xcode`, `gg-linux-dev`) with
     sshd, `expose` and an idempotent `/etc/clankerbox/start`. Move
     `gg-linux-dev`'s `env` into the guest's environment (P3 checks the paths),
     and update `clankercreds/docs/recipe.md`, which still documents
     `machine.json`.
8. **Clean up the test machines,** following
   [Test machine footprint and final cleanup](#test-machine-footprint-and-final-cleanup).

## Spikes

The ones already done, with numbers, are in evidence.md:

- S3 exec transport, S4 and its 26.10.0 re-run (SEA), S5 (clankerauth 0.11.0)
- the stock-image test (former P6 and P7, and the host-key question)
- the runtime-patch review and the ESTALE and fork-state run on Linux (former P13)
- root mode on Linux (former P4)

### Phase 0

| Spike | Gates |
| --- | --- |
| **P1. Published ports on the tailnet.** On the Linux host as root (ask for approval first): a stock-image machine with `-p` on the tailnet address and `SMOLVM_EGRESS_FLOOR=strict`, then ssh, scp and rsync from another tailnet machine. Also: RAM fork (fresh port read back, key re-minted, sshd restarted), two restores beside a running source with the port swap, both with `SMOLVM_VM_USE_SCOPE=1`, and the cost of always passing `--branchable`. Loopback and `127.0.0.2` already work. | guest access, or its fallback |
| **P2. Tart forwarder.** Listener → `tart exec -i` → guest `nc 127.0.0.1 22`: ssh and rsync throughput, idle survival, and whether accepting on the tailnet interface needs Local Network permission. | guest access on Tart |
| **P3. Preparation.** The script over exec on both runtimes. Does `smolvm machine exec --detach` keep `start` alive, and what is the Tart equivalent (`tart exec` with `nohup`/`setsid`, or `launchctl submit`)? Re-mint on pack-created and Tart-cloned machines. How do ssh sessions and detached processes pick up the profile's environment (`/etc/environment` through PAM)? | preparation |
| **P5. Pins.** Re-run S5 on clankerauth-sdk 0.12.0, and smoke-test effect-actions 0.9.0 on Effect 4.0.0 inside a SEA. | phase 1 |
| **P8. Disk sizing.** Which disk holds workload writes for a stock-image machine? Do sizes above or below smolvm's 20/10 GiB templates need host `resize2fs` (missing on macOS)? Can profiles drop the overlay size and the compact templates? | profiles, release |

**Fallback if P1 fails:** no published ports. `clankerbox pipe MACHINE PORT`
carries bytes over `Runtime.exec` into the guest's `nc`, used as an ssh
`ProxyCommand`. clankerbox then sits in the data path, which needs a streaming
call next to the unary ones. smolvm's `--expose-socket` is the other fallback.

### Phase 3

| Spike | Gates |
| --- | --- |
| P9. smolvm `--store` checkpoints versus single files: the restore cache, `checkpoint-warm` and dedupe apply only to store checkpoints. Measure both. | checkpoints |
| P10. macOS smolvm: one host launchd job with `AbandonProcessGroup` versus one plist per VM. | dev supervision |
| P11. Tart third VM: a fast refusal, or a hang until timeout. | Tart capacity |
| P12. Concurrent smolvm CLI calls against one inventory. | the native-call semaphore |

## Test machine footprint and final cleanup

Everything the rewrite creates on a test machine is removed when the work ends.

- **Machines:**
  - this Apple Silicon Mac: smolvm on macOS, and Tart;
  - `ssh clanker@37.27.63.112`: Linux/amd64 with KVM. This is the production
    personal-cloud Linux host. `clankerbox-host.service` (user unit) runs there
    and is never touched. Each root-mode run (`sudo`, system units, uids outside
    the owned root) needs the user's approval first. P4 was approved and has run.
- **One owned root per machine:**
  - Linux: `~/clankerbox-rewrite/`. Never touch `~/clankerbox`, its service, its
    VMs or its smolvm state, and never restart `user@1000`.
  - Mac: this worktree's `.work/`. `/.work/` is excluded in the repository's
    `info/exclude` while the tree has no `.gitignore`.
- **Resource naming:** every native resource carries a `clankerbox-rewrite`
  prefix and is recorded in its run's evidence. A run's teardown stops its
  resources before scratch is deleted.
- **Resources that aren't ours:** smolvm processes from other bundles may run on
  the Mac. Never stop them.
- **Ledger:** `~/clankerbox-rewrite/CLEANUP.md` records every change outside the
  owned root. So far:
  - `clanker` added to the `kvm` group, 2026-09-30, still in place;
  - S3 entries;
  - four P4 entries, all reverted (directory modes, transient units,
    `/dev/shm/smolvm-restore`, processes).
- **Seeds:**
  - Reusable VM seeds go into the main checkout's `.work/inputs`, with provenance
    and a ready marker, and are always used through private clones. They are not
    ours to delete.
  - The `smolvm-1.19.0-images` seed carries a patched 1.19 agent and is not used
    with 1.22.
- **Retained now:**
  - Linux: about 2.1 MiB of run evidence.
  - Mac: `.work/runs/*` evidence, and `.work/spike-evidence/` (the S1 and S3 raw
    outputs).
- **Final cleanup, the last step of the whole effort:**
  1. Stop every recorded process, unit, job and VM.
  2. Confirm none remain, by name prefix and by the recorded IDs.
  3. Delete both owned roots and any seed clones.
  4. Walk the ledger with the user.
  5. Report what was removed, and anything deliberately kept, with size and reason.

## Validation

- `vp check`, `vp run -r test` and `vp run -r build` on every change.
- SEA smoke tests on each target: every role starts and `--help` works.
- Live acceptance, which must cover:
  - create/start/stop/delete;
  - RAM fork, and checkpoint capture, restore and delete;
  - profile capture, then create from it, and `profile use` back to an older
    revision;
  - `clankerbox ssh` into a machine on each runtime with the pinned host key, and
    scp and rsync of a binary file compared by hash;
  - a fork and two restores of one checkpoint: each gets its own port and host
    key, and ssh works into all of them while the source runs;
  - `start` running after every activation, and the machine-ID file updated on
    fork and restore;
  - a cold-restarted fork source with a stopped child staying stoppable (the
    `smolvm-bin` patch);
  - a host restart keeping VMs, smolvm's published ports and the machine-ID
    file, and Tart endpoints coming back after the forwarder restarts;
  - `stop` and `delete` after an interrupted operation;
  - a duplicate name refused with `Conflict{exists}`, and a lost-reply retry
    resolved by reading the resource;
  - list fan-out with one host down;
  - `dev stop` keeping disks and checkpoints, and `dev destroy` removing them;
  - `--json` error tags.
- Every live run goes through `scripts/work_runs.py`, following AGENTS.md.
