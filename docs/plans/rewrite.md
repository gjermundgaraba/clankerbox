# TypeScript/Effect rewrite: plan

Status: planned. Every design decision below is closed. The phase-0 spikes still
gate details of guest access, setup, preparation and disk sizing, and P14 gates
details of the boat runtime. The evidence behind the decisions is in
[evidence.md](evidence.md). Both files are deleted in the last commit before the
merge.

clankerbox is rewritten from scratch in TypeScript on Effect 4, as a clean break.
No persisted state is migrated. Production is destroyed and redeployed at
cut-over, and there is never a release where both implementations ship.

The Go implementation is deleted from this branch (`4898a3e`). Read it at `main`
(`c112847`) or at `88969a9`, and don't restore it. evidence.md cites it as
`G:path:line` at `c112847`.

**What clankerbox is after the rewrite:**

- It runs machines and reports where each one is reachable. Lifecycle covers
  create, start, stop, delete, RAM fork, checkpoints and restore.
- A client asks for a machine by profile or by requirements, and the client
  library picks a host that satisfies them. Hosts are configuration, not a
  choice made per command.
- A profile is a client-side file: a base, sizes, exposed ports, label
  requirements and a setup script. Hosts store no profiles.
- A small preparation contract runs over each runtime's own exec.
- Each port a machine exposes is reported as a `host:port`, together with the
  guest's SSH host key.
- Clients talk to hosts directly; there is no controller.
- Anything done *inside* a guest (shells, terminals, file copy) goes through
  software that setup installs, normally sshd.

## Settled decisions

| Area | Decision |
| --- | --- |
| Scope | The `clankerbox` binary (CLI and host), the SDK with its client library, release tooling and live tests. There is no controller and no guest daemon. |
| Runtime | Node 26.10.0 (the latest patch at each release), shipped as Node SEA single-executable binaries. |
| Effect | `effect` and `@effect/platform-node` **4.0.0**, the first stable release, published 2026-10-01. Before using `effect/http` and `effect/cli` (top-level modules in rc.118), check where they live at 4.0.0. |
| Contract | [effect-actions](https://github.com/gjermundgaraba/effect-actions) **0.9.0** for every call. All calls are unary HTTP, and a mutation replies when its action has finished. Input is closed: undeclared fields are refused. |
| SDK | `packages/contract` (Schemas, action groups, errors, the profile file schema and the client library) is published as the next major of `@gjermundgaraba/clankerbox-sdk`, versioned with the binaries. `effect` is a peer dependency, `^4.0.0`, so a consumer has a single copy and Schema identity holds. There is no separate `sdk-v*` tag and no pairing table. |
| Auth | clankerauth **0.12.0** offline API keys and JWTs on the host API, through `@gjermundgaraba/clankerauth-sdk` and `Resource.make`. Each host is one resource, and one client key can carry grants on several hosts. At 0.11.1 the behaviour was: an unknown key triggers a key-list read (at most one per 5 s), revocation takes about a minute, and the last list stays valid for 24 hours during an issuer outage. Re-check this at 0.12.0 (P5). Tests use the SDK's `/testing` fake issuer, and dev mode uses `clankerauth-dev`. |
| Network | Hosts and clients share the operator's Tailscale tailnet (personal-cloud work, outside this plan). No hop of ours uses TLS: the tailnet encrypts and authenticates, and clankerauth authorizes each request. A tailnet ACL should limit who can reach the host API port. A boat host calls boat's API over HTTPS, and boat machines' SSH endpoints are public addresses (see [Runtimes: boat](#runtimes-boat)). |
| State | SQLite through `node:sqlite`, on each host. The schema is versioned with `PRAGMA user_version` and an ordered list of migrations, starting at version 1. There is no client-side state beyond configuration and profile files. |
| Placement | The client library places `create`: it reads every host's labels and bases, keeps the hosts that match the request, and tries them in the order of its host list. Every other call routes by ID. |
| Profiles | Client-side files, never stored on a host. A machine is created from a base image the host names (a stock image, or boat's own), and the profile's setup script runs once, at create. |
| Production | personal-cloud runs 0.11.0 with a Linux smolvm host (Hetzner) and a Mac Tart host. At cut-over, every 0.11.0 machine and checkpoint is destroyed, the new release is deployed with a boat host added, and the profiles are rewritten as profile files. |
| Hosts | A smolvm host always runs as root, in production, dev and CI. smolvm runs only on Linux hosts and Tart only on macOS hosts. A boat host runs unprivileged on either. |
| Runtimes | smolvm and Tart are host prerequisites that the operator installs. The release ships neither. boat is a cloud service: a boat host needs only a boat API key on a paid plan. |
| MCP | None. |
| Tooling | vite-plus 1.0.0 (`vp`), pnpm 12, TypeScript 7.0.2, laid out like `/private/tmp/monorepo-example`. The lint setup (typeAware, typeCheck, the anti-slop plugin) mirrors clankerauth. Live runs use `scripts/work_runs.py`. |
| Dependency floors | smolvm exactly 1.22.2, upstream and unmodified (see [Runtimes: smolvm](#runtimes-smolvm)), Tart ≥ 2.40.1, tart-guest-agent ≥ 0.15.0, Softnet 0.24.0 (macOS 26 hosts), boat API v1, Node 26.10.0, clankerauth-sdk 0.12.0. |

## The design rule

Before building any mechanism that wraps a dependency, answer five questions,
and answer them again at every bump of that dependency:

1. **Duplicated bookkeeping.** Does the dependency already track this? Example:
   smolvm stamps a format version into every pack, so `disk` checkpoints need
   no pin of ours.
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
  - `create` is placed (see Placement under [API contract](#api-contract)).
    Every other call names an ID, and the client library routes it by the ID's
    host part, so routing never needs the network.
  - Lists fan out to every host. They return what reachable hosts answered and
    name the unreachable ones, rather than failing whole.
  - There is no name lookup.
- **Host:** owns everything durable for its machines: machines, checkpoints and
  port allocations. Machine state (`running`, `stopped`, `missing`) is always
  read from the runtime, never stored. A machine and its checkpoints stay on
  the host that created them; nothing moves between hosts.
- **Runtimes:**
  - smolvm: Linux guests on Linux hosts, with RAM forks and `ram` and `disk`
    checkpoints, through its CLI.
  - Tart: macOS guests on macOS hosts, with disk copies, through its CLI.
  - boat: Linux guests in boat.dev's cloud, with disk forks and checkpoints,
    through its HTTP API.

  Each is one module behind a shared `Runtime` interface. The journal, setup
  and preparation are shared. Port allocation, the forwarder and supervision
  are helpers that a runtime calls when it needs them. The host records the
  endpoints its runtime reports. Fork, checkpoint and access stay
  runtime-specific.
- **One runtime per host process.** Two runtimes on one machine are two host
  processes, each with its own host ID, so the host never picks a runtime per
  machine. Host config names the runtime (`smolvm`, `tart` or `boat`), since a
  boat host can run on either OS. A new provider is a new runtime module behind
  its own host, plus a placement label.
- **Guest contract:** setup and preparation over the runtime's exec. No
  clankerbox binary runs in a guest.
- **Guest access:** each machine declares the guest ports it exposes. Each one
  is published, by the runtime itself or through the host's forwarder, and
  reported as `host:port`, together with the SSH host key.
- **Rewind:** not built. smolvm can restore a machine as itself
  (`create --from … --keep-identity`) and, with store history, at an earlier
  generation (`--at '~N'`). Add it only when a consumer needs it.

## Target layout

```
package.json            # vp scripts: ready = check + test + build
pnpm-workspace.yaml     # apps/*, packages/*, tools/*; catalog pins below
vite.config.ts          # lint/fmt/staged/run.cache, as in clankerauth
tsconfig.json
apps/
  clankerbox/           # the only binary: `clankerbox <cli…> | host`; the CLI commands, `ssh` and `dev` live here
packages/
  contract/             # Schemas, action groups (machine, checkpoint, host), errors, the profile file schema, client library (host list, routing, fan-out, placement)
  host/                 # journal, claims, lifecycle, runtimes (smolvm, tart, boat), supervisor, setup, preparation, checkpoints, ports, forwarder, state dir and sqlite
tools/
  release/              # SEA build and signing, bundle, notices
  oxlint/               # anti-slop plugin, installed from upstream by the install-anti-slop skill
scripts/work_runs.py    # with WORK_RUNS.md
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

- Every machine and checkpoint has an ID of the form `<host>_<name>`.
  - The client chooses the name. Names are unique per host and per resource
    type. Two hosts can each hold a machine with the same name; their IDs tell
    them apart.
  - Host IDs must not contain `_`, and the ID splits at the first `_`. Short
    host IDs (`linux`, `mac`) keep IDs short to type.
  - The whole ID must match `^[A-Za-z0-9_-]{1,62}$`.
  - A name must start with a letter.
  - The host passes the name, not the ID, to smolvm and to systemd scope names,
    and a kind-prefixed name to Tart (see [Runtimes: Tart](#runtimes-tart)).
    Phase 2 checks that their name rules accept this grammar. boat assigns its
    own IDs (see [Runtimes: boat](#runtimes-boat)).
- The separator is `_` and the 62-character limit apply because the ID is
  written to `/var/lib/clankerbox/machine-id`. clankercreds uses it as the
  machine's audit-log label, accepts only that pattern, and on a mismatch
  silently falls back to a label that forks would share.
- Bases have names, not IDs. Each host names its bases in config, and hosts that
  offer the same image use the same name.
- Every command takes IDs, except `create NAME`, which takes only the name:
  placement picks the host, and the reply carries the new ID.

**No idempotency keys, no operations resource**

- `create`, `fork`, `restore` and checkpoint `capture` take the new resource's
  name. If that name already exists on the host, the call fails with
  `Conflict{kind: "exists"}`. A client retrying after a lost reply reads the
  resource by ID and decides for itself whether it is its own; for `create`,
  the error names the ID that was attempted.
- `start` on a running machine and `stop` on a stopped one succeed without doing
  anything, except that `start` on a running machine runs preparation again (the
  repair path, see [Setup and preparation](#setup-and-preparation)). `delete` of
  a missing resource is `NotFound`, which clients treat as done.

**Placement**

- Only `create` is placed. Fork, restore, start, stop and delete go to the host
  of the machine or checkpoint they name: RAM state doesn't move, and nothing
  migrates.
- A create request carries a base name, `cpu`, `ramMib`, `diskGib`, `expose`,
  an optional setup script, and two label lists, `require` and `avoid`. A
  profile file fills these in (see [Profiles and bases](#profiles-and-bases)).
- The client library:
  1. Reads every host, in parallel. A host that doesn't answer is skipped and
     named in any error.
  2. Keeps the hosts that offer the base, carry every `require` label and carry
     no `avoid` label.
  3. Tries `create` on them in the order of its host list.
  4. Moves to the next host only on `Capacity`, which writes nothing. Any other
     error stops placement and is the reply. That includes a lost reply, after
     which the machine may exist on that host.
- With no matching host, the reply is `Unavailable` if a host didn't answer,
  and otherwise `Precondition`, listing each host's reason. When every match
  refuses, the reply is `Capacity`.
- **Labels:** a host's labels are derived from its runtime (`os:linux` or
  `os:macos`, `arch:amd64` or `arch:arm64`, `runtime:smolvm`, `runtime:tart` or
  `runtime:boat`, and `ram-fork` on smolvm), plus any the operator sets in host
  config, such as `local` or `cloud`. There is no scoring; the host list's order
  is the preference.

**Synchronous mutations**

- A mutation replies when its action has finished: with the resource as it is
  afterwards, or with a tagged error. Native refusals such as `Capacity` are
  ordinary replies.
- The action runs in a fiber forked into a scope that lives as long as the host
  (a `FiberSet` in the host layer), not into the request's scope. A dropped
  connection never interrupts native work, and the outcome is recorded on the
  row either way.
- The CLI's `--timeout` only stops waiting. On timeout the CLI reports that the
  action is still running and exits 1. After a lost reply, a client reads the
  resource.
- Every action runs in this order (see [Journal and claims](#journal-and-claims)):
  1. Validate the input.
  2. Claim the rows in one transaction, inserting the new row.
  3. Check runtime state, for example that a Tart source is stopped, that Tart
     has room for another VM, or that a boat machine type fits.
  4. Only then call the runtime.

  A failure in steps 1–3 releases the claims, removes the inserted row and
  replies with the error. **Invariant: an error before the first runtime call
  writes nothing.** A failure from step 4 on leaves the row with
  `action.status = failed` and replies with the same tagged error; `delete`
  cleans up. Phase 3 proves both for every mutation.

  One exception: a `Capacity` refusal that the runtime guarantees left nothing
  native (boat's capacity refusals, see [Runtimes: boat](#runtimes-boat)) is
  handled like a failure in steps 1–3, so placement can move on.
- **Long calls:** Node's HTTP server ends a request after `requestTimeout`
  (300 s by default), and the undici client behind `fetch` has its own header
  and body timeouts (check their values at 26.10.0). A `pack create` of a large
  disk or a profile's setup can take longer, so phase 2 turns these off for
  mutation calls on both sides, and P5 checks that effect-actions adds no
  timeout of its own.

**Resources**

- **Machine:**
  - `id`, `runtime`
  - `base`, and `profile?`: a label the client supplied at create
  - `cpu`, `ramMib`, `diskGib`
  - `state`, read from the runtime: `running | stopped | missing`
  - `action?`
  - `endpoints: [{name, host, port}]`
  - `hostKey?`
- **Checkpoint:** `id`, `machine`, `kind` (`ram | disk`), the source machine's
  `base`, `profile?`, `cpu`, `ramMib`, `diskGib` and `expose`, and `action?`. A
  restore creates a machine with that spec on the checkpoint's host.
- **Host:** `id`, `runtime`, the clankerbox and runtime versions (for boat, the
  API version), its `labels` and its base names.
- No resource repeats its name or host: both are parts of the ID, and the client
  library splits it.
- **`action?: {name, status: "running" | "failed", error?: {tag, message}}`** is
  the one field for work on a resource. It is `running` while an action holds
  the row, `failed` with the error after a native failure, and absent after a
  success. The next action overwrites it. A checkpoint is ready once it has no
  action.

**Errors:** seven tagged errors:

- `Invalid`
- `NotFound`
- `Conflict{kind}`, where `kind` is `exists` or `busy`
- `Precondition`
- `Capacity` (the host has no room: on Tart, Apple's two-VM limit; on boat,
  the account's limits, no ready machine, or no machine type that fits)
- `Unavailable` (the client couldn't reach the host; it may retry)
- `Internal`

`retryable` is derived from the tag, and for `Conflict` from its kind: `busy` is
retryable and `exists` is not. HTTP 401/403 carry authentication failures.

## Feature scope

Rule: a feature with no real consumer is deleted. The real consumers are the
operator's CLI, the SDK's API clients, the production personal-cloud deployment,
the `clankerbox-profiles` repository, clankercreds, and cliamp-verify (an agent
skill that drives the CLI against the `cliamp-dev` profile). A feature used only
by tests, docs or harnesses doesn't count.

**Kept:**

| Area | Features |
| --- | --- |
| Lifecycle | create (placed; from a profile file, or from a base with `cpu`, `ramMib`, `diskGib`, `expose` and an optional setup script), start, stop, delete, RAM fork (smolvm), stopped-disk fork (Tart) and disk fork (boat), checkpoint capture (`ram` or `disk`)/get/list/delete, restore |
| Runtimes | smolvm (Linux guests, on Linux hosts), Tart (macOS guests, on macOS hosts) and boat (Linux guests in boat.dev's cloud), all three in production |
| Placement | `require` and `avoid` label lists, host labels derived from the runtime or set in host config, and the host list's order as preference |
| Profiles | client-side files: base, sizes, `expose`, label lists, and a setup script with its timeout |
| Setup and preparation | setup once at create; `/var/lib/clankerbox/machine-id` (clankercreds reads it), and `/etc/clankerbox/start` run after every activation |
| Access | per machine, one endpoint `{name, host, port}` per exposed guest port, and the guest's SSH host public key |
| CLI | `hosts` (with their labels and bases), `machines`, `create NAME (--profile P \| --base NAME --cpu N --ram-mib N --disk-gib N [--expose name=port]… [--setup FILE --setup-timeout SECONDS]) [--require LABEL]… [--avoid LABEL]…`, `start`, `stop`, `delete`, `fork`, `checkpoint capture/list/get/delete`, `restore`, `ssh MACHINE [ssh args…]`; `--json`, `--timeout` |
| Dev | `dev` and `dev destroy`, both with `--state-dir`, on Linux as root |

**Not carried over from the Go implementation** (read at `main`, so these are
listed to keep them from being ported):

- **The controller:** its database, admission queue, resubmit loop,
  reservations, observation cache, generation fence, tombstones and profile
  catalog.
- **Idempotency keys:** fingerprints, operations and the `operation` command.
  Also `--async`, `--idempotency-key`, the `uncertain` outcome and its replay
  rules. Mutations reply with their outcome instead.
- **Profile builds and captures:** recipe uploads, builder and validation VMs,
  the build worker, build logs, cancel and the one-hour deadline, `profile
  init`, `profile revisions`, `publish --build-id`, and captured profile
  artifacts on hosts. Profiles are client-side files, and their setup runs at
  create.
- **Capacity accounting and its config:** Tart's two-VM limit and boat's
  machine types are the only checks, and there is no admission count. boat
  enforces its account limits itself. Machine scopes limit each VM to its own
  RAM.
- **Guest-side machinery:** the guest daemon, sessions, `shell`, `sessions` and
  `guest`. Also the expected-machine-ID check on every connect, and every
  guest-side credential (host CA, per-epoch certificates, bindings).
- **TLS and the old auth:** TLS on any hop, PKI, the static bearer token, client
  certificates and Unix peer-credential checks.
- **Machine and checkpoint fields nobody reads:** `generation`,
  `accepted_generation`, `desired_state`, `prepared`, `observed_at`,
  `created_at`, `source_machine_id`, `runtime_pin` and duplicated host and
  profile fields.
- **`machine.json`:** its `env` (setup writes the guest's environment) and
  `start.timeout_seconds` (preparation's own timeout replaces it).
- **CLI exit-code contract:** the codes 255/130/128+n. The CLI exits 0 or 1. With
  `--json` it prints `{error: {message, tag, retryable}}`, and `ssh` exits with
  ssh's code.
- **Name lookup:** the CLI takes IDs, so there is no resolution by fan-out.
- **Host knobs:** `port_lease_root`, `port_min/max`, `dns`, `launchctl_path`,
  `launchd_domain`, `systemctl_path`, `tls_*`, `HostOS`, `ControllerID`, and
  `SystemdUser`/`LaunchdDomain`.
- **Unprivileged and macOS smolvm:** `systemd-run --user` jobs and lingering,
  launchd jobs per smolvm VM, home-directory smolvm paths and their socket-length
  limit.
- **Dev extras:** the dev host under launchd/systemd, bundle relocation, sticky
  `--cpus`/`--ram-mib`, per-project state-dir hashing, `--listen`, the teardown
  journal and token, dev's private controller, `dev stop`, the owner marker file
  and the hashed runtime root.
- **Shipping the runtimes:** the smolvm bundle, the runtime manifest and digest
  directories, the runtime patch, and every notice and corresponding-source duty
  for smolvm and its native libraries.
- **The Linux base image pipeline:** `images/stage-linux.py`, package locks,
  prepared markers, compact-template reproduction and the per-machine 2.1 GiB
  rootfs copy. Bases are stock images.
- **Tart seed preparation:** `images/finalize-mac.sh` and its prepared marker.
  Tart bases are stock Cirrus images.
- **Historical docs, ADRs and qualification records:** a short design section in
  the README replaces them.

## Host

### Journal and claims

- One owner lock for the process lifetime: a second host process on the same
  state dir refuses to start.
- **Claims:** an action claims every row it changes in one SQLite transaction.
  It inserts the new row and, for fork and checkpoint capture, claims the source
  machine. A claimed row has `action.status = running`. If any of them is
  already running, the call fails with `Conflict{kind: busy}` and nothing is
  written.
  - Ready checkpoints never change, so actions that only read them don't claim
    them. Restores of one checkpoint run in parallel. Deleting a checkpoint
    while a restore reads it makes that restore fail like any other native
    error.
  - Runtime state checks run after the claim, so nothing changes between the
    check and the use.
  - Ports are recorded in the same transaction (see [Guest access](#guest-access)).
- **No global native lock.** smolvm and Tart take their own locks. P12 checks
  whether smolvm CLI calls on different machines need serializing; if they do, a
  semaphore covers those calls only.
- **The row comes before any native effect,** so that after a crash `delete` has
  something to own. Nothing is ever replayed: a replay could cold-boot a RAM
  child twice, or make `create` adopt a foreign VM. The one repeated call is
  boat's create or fork inside `delete`, made safe by boat's idempotency key
  (see [Runtimes: boat](#runtimes-boat)).
- **Native IDs:** machine and checkpoint rows have one `native` column that the
  runtime owns. boat keeps its sandbox ID or snapshot name there. smolvm and
  Tart derive native names from the name and leave it empty.
- **On host startup:** every `running` action becomes `failed` with "host
  restarted during <name>". The machine shows whatever the runtime reports,
  possibly `missing`. The smolvm forks area is wiped (see
  [Runtimes: smolvm](#runtimes-smolvm)).
- **Native errors** leave `action.status = failed`, and the same tagged error is
  the call's reply. Nothing is released without an explicit delete, so no
  failure needs a proof that it left nothing behind.
- **No lineage:** a fork is an independent machine, so a source can be stopped
  or deleted while its forks run.
- **Stop and delete after a failure:** they are never refused because of an
  earlier failure, and they cope with leftover native state, including a live
  orphan VM process. They are refused only while another action holds the row.
  Phase 3 verifies this per runtime.
- **Completion is recorded even when the caller has gone away.**
- **Schema:** `PRAGMA user_version` and an ordered list of migrations, starting
  at version 1. A database newer than the binary is refused.

### Profiles and bases

- **A profile is a client-side file,** decoded with the Schema in
  `packages/contract`:
  - `base`: a base name;
  - `cpu`, `ramMib`, `diskGib`, and `expose` (`{name: guestPort}`, for example
    `{"ssh": 22}`);
  - `require` and `avoid`: label lists for placement;
  - `setup`: a script, and `setupTimeoutSeconds`, required with it. The profile
    author sets the timeout and records its reason; there is no default.
- **Hosts never see a profile.** The client library turns it into a create
  request, and the machine keeps only the name the client passes as its
  `profile` label. Editing a profile affects only machines created afterwards.
- **Setup is one script.** In the CLI, `setup` is a path relative to the profile
  file, and the CLI sends the script's text; SDK clients pass the text. A script
  that needs files embeds them or fetches them over the guest's network.
- **Fast creation is the client's business.** Setup runs on every create. A
  client that creates often captures a checkpoint of a set-up machine and
  restores it, and falls back to the profile when the checkpoint is gone or
  refused. The profile is the durable recipe; checkpoints are a cache.
- **A checkpoint holds everything the machine had,** including credentials its
  `start` synced. Capture a checkpoint meant for other machines from one that
  holds none, or clean up first.
- **Bases:** each host names its bases in config, mapping a name to an image,
  digest-pinned where the runtime allows. Hosts that offer the same image use
  the same name, and placement matches on it.
  - smolvm: a stock OCI image, for example `ubuntu:24.04@sha256:…`. It has no
    sshd; setup installs it.
  - Tart: a stock Cirrus image, `ghcr.io/cirruslabs/macos-<version>-base` or
    `macos-<version>-xcode:N` (with Xcode), pinned by digest. Both ship sshd
    and tart-guest-agent.
  - boat: boat's one image (Ubuntu 24.04, x86_64, with sshd, Docker and
    coding agents), which boat updates, so it can't be pinned. A boat host
    names it apart from stock images. Sharing a name with a stock image is the
    operator's call, and works only if the profile's setup handles both.

### Setup and preparation

Both are host-side scripts run over `Runtime.exec`, which runs as root in the
guest (see [Other host rules](#other-host-rules)), as part of the action.

**Setup** runs once, at create, after the first boot and before preparation:

- It runs the create request's script with its timeout. A non-zero exit, or
  running past the timeout, fails the create, and the error carries the
  script's last lines of output. The machine stays, with
  `action.status = failed`, until `delete`.
- Nothing runs setup again: `start` doesn't, and machines from fork or restore
  carry its results.
- A typical setup installs sshd and the operator's public key, sets the guest's
  environment, and writes `/etc/clankerbox/start`.

**Preparation** is one script, shipped inside the host binary, run after every
create, start, fork and restore. In order:

1. **Identity.** Each machine row gets a random `instance` value when it is
   inserted. Compare `/var/lib/clankerbox/instance` with it. On a mismatch:
   - Re-mint the SSH host keys, if the guest has any, on every runtime. A Tart
     clone, a machine restored from a `disk` checkpoint (a pack keeps the
     source's keys) and a machine created from a base (keys from the image or
     from setup) need it. smolvm already re-mints on a `ram` restore, and so on
     a fork; doing it again there keeps preparation free of runtime cases and
     of a smolvm behaviour that every bump would have to re-check. P3 measures
     what it adds to a fork. On boat every activation is a new machine with
     new keys, so re-minting there is redundant but harmless.
   - Restart sshd if it is running. A sshd carried over in RAM can keep serving
     the old key until restarted (seen on OpenSSH 10.0).
   - Write `/var/lib/clankerbox/machine-id` (the ID), then the instance value
     **last**, so a crash before it repeats these steps.
   - The instance, not the ID, is compared because names are reused: deleting
     `a` and restoring a checkpoint of `a` as `a` must still re-mint and
     restart sshd.
2. **Start.** Run `/etc/clankerbox/start`, if it exists, on *every* activation,
   with plain exec (not `--detach`), and wait for it.
   - The contract: it is idempotent, it daemonizes whatever it launches (sshd
     daemonizes itself; anything else uses `setsid -f`, or launchd on macOS),
     and exiting 0 means the machine's services are up. It launches sshd and
     anything else the machine needs, and refreshes per-machine state. For
     example, clankercreds sync must run after a fork or restore.
   - A non-zero exit, or running past the timeout, fails the action, and the
     error carries the script's last lines of output. P3's measurements set the
     timeout and its recorded reason.
   - The claim on the machine means two runs never overlap.
   - Check for sshd's listener (`/run/sshd.pid`), not `pgrep -x sshd`: an open
     ssh session also matches `pgrep`, so a dead listener would never be
     relaunched.
   - `start` on a running machine runs preparation again. That is the repair
     path: it relaunches a dead sshd without a cold boot, which would lose the
     guest's RAM state. Re-running it takes about 50 ms.
   - The machine ID is written before `start` runs, because clankercreds reads it.
3. **Host key.** Print the SSH host public key, if there is one. It becomes
   `Machine.hostKey`.

A crashed preparation is simply run again on the next activation; no
`prepared` flag is needed.

### Guest access

- **Expose:** each machine has `expose: {name: guestPort}`, from its profile or
  given at create.
- **smolvm:**
  - Every machine is created with `--net --net-backend virtio-net`, plus
    `-p hostPort:guestPort` per `expose` entry. `-p` alone doesn't turn on
    outbound access, and setup needs the network. TSI also serves `-p`, but
    checkpoints with published ports require virtio-net.
  - The VM job's environment sets `SMOLVM_PUBLISH_ADDR` (the host's tailnet
    address; unset in dev, so loopback) and `SMOLVM_EGRESS_FLOOR=strict`
    explicitly.
- **Port allocation:**
  - The host picks host ports from 10000–19999: below smolvm's fork range
    (20000–32000) and the Linux ephemeral range (32768 and up). smolvm and Tart
    hosts take 10000–17999 and boat hosts 18000–19999, so a boat host can share
    a machine with either. It excludes the ports on its machine rows and
    confirms each one with a bind probe.
  - Ports are recorded with the action's claim under a unique index, so two
    actions can't take the same port; a collision just picks again.
  - A `ram` restore, and so a fork, keeps the checkpoint's ports: smolvm refuses
    topology flags when creating from a live checkpoint. The host allocates new
    ones and applies them with `machine update --remove-port … -p …` before
    start. To read ports back, use `machine ls -v` or the VM's
    `agent.config.json`; `machine status --json` reports only a count.
  - A `disk` restore takes `--net` and fresh `-p` flags at create, like a
    machine created from a base.
- **Tart:**
  - Tart has no port publishing, and the guest's Softnet address is reachable
    only from the Mac.
  - The host runs a forwarder: for each exposed port of a running machine it
    listens on `publishAddress:hostPort`. Each accepted connection runs
    `tart exec -i <vm> nc 127.0.0.1 <guestPort>`.
  - This needs no guest IP, no Softnet exception and no Local Network
    permission. A host that dials guest IPs needs a fresh Local Network grant
    for every new build, which would mean a manual step after every release.
  - Opening a connection costs about 560 ms. A host restart drops open Tart
    connections, whereas smolvm's listeners live in the VMM.
- **boat:**
  - Guest port 22 is reached at boat's SSH relay (see
    [Runtimes: boat](#runtimes-boat)), with no host port.
  - Every other exposed port goes through the same forwarder. Each accepted
    connection runs `ssh -W 127.0.0.1:<guestPort>` through the relay, with the
    host's key and the pinned host key. P14 measures what opening one costs.
- **Security:** anything on the tailnet can reach a published port. sshd's keys
  and the pinned host key are the protection. smolvm's strict floor and Softnet
  keep guests away from private ranges. The guest can still reach the host's
  public address, so production adds a firewall rule (see phase 7). A boat
  machine's SSH relay is a public address, protected the same way, and boat
  guests have full outbound internet.

### Supervision

The smolvm CLI starts the VMM in the caller's cgroup, so without its own job a
host restart would kill every VM. boat runs its own machines and needs no
supervision. `Supervisor.launch(label, argv, env)` covers the other two
runtimes:

- **smolvm (Linux, root):** set `SMOLVM_VM_USE_SCOPE=1` on every `start`,
  including a restored machine's first start. Each VM gets its own
  `system.slice/smolvm-vm-<name>.scope` and survives its launcher. No
  `systemd-run` and no unit files. Verified for plain starts and restores. P13
  checks the same on a GitHub-hosted runner; if scopes don't work there, dev in
  CI runs without them, and its VMs are then not supervised (they are detached
  children in `dev`'s cgroup).
- **Tart:** the plist is written once at create. Start runs `launchctl print`,
  then bootstrap if the job is absent, then `kickstart` without `-k`.

Two rules for every VM job:

- It references only smolvm or tart at their versioned install paths, never the
  clankerbox binary. A clankerbox release leaves running VMs alone, and a smolvm
  upgrade goes into a new prefix.
- Never set `SMOLVM_BOOT_BINARY`: it arms a parent-death watchdog.

### Runtimes: smolvm

- **Install:** the operator installs upstream smolvm with its own installer, at
  the pinned version, into a versioned prefix:
  `install.sh --version 1.22.2 --prefix /opt/smolvm/1.22.2`. Host config points
  at that prefix.
  - At startup the host compares `smolvm --version` with the version this
    release was tested on, and refuses to start on a mismatch.
  - smolvm looks for its templates in `~/.smolvm/` first, so a stale
    `/root/.smolvm` would shadow the prefix's. P8 checks this, and that the
    upstream wrapper finds its libraries from a prefix install.
- **Inventory:** one smolvm inventory per host, placed by `SMOLVM_DATA_DIR`.
  Machine names are unique per host, which the scope names need anyway. Socket
  paths are limited to 108 bytes, so init refuses a data root long enough to
  exceed that.
- **Machines:** run from a digest-pinned OCI image, on smolvm's own 48 MiB agent
  rootfs (about 200 MiB of disk per machine).
  - Each VM runs as its own uid (2000000 and up), so guests can't write the
    shared agent rootfs.
  - Restores, and so forks, get a fresh uid, so no two machines share one.
- **Setup rule:** install packages with `--no-install-recommends`, or at least
  never install `systemd-resolved`. It turns `/etc/resolv.conf` into a symlink,
  and every later `machine start` then fails (an upstream bug). Nothing checks
  for it; the next start fails loudly.
- **Trust smolvm's exit codes:**
  - `machine start` returns after the agent is ready.
  - `stop` returns after the process is dead, or fails (see Stop below).
  - `exec` refuses a stopped machine.
  - `delete` removes the record only after death and storage removal.

  So there is no state polling and no inspection around calls. To read one
  machine, use `machine status --name X --json`, never `machine ls`; `ls -v` is
  only for ports. Read status before `machine stop` when the name may be
  unknown to smolvm: a stop of an unknown name leaks an empty `vms/<hash>/`
  directory.
- **Every smolvm machine starts with `--branchable`.** Store capture requires it.
  It gives the guest file-backed RAM, so capture pauses the source for
  40–170 ms instead of 0.5–3 s, and the source's resident RAM doesn't grow.
  Restored machines are branchable anyway. `machine status --json` reports
  `branchable: false` regardless, so don't read it.
- **Fork is a checkpoint plus a restore:**
  1. Capture the running source into a store of the fork's own,
     `forks/<child-name>/`.
  2. `machine create --from` that checkpoint.
  3. Swap the ports.
  4. Start and prepare.
  5. Remove `forks/<child-name>/` whole.

  Step 5 runs whether the fork succeeded or failed (`Effect.ensuring`), and host
  startup wipes the forks area, since nothing is in flight then. No prune is
  needed: restored machines hold no reference into a store, and the restore
  cache is off. P9 confirms deleting a whole store under running children.

  The child continues the source's RAM state, gets a fresh identity and its own
  uid, and has no lineage. It takes 1.6–2.4 s. The cost is disk: a restored
  machine keeps its RAM file (about 280–620 MiB) for its life.
- **Never call `machine branch`:**
  - Each branch adds a backing layer to the source, and smolvm refuses the 33rd.
    Only a pack rebuild resets it, and that loses the source's RAM.
  - A branched source carries its layers into every checkpoint and restore made
    from it.
  - A cold-restarted source with a kept branch child reads `frozen` and refuses
    `stop` and `delete` (unfixed at 1.22.2).
- **Stop:** `machine stop`, and nothing else.
  - smolvm hard-kills an unreachable agent or an orphaned VMM itself.
  - A reachable guest that doesn't confirm its filesystem flush is left running,
    and `stop` fails. Return that error rather than force the stop: killing the
    VM then could lose writes.
  - `delete` must still work on such a VM. When `machine stop` fails, delete
    kills the VM's scope (`systemctl kill smolvm-vm-<name>.scope`), then runs
    `machine delete -f`; `-f` only skips the prompt. Phase 3 verifies this.
- **Checkpoints:** the kind follows the machine's state at capture.
  - **`ram`, from a running machine:** a store checkpoint (below); smolvm
    captures only running machines. A restore continues the source's RAM state
    and keeps a RAM file (about 280–620 MiB) for its life.
  - **`disk`, from a stopped machine:** `pack create --from-vm` into the host's
    packs directory. A restore is `machine create --from` the pack, then a cold
    boot. The new machine extracts the pack once, at create, and never reads it
    again, so delete just removes the file. A pack keeps uid/gid and modes but
    drops all xattrs and file capabilities, so a machine that will be
    disk-checkpointed must not rely on file capabilities.
  - **Pin:** a `ram` checkpoint records the smolvm version and the platform at
    capture, and a restore under a different pin is refused with
    `Precondition`. smolvm enforces sizes, platform, CPU contract and network,
    but not the engine build or the agent. A `disk` checkpoint has no pin:
    smolvm stamps a format version into each pack and keeps reading older ones.
  - **Capture:** smolvm publishes a checkpoint durably or not at all. After a
    crash, the host discards the interrupted capture, and `checkpoint-prune`
    removes the staging that smolvm marked. Partial RAM artifacts are never
    published.
  - **Store mode:** `ram` checkpoints go into one store per host (`--store`,
    with `--history 0`); forks use their own stores.
    - Repeated captures share unchanged chunks; a second and third capture saved
      34% and 53% of disk.
    - Each checkpoint directory is independent, and restored machines hold no
      reference into the store.
    - Delete is: remove the checkpoint directory, then `checkpoint-prune`.
    - `--history 0` matters: with smolvm's default of 32 retained generations,
      deleting older checkpoints frees nothing until the newest is gone.
  - **Restore cache off:** `--restore-cache-entries 0`. smolvm's restore cache
    (`vms/_restore-checkpoints`) survives every smolvm command, including
    deleting every machine, and a fork restores each checkpoint only once.
  - **Root restore:** single-file restores as root shared RAM read-only and used
    a copy-on-write disk top (about 0.7 MiB of private disk). P9 measures the
    same for store restores.
- **DNS:** no `DNS` knob. smolvm's gateway relays DNS, and smolvm refuses
  capturing a machine with custom DNS.
- **Disk sizing:** one disk-size field per machine (`diskGib`). P8 decides
  whether this needs smolvm's compact templates or host `resize2fs`.

### Runtimes: Tart

- **Names:** native names carry the kind: `cbx-m-<name>` for machines and
  `cbx-c-<name>` for checkpoints. Tart has one VM namespace, shared by both
  kinds and by the operator's own VMs; the prefix keeps them apart, and
  listings filter on it.
- **Softnet:** `--net-softnet-block=@host`. Blocking `@host` also blocks gateway
  DNS, so setup sets public resolvers first.
- **Removed:** no `tart ip`, no `HOME=<root>` for tart (test the keychain when
  removing it), and no refusal to replace a live launchd job.
- **Clone:** `tart set --random-serial` once per clone. No `--random-mac`, since
  clone already regenerates a colliding MAC.
- **Trust Tart's clone:** it builds in a temp directory under a lock and
  garbage-collects interrupted clones. Since 2.40.1, clone refuses an existing
  destination: map that to `Conflict{kind: exists}` and never pass
  `--overwrite`.
- **Fork and checkpoint need a stopped machine.** Tart's clone doesn't require
  one, so that rule is ours. It is checked after the source is claimed, so a
  `start` can't slip in before the clone. A running machine is refused with
  `Precondition`. Tart checkpoints are always `disk`.
- **Delete:** exit 2 means missing; from 2.40.0 a running VM exits 1. No
  inspections around delete.
- **Stop:** in-guest `shutdown -h now`, then `tart stop --timeout 0` as the
  forced fallback.
- **Capacity:** Apple allows two running macOS VMs per Mac, the operator's own
  included. Every action that boots a VM (create, start, fork, restore) counts
  running VMs with `tart list` in step 3 and refuses with `Capacity` at two, so
  the refusal writes nothing and placement can move on. Apple's own refusal is
  the backstop when two starts race: it maps to `Capacity` too, but the clone
  that a create, fork or restore has already made then stays, with
  `action.status = failed`. P11 checks what that refusal looks like.
- **Guest agent:** stock Cirrus images run tart-guest-agent ≥ 0.15.0 as a
  per-user LaunchAgent, which starts after auto-login. Tart's `Runtime.exec`
  waits for `tart exec` to answer after boot, then runs its command through
  `sudo -n`. A base without passwordless sudo fails the create loudly. P3
  checks both on a current image. The forwarder calls `tart exec` directly,
  since `nc` needs no root.

### Runtimes: boat

- **The service:** boat.dev runs Linux sandboxes (x86_64 VMs) in its cloud.
  - The host calls boat's HTTP API v1 directly, with Effect's HTTP client and
    Schemas for the endpoints it uses. It uses no boat SDK or CLI.
  - Host config holds a boat API key.
  - The account needs a paid plan: the trial forces auto-stop within 2 hours
    and allows 2 sandboxes.
- **Every create, fork, resume and restore** sends:
  - `noEnv: true`, so no account secrets, GitHub token or model logins reach
    the guest. The guest still gets a boat token confined to itself.
  - `ttlSeconds: null`, so boat never stops it on a timer. A fork otherwise
    defaults to one hour.

  Snapshots stay on: stop, resume, fork and checkpoints depend on them.
- **IDs:** boat assigns sandbox IDs (`bx_…`), kept in the row's `native`
  column. Create, fork and restore send an `Idempotency-Key` derived from the
  row's `instance` value.
  - If the host crashes before it records the ID, `delete` repeats the call
    with the same key and body to learn the ID, then deletes that sandbox.
  - Within boat's 24-hour key window the repeat returns the original. After
    it, or if the original never existed, the repeat may create a sandbox,
    which `delete` then removes after seconds of billing.
  - This repeat happens only inside `delete`, never at host startup.
  - After a create, fork or restore, the host sets boat's display name to the
    machine ID, for the operator's boat dashboard.
- **State:** read with one `GET /sandboxes` per listing, filtered to the
  recorded IDs, because the account may also hold the operator's own
  sandboxes.
  - `ready`, `idle` and `running` read as `running`.
  - 404 and `cancelled` read as `missing`.
  - Anything else reads as `stopped`. A machine that boat stopped on its own
    reads `stopped`, and `start` resumes it.
- **Sizes:** boat has four fixed machine types, from `small` (2 vCPU, 4 GiB,
  12 GiB) to `xlarge` (16 vCPU, 32 GiB, 251 GiB, plan-gated).
  - The host picks the smallest type that covers `cpu`, `ramMib` and
    `diskGib`, and the machine reports that type's sizes.
  - A request that no type covers is refused with `Capacity` in step 3, not
    `Precondition`, so placement moves on to a host that can take it.
- **Capacity:** boat refuses in three ways, and none of them leaves anything on
  boat:
  - 429 (`limit_reached`, `rate_limited`, `daily_limit_reached`);
  - 503 `no_ready_machine`, for a `failFast` call;
  - a create or fork that ends in state `cancelled` when boat finds no
    machine.

  All three map to `Capacity` and roll back like a failure in step 3. Create,
  which placement can move on from, sends `failFast`. Fork, restore and start
  wait for a machine. Refused requests still count against boat's start
  limits, so falling through spends some of the account's budget.
- **Ready:** boat reports `ready` before its lazy restore has finished.
  `/var/lib` and `/var/opt` arrive a few seconds later, and enabled units start
  after that.
  - Preparation writes `/var/lib/clankerbox/`, so after a fork, start or
    restore the runtime also waits, over exec, for
    `/var/lib/ascii-lazy/sys-done`.
  - That marker is undocumented. boat's documented signal, the
    `sandbox.hydrated` webhook, can't reach a host on the tailnet.
  - P14 confirms the marker and asks boat for a documented signal. Re-check it
    at every change of boat's API or image.
- **Exec:** SSH as `user`, through `sudo -n`.
  - The host owns one ed25519 key, generated at init, and authorizes it with
    `POST /sshkey` after create. Forks, resumes and restores carry it in
    `/home/user/.ssh/authorized_keys`.
  - ssh joins argv into one string, so the runtime quotes it.
  - Before its first SSH to a new activation, the host reads the guest's host
    keys through boat's command API, over HTTPS, and pins them. After
    preparation, the pin is `Machine.hostKey`.
  - boat's command API is not the exec: it takes no stdin and caps a call at
    600 s. An SSH session has neither limit.
- **Endpoints:** guest port 22 is reached at boat's `sshEndpoint`, a public IPv4
  relay, or at `ip:22` when the machine has an IPv4 address of its own.
  - Host and port change on every start, so the host reads them with the
    state and never stores them.
  - Other exposed ports go through the forwarder (see
    [Guest access](#guest-access)).
- **Fork:** a fork of a running machine would come from boat's last background
  snapshot, which can be a minute old.
  - So the host first syncs the guest's filesystems and notes the time. It
    waits until a snapshot attempt that began after that time has completed
    (about 40 s observed), then forks.
  - The source keeps running, and a stopped source forks at once.
  - Forks carry the disk only, never RAM.
- **Checkpoints** are boat named snapshots, always `disk`, from a running or a
  stopped machine. Capture takes about two minutes from a running machine and
  under a second from a stopped one.
  - A restore creates a sandbox `from` the snapshot.
  - Named snapshots don't depend on their source and survive its deletion.
  - Names are account-wide, so the host uses `cbx-<host>-<name>`.
  - boat keeps at most 10 per account, and the refusal at the cap is
    `Capacity` (P14 checks its shape).

  The alternative, checkpoints as stopped sandboxes, avoids the cap but costs
  a start per capture. It is not used.
- **Stop:** `POST /stop`, then wait for `archived`. boat takes a final
  snapshot, and if that fails it refuses the stop and the machine keeps
  running. Return that error. Never pass `force`: it drops everything written
  since the last snapshot.
- **Delete:** `DELETE` with `X-Ascii-Confirm-Delete`. The machine is gone once
  boat answers 404, within a second.
  - boat's deletion operation then purges data in the background, sometimes
    for hours, and the host never waits for it.
  - Repeating a `DELETE` returns the same operation.
  - A checkpoint is deleted with `DELETE /named-snapshots/{name}`.
- **Setup rules:**
  - State that must survive a stop, fork or checkpoint goes under
    `/home/user`, `/etc`, `/usr`, `/opt`, `/srv`, `/root`, `/var/lib` or
    `/var/opt`. `/tmp`, `/var/tmp`, `/var/cache` and `/var/log` don't carry
    over, and neither do `ufw` rules.
  - Leave boat's sshd, `user`'s `authorized_keys`, TCP port 8911 and boat's
    WireGuard tunnel alone. Blocking them cuts boat off from the guest.

### Other host rules

- **One exec per runtime:** `Runtime.exec(machine, argv, stdio)` runs as root in
  the guest. Each runtime gets there its own way: smolvm's exec already runs as
  root, and Tart's and boat's add `sudo -n`. Setup and preparation have no
  runtime cases.
- **State dir:** a directory is ours if it holds our SQLite database. Init
  creates the database in one transaction and refuses a non-empty directory
  without one. There is no separate marker file and no temp-directory rename.

## CLI and dev

- **`clankerbox ssh MACHINE [ssh args…]`:** looks up the machine's `ssh`
  endpoint and host key, writes a one-line known-hosts file, then execs the
  system `ssh`. Ports change on fork and restore, and on boat the host and port
  change on every start, so typing them by hand isn't practical.
- **IDs:** every command takes IDs. `create NAME` is placed and prints the new
  ID.
- **`create`:** `--profile` takes a path to a profile file, or a name looked up
  in the profiles directory from client config. `--require` and `--avoid` add
  to the profile's lists. Without a profile, `--base` and the sizes are given
  directly, and `--setup FILE` with `--setup-timeout` is optional.
- **Shared options:** `--json` and `--timeout`. A mutation returns when its
  action has finished; `--timeout` only stops waiting.
- **Client config:** one file holding the host list, in placement order, the
  key path, and an optional profiles directory.
- **`clankerbox dev`** (Linux only, run as root):
  - Runs a host in the foreground with an embedded `clankerauth-dev` issuer
    (fixed `dataDir` and port, so keys survive restarts).
  - Publishes on loopback.
  - Takes `--state-dir`, defaulting to `/var/lib/clankerbox/dev`. The data root,
    the client config and the key live under it. The client config and key are
    owned by the invoking user (`SUDO_UID`), so the runner user in CI can use
    what `sudo clankerbox dev` wrote.
  - VMs run in their own scopes, so stopping `dev` leaves them running.
- **`dev destroy`:** stops and deletes every machine and checkpoint recorded in
  the state dir's database, through the runtimes, confirms that no VM runs,
  then removes the state dir. It refuses a directory without our database.

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

**Runtimes are not shipped.** smolvm and Tart are host prerequisites (see
[Runtimes: smolvm](#runtimes-smolvm)). The release carries no smolvm files, no
runtime manifest, and no notices or corresponding source for smolvm and its
native libraries.

**Notices:** Node's LICENSE and the pnpm dependency notices.

**Pins:** one `release-inputs.json` keyed by platform, with the Node SEA base
binaries. The smolvm version the release was tested on is a constant in the
host.

**CI:** one vite-plus job, plus a SEA build smoke test on both targets.
`publish-sdk` publishes `packages/contract` on release tags.

## Phases

Each phase ends with `vp run ready` green. Live tests run where hardware allows.
Every live run uses `scripts/work_runs.py`.

0. **Spike.** Run spikes P1, P2, P3, P5 and P8. If P1 fails, change guest access
   to the fallback in [Spikes](#spikes) before phase 2.
1. **Scaffold.** The root workspace, catalog, lint and CI. Scaffold the
   `apps/clankerbox` role dispatcher and the SEA build for both targets, with a
   hello world per role.
2. **Contract.** Schemas, the tagged errors, `<host>_<name>` IDs, the action
   groups, the profile file schema, and the client library (host list, routing,
   fan-out with partial results, placement). Long mutation calls: the client's
   and the server's timeouts off.
3. **Host.**
   - The journal, claims and the error-reply invariant, the schema version,
     lifecycle, the smolvm, Tart and boat runtimes, supervision, setup and
     preparation, and both checkpoint kinds.
   - Port allocation, smolvm publishing and the forwarder (Tart and boat).
   - Host labels, bases and the runtime in config, Tart's capacity count and
     boat's machine-type choice.
   - The clankerauth resource.
   - `stop` and `delete` on every runtime after an interrupted operation,
     `delete` of a smolvm VM whose stop failed, and `delete` of a boat row
     whose create was interrupted before its ID was recorded.
   - Spikes P9, P11, P12, P13 and P14.

   Unit tests use a fake runtime layer; live tests use real VMs.
4. **CLI and dev.** Commands, profile files, `ssh`, and `dev` and `dev destroy`
   with clankerauth-dev.
5. **Release and live tests.** `tools/release` (SEA, bundle, notices) and
   `tests/live`. Then the README design section and the bump skills (seeded from
   evidence.md).
6. **Cut over.**
   - Cut-over waits until every API consumer runs on the new SDK, or the
     operator accepts that consumer's downtime.
   - Run the full live acceptance suite on Apple Silicon (Tart), on
     Linux/amd64 with KVM (smolvm as root), and against boat on a paid plan.
   - Release.
   - Publish the SDK major.
   - Delete these plans in the last commit before the merge.
7. **Redeploy production.** In personal-cloud:
   - Destroy the 0.11.0 machines and checkpoints on both hosts, and the
     controller.
   - Move the hosts onto the tailnet if not already done.
   - Delete the clankerbox WireGuard link, the PKI and the UniFi rule.
   - Install smolvm 1.22.2 from upstream under `/opt/smolvm/1.22.2` on the Linux
     host, and Tart ≥ 2.40.1 on the Mac.
   - Run the smolvm host as root: system units, and host state out of
     `/home/clanker`. As root, smolvm adds others-execute to every directory
     above its data root.
   - **Change the egress guard before any guest runs:** `meta skuid 1000` becomes
     `meta skuid 2000000-101999999`, smolvm's per-VM uid range. Until then, a
     guest can reach services on the host's public address.
   - Set `SMOLVM_RESTORE_TMPFS=0`. Only `machine pause`/`resume` stage memory in
     tmpfs, and clankerbox uses neither. Without `=0`, every root restore still
     creates `/dev/shm/smolvm-restore`. Restores cost the same either way.
   - Add a boat host: a second host process on the Linux host, unprivileged,
     with host ID `boat`, its own state dir, a boat API key on a paid plan, and
     the `cloud` label. Clients list it last, so the local hosts are preferred.
   - Deploy with clankerauth keys covering all three hosts.
   - Configure each host's bases (a digest-pinned stock Ubuntu image on Linux;
     digest-pinned Cirrus base and Xcode images on the Mac; boat's image on the
     boat host) and any operator labels.
   - Rewrite the profiles (`linux-dev`, `mac-xcode`, `gg-linux-dev`,
     `cliamp-dev`) as profile files, in the repositories that keep their
     recipes: base, sizes, `expose`, and a setup script that installs sshd and
     the operator's key, sets the guest's environment (`gg-linux-dev`'s `env`
     moves there; P3 checks the paths), and writes an idempotent
     `/etc/clankerbox/start` that daemonizes what it launches.
   - Update the consumers' docs: `clankercreds/docs/recipe.md`, which still
     documents `machine.json`, and cliamp-verify's `clankerbox.md`, where
     `shell -T` becomes `ssh MACHINE -- cmd`, `create` takes the `cliamp-dev`
     profile file, and `profile publish`, `logs` and `operation` are gone.
8. **Clean up the test machines,** following
   [Test machine footprint and final cleanup](#test-machine-footprint-and-final-cleanup).

## Spikes

The ones already done, with numbers, are in evidence.md: S3 (exec transport),
S4 and its 26.10.0 re-run (SEA), S5 (clankerauth 0.11.0), the stock-image test
(including `pack` and host keys), the ESTALE and fork-state runs on Linux, root
mode on Linux, fork as checkpoint + restore on this Mac and on Linux as root
with restore tmpfs, on 1.22.2 the `machine branch` depth limit and fork
through the checkpoint store, and the two boat runs on a trial account.

### Phase 0

| Spike | Gates |
| --- | --- |
| **P1. Published ports on the tailnet.** On the Linux host as root (ask for approval first): a stock-image machine with `-p` on the tailnet address and `SMOLVM_EGRESS_FLOOR=strict`, then ssh, scp and rsync from another tailnet machine. Also over the tailnet: a fork (store checkpoint + restore) and two restores beside a running source, each with its swapped port and new host key, all under `SMOLVM_VM_USE_SCOPE=1` and on 1.22.2. Loopback and `127.0.0.2` already work, and restores under scopes do too. | guest access, or its fallback |
| **P2. Tart forwarder.** Listener → `tart exec -i` → guest `nc 127.0.0.1 22`: ssh and rsync throughput, idle survival, and whether accepting on the tailnet interface needs Local Network permission. | guest access on Tart |
| **P3. Setup and preparation.** Setup on a stock `ubuntu:24.04` image over plain exec: installing openssh-server with `--no-install-recommends` and a key, and how long it takes. On a current Cirrus image: how long until `tart exec` answers after boot, with no manual login, and does `sudo -n true` succeed? On smolvm, does a child started with `setsid -f` outlive the exec (sshd's own daemonizing already does)? Re-mint on Tart clones and on machines restored from a pack, and the time a second re-mint adds to a smolvm fork. How do ssh sessions and daemonized processes pick up the guest's environment (`/etc/environment` through PAM)? How long does a realistic `start` (sshd plus a clankercreds sync) take, to set its timeout? Re-running `start` on a running smolvm machine already works. | setup, preparation, Tart bases |
| **P5. Pins.** Re-run S5 on clankerauth-sdk 0.12.0, and smoke-test effect-actions 0.9.0 on Effect 4.0.0 inside a SEA, including one unary call that runs past 300 s, to find any timeout of its own. | phase 1, long calls |
| **P8. Disk sizing and install.** Which disk holds workload writes for a stock-image machine? Do sizes above or below smolvm's 20/10 GiB templates need host `resize2fs`? Can machines drop the overlay size and the compact templates? With smolvm installed under a prefix, does a stale `~/.smolvm` shadow its templates, and does the upstream wrapper find its libraries? | disk sizing, smolvm install |

**Fallback if P1 fails:** no published ports. `clankerbox pipe MACHINE PORT`
carries bytes over `Runtime.exec` into the guest's `nc`, used as an ssh
`ProxyCommand`. clankerbox then sits in the data path, which needs a streaming
call next to the unary ones. smolvm's `--expose-socket` is the other fallback.

### Phase 3

| Spike | Gates |
| --- | --- |
| P9. Restores as root. A store-mode `ram` restore: does it still share RAM read-only and use a copy-on-write disk top, as single-file restores did? Private disk and memory per restored machine with `--restore-cache-entries 0`. Then delete a fork's whole store while its children run. A `disk` restore: `create --from` a pack with `--net` and `-p`, its disk per machine, and the re-mint. | checkpoint and fork cost, fork cleanup, `disk` checkpoints |
| P11. Tart's own refusal of a third VM: a fast refusal, or a hang until timeout. | the capacity backstop |
| P12. Concurrent smolvm CLI calls on different machines in one inventory: do any need serializing? | a semaphore around those calls |
| P13. Root smolvm on a GitHub-hosted runner (ask before pushing a workflow): a start and a restore under `SMOLVM_VM_USE_SCOPE=1`, each VM outliving its launching process. | dev in CI, with scopes or without |
| P14. boat on a paid plan (ask before buying one). `ttlSeconds: null` on create, fork, resume and restore. The refusals for an 11th named snapshot and for `xlarge`. `/var/lib/ascii-lazy/sys-done` against the restored files on a fork, a resume and a restore of a machine with several GiB written, and whether a fresh create has it; ask boat for a documented signal. What opening a forwarded connection (`ssh -W` through the relay) costs. A setup script (sshd and a key) on boat's image. | boat's ready wait, checkpoint cap, forwarder |

## Test machine footprint and final cleanup

Everything the rewrite creates on a test machine is removed when the work ends.

- **Machines:**
  - this Apple Silicon Mac: Tart, and smolvm for the earlier spikes;
  - `ssh clanker@37.27.63.112`: Linux/amd64 with KVM. This is the production
    personal-cloud Linux host. `clankerbox-host.service` (user unit) runs there
    and is never touched. Each root-mode run (`sudo`, system units, uids outside
    the owned root) needs the user's approval first;
  - the operator's boat.dev account, on a trial now. Runs record every sandbox
    ID and named snapshot as they create it, and their teardown deletes them.
    A deleted sandbox answers 404 at once, while boat's deletion operation
    purges its data later.
- **One owned root per machine:**
  - Linux: `~/clankerbox-rewrite/`. Never touch `~/clankerbox`, its service, its
    VMs or its smolvm state, and never restart `user@1000`.
  - Mac: this worktree's `.work/`. `/.work/` is excluded in the repository's
    `info/exclude` while the tree has no `.gitignore`.
- **Resource naming:** every native resource carries a `clankerbox-rewrite`
  prefix and is recorded in its run's evidence. On boat, a run's host ID
  carries the prefix, so each sandbox's display name (its machine ID) and each
  named snapshot's name do too. A run's teardown stops its resources before
  scratch is deleted.
- **Resources that aren't ours:** smolvm processes from other bundles may run on
  the Mac. Never stop them.
- **Ledger:** `~/clankerbox-rewrite/CLEANUP.md` records every change outside the
  owned root. `clanker` is still in the `kvm` group (added 2026-09-30); every
  other recorded change is reverted.
- **Seeds:** reusable VM seeds go into the main checkout's `.work/inputs`, with
  provenance and a ready marker, and are always used through private clones.
  They are not ours to delete.
- **Retained now:**
  - Linux: about 3.4 MiB of run evidence.
  - Mac: `.work/runs/*` evidence, `.work/spike-results/*` (the results and
    drivers of the spikes run after the tree was emptied), and
    `.work/spike-evidence/` (the S1 and S3 raw outputs).
  - `.work/upstream-smolvm/` belongs to the separate upstreaming work, not to
    these runs.
  - boat: no sandboxes and no named snapshots. The first boat run's two
    deletion operations were still purging data, expected by 23:00 UTC on
    2026-10-02.
- **Final cleanup, the last step of the whole effort:**
  1. Stop every recorded process, unit, job and VM.
  2. Confirm none remain, by name prefix and by the recorded IDs, including
     sandboxes and named snapshots on the boat account.
  3. Delete both owned roots and any seed clones.
  4. Walk the ledger with the user.
  5. Report what was removed, and anything deliberately kept, with size and reason.

## Validation

- `vp check`, `vp run -r test` and `vp run -r build` on every change.
- SEA smoke tests on each target: every role starts and `--help` works.
- Live acceptance, which must cover:
  - create/start/stop/delete;
  - placement: a create landing on the first matching host in list order,
    `--avoid` steering it to another, a `Capacity` refusal (Tart's two VMs, and
    boat's account limit) moving it on with nothing written on the full host,
    and no matching host replying `Precondition` with each host's reason;
  - setup running once at create, and a failing or overrunning setup failing the
    create with its output;
  - RAM fork, `ram` and `disk` checkpoint capture, restore and delete on
    smolvm, and `disk` checkpoints on Tart;
  - on boat:
    - a stop and start that bring a new endpoint and host key;
    - a fork of a running machine that holds a file written just before the
      fork;
    - a checkpoint captured from a running machine and restored after its
      source is deleted;
    - preparation finding `/var/lib/clankerbox/` from before a start;
    - `delete` replying once boat answers 404;
    - a non-ssh exposed port reached through the forwarder;
  - `clankerbox ssh` into a machine on each runtime with the pinned host key, and
    scp and rsync of a binary file compared by hash;
  - a fork and two restores of one checkpoint: each gets its own port and host
    key, and ssh works into all of them while the source runs;
  - `start` running to completion after every activation, a failing `start`
    failing the action with its output, and the instance and machine-ID files
    updated on fork and restore, including a restore under a reused name;
  - a fork's source stopped, cold-started and deleted while its forks keep
    running, and the fork's own store gone afterwards with no effect on the
    child;
  - a host restart keeping VMs, smolvm's published ports and the machine-ID
    file, wiping the forks area, and Tart's and boat's forwarded endpoints
    coming back after the forwarder restarts;
  - `stop` and `delete` after an interrupted operation, including a boat
    create interrupted before its ID was recorded;
  - a mutation whose client disconnects still finishing and recording its
    outcome, and a call that runs past 300 s replying normally;
  - a duplicate name refused with `Conflict{exists}`, a lost-reply retry
    resolved by reading the resource, and a second action on a claimed machine
    refused with `Conflict{busy}`;
  - Tart's two-VM limit refused with `Capacity` before any clone, with nothing
    written;
  - list fan-out with one host down;
  - `dev destroy` removing every resource and the state dir;
  - `--json` error tags.
- Every live run goes through `scripts/work_runs.py`, following AGENTS.md.
