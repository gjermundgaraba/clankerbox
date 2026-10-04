# TypeScript/Effect rewrite: plan

Status: planned. Every design decision below is closed. The phase-0 spikes have
run (evidence.md, "Phase 0 spikes"). P14 checks boat's auto-stop once the
account is past its trial. The evidence behind the
decisions is in [evidence.md](evidence.md). Both files are deleted in the last
commit before the merge.

clankerbox is rewritten from scratch in TypeScript on Effect 4, as a clean break.
No persisted state is migrated. Production is destroyed and redeployed at
cut-over, and there is never a release where both implementations ship.

The Go implementation is deleted from this branch (`4898a3e`). Read it at `main`
(`c112847`) or at `88969a9`, and don't restore it. evidence.md cites it as
`G:path:line` at `c112847`.

**What clankerbox is after the rewrite:**

- It runs machines and reports where each one is reachable. Lifecycle covers
  create, start, stop, delete, RAM fork, checkpoints and restore.
- A client asks for a machine by profile or by base, and the client library
  sends it to the first host in its list that offers that base, unless the
  request names a host. Hosts are configuration, not a choice made per command.
- A profile is a client-side file: a base, sizes, a setup script and,
  optionally, a host. Hosts store no profiles.
- A small preparation contract runs over each runtime's own exec.
- Each machine's SSH endpoint is reported as a `host:port`, together with the
  guest's SSH host key. SSH is the only port a machine exposes.
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
| Network and auth | Hosts and clients share the operator's Tailscale tailnet. Its policy lives in garaba-home's `access.ts`, outside this plan, and denies anything it doesn't name. The policy is the only gate: there are no API keys. garaba-home gives every caller its own tag (an app that needs the tailnet gets its own Tailscale container), so the policy can open each host port to exactly the callers that use it. A host listens only on its tailnet address, or on loopback for a local host. A guest must not reach its own host's API port from inside the box, where the policy doesn't apply; P1 checks that. No hop of ours uses TLS: the tailnet encrypts and authenticates. A boat host calls boat's API over HTTPS, and boat machines' SSH endpoints are public addresses (see [Runtimes: boat](#runtimes-boat)). |
| State | SQLite through `node:sqlite`, on each host. The schema is versioned with `PRAGMA user_version` and an ordered list of migrations, starting at version 1. There is no client-side state beyond configuration and profile files. |
| Placement | The client library places `create` on the host a full ID or the profile names, or else on the first reachable host in its host list that offers the request's base. There are no labels and no fall-through to another host. Every other call routes by ID. |
| Linux guests | Ubuntu 26.04 LTS, the latest LTS, where we choose the image: smolvm bases are stock `ubuntu:26.04`, pulled by digest from mirror.gcr.io. A runtime that ships its own image is used as it comes; boat's is Ubuntu 24.04. |
| Profiles | Client-side files, never stored on a host. A machine is created from a base image the host names (a stock image, or boat's own), and the profile's setup script runs once, at create. A profile can also name its host. |
| Production | personal-cloud runs 0.11.0 with a Linux smolvm host (Hetzner) and a Mac Tart host. garaba-home replaces personal-cloud. At cut-over, every 0.11.0 machine and checkpoint is destroyed, the new release is deployed from garaba-home with a boat host added, and the profiles are rewritten as profile files. |
| Hosts | A smolvm host always runs as root. smolvm runs only on Linux hosts and Tart only on macOS hosts. A boat host runs unprivileged on either. |
| Runtimes | smolvm and Tart are host prerequisites that the operator installs. The release ships neither. boat is a cloud service: a boat host needs only a boat API key, on an account past boat's trial. |
| MCP | None. |
| Tooling | vite-plus 1.0.0 (`vp`), pnpm 12, TypeScript 7.0.2, laid out like `/private/tmp/monorepo-example`. The lint setup (typeAware, typeCheck, the anti-slop plugin) mirrors clankerauth's. Live runs use `scripts/work_runs.py`. |
| Dependency floors | smolvm exactly 1.22.2, upstream and unmodified (see [Runtimes: smolvm](#runtimes-smolvm)), Tart ≥ 2.40.1, tart-guest-agent ≥ 0.15.0, Softnet 0.24.0 (macOS 26 hosts), boat API v1, Node 26.10.0. |

## The design rule

Before building any mechanism that wraps a dependency, answer five questions,
and answer them again at every bump of that dependency:

1. **Duplicated bookkeeping.** Does the dependency already track this? Example:
   smolvm records and enforces a checkpoint's sizes, platform, CPU contract
   and network, so our pin covers only what it doesn't: the engine build and
   the agent.
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
  host list `[{id, url}]`.
  - `create` is placed (see Placement under [API contract](#api-contract)),
    unless it is given a full ID. Every other call names an ID, and the client
    library routes it by the ID's host part, so routing never needs the
    network.
  - Lists fan out to every host. They return what reachable hosts answered and
    name the unreachable ones, rather than failing whole.
  - There is no name lookup.
- **Host:** owns everything durable for its machines: machines, checkpoints and
  port allocations. Machine state (`running`, `stopped`, `missing`) is always
  read from the runtime, never stored. A machine and its checkpoints stay on
  the host that created them; nothing moves between hosts.
- **Runtimes:**
  - smolvm: Linux guests on Linux hosts, with RAM forks and `ram` checkpoints,
    through its CLI.
  - Tart: macOS guests on macOS hosts, with disk copies, through its CLI.
  - boat: Linux guests in boat.dev's cloud, with disk forks and checkpoints,
    through its HTTP API. boat is extra capacity that is picked on purpose:
    by its base, by a `boat_` ID, or by a profile that names the boat host.

  Each is one module behind a shared `Runtime` interface. The state, setup
  and preparation are shared. Port allocation, the forwarder and supervision
  are helpers that a runtime calls when it needs them. The host records the
  endpoints its runtime reports. Fork, checkpoint and access stay
  runtime-specific.
- **One runtime per host process.** Two runtimes on one machine are two host
  processes, each with its own host ID, so the host never picks a runtime per
  machine. Host config names the runtime (`smolvm`, `tart` or `boat`), since a
  boat host can run on either OS. A new provider is a new runtime module behind
  its own host.
- **Guest contract:** setup and preparation over the runtime's exec. No
  clankerbox binary runs in a guest.
- **Guest access:** each machine exposes guest port 22 and nothing else. smolvm
  publishes it, boat reaches it through its own relay, and Tart through the
  host's forwarder. It is reported as `host:port`, together with the SSH host
  key. Other guest ports go through `ssh -L`.
- **Rewind:** not built. smolvm can restore a machine as itself
  (`create --from … --keep-identity`) and, with store history, at an earlier
  generation (`--at '~N'`). Add it only when a consumer needs it.
- **A setup cache:** not built. Every create runs its profile's setup. To skip
  setup, capture a checkpoint of a set-up machine and restore copies of it. P3
  times gg-linux-dev's real setup; add a cache only if creates are too slow.

## Target layout

```
package.json            # vp scripts: ready = check + test + build
pnpm-workspace.yaml     # apps/*, packages/*, tools/*, tests/*; catalog pins below
vite.config.ts          # lint/fmt/staged/run.cache, as in clankerauth
tsconfig.json
apps/
  clankerbox/           # the only binary: `clankerbox <cli…> | host`; the CLI commands and `ssh` live here
packages/
  contract/             # Schemas, action groups (machine, checkpoint, host), errors, the profile file schema, client library (host list, routing, fan-out, placement, recipe packing)
  host/                 # state, claims, lifecycle, runtimes (smolvm, tart, boat), supervisor, setup, preparation, checkpoints, ports, forwarder (Tart), state dir and sqlite
tools/
  release/              # SEA build and signing, bundle, notices
  oxlint/               # anti-slop plugin, installed from upstream by the install-anti-slop skill
scripts/work_runs.py    # with WORK_RUNS.md
tests/live/             # gated live acceptance project, TypeScript, using the SDK
```

Catalog: effect, @effect/platform-node, @gjermundgaraba/effect-actions,
typescript 7.0.2, vite-plus 1.0.0, @types/node 26. No native addons.

**One multi-role SEA binary per platform**, about 150 MB each (about 45 MB
gzipped):

- darwin-arm64: CLI and host.
- linux-amd64: CLI and host.

Nearly all of each binary is Node itself (an Effect bundle run in one was
666 KB), so separate CLI and host binaries would each be as large, and a host
machine would carry both. One binary also keeps the CLI and the host on a
machine at one version.

Units run `process.execPath host --config PATH`. VM jobs never reference this binary (see
[Supervision](#supervision)).

## API contract

**IDs and names**

- Every machine and checkpoint has an ID of the form `<host>_<name>`.
  - The client chooses the name. Names are unique per host and per resource
    type. Two hosts can each hold a machine with the same name; their IDs tell
    them apart.
  - A host ID matches `^[a-z][a-z0-9-]{0,31}$`. boat's named-snapshot names
    must match `^[a-z0-9][a-z0-9-]{0,62}$`, and `cbx-<host>-<inst>` must fit
    in 63 characters. Short host IDs (`linux`, `mac`) keep IDs short to type.
  - Neither part contains `_`, so the ID splits at its one `_`, and a `create`
    target that contains `_` is a full ID.
  - The whole ID must match `^[A-Za-z0-9_-]{1,62}$`.
  - A name matches `^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$`: it starts with a
    letter, keeps its case, and has no `--` and no trailing `-`, because
    smolvm 1.22.2 refuses consecutive and trailing hyphens in `<name>-<inst>`
    (`validate_vm_name`).
- The separator is `_` and the 62-character limit apply because the ID is
  written to `/var/lib/clankerbox/machine-id`. clankercreds uses it as the
  machine's audit-log label, accepts only that pattern, and on a mismatch
  silently falls back to a label that forks would share.
- **Native names** carry the row's instance. Every machine and checkpoint row
  gets a random hex `instance` value when it is inserted, and `<inst>` below is
  its first 8 characters.
  - smolvm machines and their systemd scopes: `<name>-<inst>`.
  - Tart: `cbx-<host>-m-<name>-<inst>` for machines and
    `cbx-<host>-c-<name>-<inst>` for checkpoints (see
    [Runtimes: Tart](#runtimes-tart)).
  - boat named snapshots: `cbx-<host>-<inst>`, which leaves the name, with its
    case, out of boat's lowercase native name. boat assigns its own sandbox
    IDs (see [Runtimes: boat](#runtimes-boat)).

  A native resource the host didn't make for that row, even one left by an
  earlier row with the same name, won't carry the row's native name. So
  `delete` only ever removes what its row could have made, including after a
  crash between inserting the row and calling the runtime. Phase 2 checked
  that the runtimes' name rules accept these names: smolvm's
  `validate_vm_name` (S@1.22.2:src/data/mod.rs:58-98), Tart's clone, which
  only refuses `/` (T:Commands/Clone.swift:43-46), and the named-snapshot
  name pattern in boat's OpenAPI document (see evidence.md "Native names" and
  boat's Names bullet).
- Bases have names, not IDs. Each host names its bases in config, and hosts that
  offer the same image use the same name.
- Every command takes IDs, except `create`, which takes a name or a full ID.
  Given a name, the profile's host or else placement picks the host, and the
  reply carries the new ID. Given an ID, the create goes to the host it names.

**No idempotency keys, no operations resource**

- `create`, `fork`, `restore` and checkpoint `capture` take the new resource's
  name. If that name already exists on the host, the call fails with
  `Conflict{kind: "exists"}`.
  - `machine.create` carries the new machine's full ID. The host validates the
    whole ID, so a raw HTTP caller can't make a machine whose ID breaks
    clankercreds' pattern, and an ID that names another host is `Invalid`.
    Fork, restore and capture carry a name; the host validates the new
    resource's ID the same way, with `formatId(<host ID>, name)`.
- **Lost replies:** the client library doesn't resolve them. A mutation whose
  reply is lost returns `Unavailable`, naming the ID and saying that the action
  may have run; the caller reads the resource to see. It is not retryable. A
  retry of a `create` goes to that ID, so it never lands on another host.
- `start` on a running machine and `stop` on a stopped one succeed without doing
  anything, except that `start` on a running machine runs preparation again (the
  repair path, see [Setup and preparation](#setup-and-preparation)). `delete` of
  a missing resource is `NotFound`, which clients treat as done. A `stop` that
  does nothing writes nothing, so the row keeps its last `action`. A `start` of
  a machine the runtime reports `missing` is `Precondition` in step 3: delete
  it. A `create` for a base the host doesn't offer is `Precondition`, listing
  the host's bases, and an ID that names another host is `Invalid`.

**Placement**

- Only `create` is placed. Fork, restore, start, stop and delete go to the host
  of the machine or checkpoint they name: RAM state doesn't move, and nothing
  migrates.
- A create request carries the new machine's ID, a base name, `cpu`,
  `ramMib`, `diskGib`, an optional `setup: {script, timeoutSeconds}`, and an
  optional `profile` label. A profile file fills
  these in (see [Profiles and bases](#profiles-and-bases)).
- A full ID, or else a profile's `host`, sends the create to that host.
  Otherwise the client library reads every host's bases, in parallel, and sends
  the create to the first host in its host list that offers the base. A host
  that doesn't answer is skipped. Whatever the chosen host replies, `Capacity`
  included, is the reply; placement never moves on to another host.
- With no host offering the base, the reply is `Unavailable`, naming the hosts
  that didn't answer, if any didn't, and otherwise `Precondition`, listing
  each host's bases.
- The base picks the host. In production each base lives on one host: Ubuntu on
  the Linux host, the Cirrus images on the Mac, and boat's image on the boat
  host. To choose among hosts that share a base, `create` takes a full ID, or
  the profile names its host.
  Moving on to another host on `Capacity` comes back only when two hosts offer
  the same base.

**Synchronous mutations**

- A mutation replies when its action has finished: with the resource as it is
  afterwards, or with a tagged error. Native refusals such as `Capacity` are
  ordinary replies.
- This is the simplest contract: one call per mutation, and no polling. A
  connection that drops during a long create is rare, and the caller then
  reads the resource (see Lost replies).
- The action runs in a fiber forked into a scope that lives as long as the host
  (a `FiberSet` in the host layer), not into the request's scope. A dropped
  connection never interrupts native work, and the outcome is recorded on the
  row either way.
- The CLI's `--timeout` only stops waiting. On timeout the CLI reports, as for
  a lost reply, that the action may have run, and exits 1: the request may
  never have reached the host.
  It bounds each request to a host from when it is sent, so a list names a
  host that outlasts it as unreachable, and placement skips one.
- Every action runs in this order (see [State and claims](#state-and-claims)):
  1. Validate the input.
  2. Claim the rows, inserting the new row.
  3. Check runtime state, for example that a Tart source is stopped, that Tart
     has room for another VM, that a smolvm host's RAM budget has room, or that
     a boat machine type fits.
  4. Only then call the runtime.

  A failure in steps 1–3 releases the claims, removes the inserted row and
  replies with the error. Releasing a claim on an existing row puts its last
  `action` back. A check interrupted by the host's shutdown releases its claim
  too. **Invariant: an error before the first runtime call
  writes nothing.** A failure from step 4 on leaves the row with
  `action.status = failed` and replies with the same tagged error; `delete`
  cleans up. Each runtime's phase (3–6) proves both for every mutation.

  **Refusal rule:** a runtime error that the runtime knows created nothing
  native is handled like a failure in steps 1–3. Each runtime lists the errors
  it classifies this way; today only boat has any (see
  [Runtimes: boat](#runtimes-boat)). Any other runtime error keeps the row.
- **Long calls:** a mutation's reply, headers included, comes only when its
  action has finished. Node's server `requestTimeout` (300 s by default) covers
  only receiving the request, so it doesn't limit an action. The undici client
  behind `fetch` does: its header and body timeouts (300 s each at 26.10.0)
  would end a long Tart clone or a profile's setup. Phase 2 turns them off
  for mutation calls. effect-actions adds no timeout of its own (P5).
  - The client library uses `NodeHttpClient.layerNodeHttp`, which sets no
    timeout. `fetch` has no public way to turn its timeouts off at 26.10.0,
    and `NodeHttpClient.layerUndici` forces a 1 h header timeout.
  - Every action group maps a Schema error in its input to `Invalid`. Without
    that, effect-actions answers undeclared or malformed input with a bare
    400.

**Resources**

- **Machine:**
  - `id`, `runtime`, `createdAt`
  - `base`, and `profile?`: a label the client supplied at create
  - `cpu`, `ramMib`, `diskGib`
  - `state`, read from the runtime: `running | stopped | missing`
  - `action`
  - `ssh?: {host, port}`
  - `hostKey?`
- **Checkpoint:** `id`, `createdAt`, `machine`, `kind` (`ram | disk`), the
  source machine's `base`, `profile?`, `cpu`, `ramMib` and `diskGib`, and
  `action`. A restore creates a machine with that spec on the checkpoint's
  host.
- `createdAt` is when the host inserted the row. With agents creating machines,
  it answers how old a machine is.
- **Host:** `id`, `runtime`, the clankerbox and runtime versions (for boat, the
  API version), and its base names.
- **Fork** copies a machine to a new name on the same host. What it keeps
  depends on the runtime: smolvm copies a running machine, RAM included; Tart
  copies a stopped machine's disk; boat copies the disk, waiting for a fresh
  snapshot if the source runs. A checkpoint's kind follows the runtime: always
  `ram` on smolvm, of a running machine, and `disk` on Tart and boat.
- No resource repeats its name or host: both are parts of the ID, and the client
  library splits it.
- **`action: {name, status: "running" | "failed" | "done", error?: {tag,
  message}}`** is the one field for work on a resource, and records its last
  action. It is `running` while an
  action holds the row, `failed` with the error after a native failure, and
  `done` after a success. The next action replaces it. A checkpoint is ready
  once its action is `done`.

**Errors:** seven tagged errors:

- `Invalid`
- `NotFound`
- `Conflict{kind}`, where `kind` is `exists` or `busy`
- `Precondition`
- `Capacity` (the host has no room: on Tart, Apple's two-VM limit; on smolvm,
  the host's RAM budget; on boat, the account's limits or no ready machine)
- `Unavailable` (the client couldn't reach the host)
- `Internal`

`retryable` is derived from the tag, and for `Conflict` from its kind: `busy` is
retryable and `exists` is not. `Unavailable` is retryable for reads, and not
for a mutation, whose request may have reached the host.

In the client library, a request that fails to encode, such as a spec with
`cpu: 0`, is `Invalid` and sends nothing; a reply that fails to decode is
`Internal`.

## Feature scope

Rule: a feature with no real consumer is deleted. The real consumers are the
operator's CLI, the SDK's API clients, the production deployment (personal-cloud
today, garaba-home from cut-over), the `clankerbox-profiles` repository,
clankercreds, and cliamp-verify (an agent
skill that drives the CLI against the `cliamp-dev` profile). A feature used only
by tests, docs or harnesses doesn't count. SDK consumers outside this
repository plan their own migration, including anything they built on removed
features (guest sessions, `dev`); the cut-over gate in phase 8 is the only link.

**Kept:**

| Area | Features |
| --- | --- |
| Lifecycle | create (placed by base, or on the host a full ID names; from a profile file, or from a base with `cpu`, `ramMib`, `diskGib` and an optional setup script), start, stop, delete, RAM fork (smolvm), stopped-disk fork (Tart) and disk fork (boat), checkpoint capture (`ram` on smolvm, `disk` on Tart and boat)/get/list/delete, restore |
| Runtimes | smolvm (Linux guests, on Linux hosts), Tart (macOS guests, on macOS hosts) and boat (Linux guests in boat.dev's cloud), all three in production |
| Placement | the host a full ID or the profile names, or else the first host in the host list that offers the base |
| Profiles | client-side files: base, sizes, a setup script or recipe directory with its timeout, and an optional host |
| Setup and preparation | setup once at create; `/var/lib/clankerbox/machine-id` (clankercreds reads it), and `/etc/clankerbox/start` run after every activation |
| Access | per machine, the SSH endpoint `{host, port}` and the guest's SSH host public key |
| CLI | `hosts` (with their bases), `machines` (with each machine's age), `create NAME\|ID [--profile P] [--base NAME] [--cpu N] [--ram-mib N] [--disk-gib N] [--setup FILE\|DIR --setup-timeout SECONDS]`, `start`, `stop`, `delete`, `fork`, `checkpoint capture/list/get/delete`, `restore`, `ssh MACHINE [ssh args…]`; `--json`, `--timeout` |

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
- **Capacity accounting and its config:** the only checks are Tart's two-VM
  limit, smolvm's RAM budget (one sum and one setting) and boat's machine
  types. There are no capacity slots and no admission queue. boat enforces its
  account limits itself. Machine scopes limit each VM to its own RAM.
- **Labels:** machine labels, `SetLabels`, label filters on listings, and the
  `capabilities` string lists. Hosts carry no labels either; the base picks the
  host.
- **Guest-side machinery:** the guest daemon, sessions, `shell`, `sessions` and
  `guest`. Also the expected-machine-ID check on every connect, and every
  guest-side credential (host CA, per-epoch certificates, bindings).
- **TLS and the old auth:** TLS on any hop, PKI, the static bearer token, client
  certificates and Unix peer-credential checks.
- **Machine and checkpoint fields nobody reads:** `generation`,
  `accepted_generation`, `desired_state`, `prepared`, `observed_at`,
  `source_machine_id`, `runtime_pin` and duplicated host and profile fields.
  (`createdAt` stays.)
- **`machine.json`:** its `env` (setup writes the guest's environment) and
  `start.timeout_seconds` (preparation's own timeout replaces it).
- **CLI exit-code contract:** the codes 255/130/128+n. The CLI exits 0 or 1,
  except that an interrupt such as Ctrl-C exits 130, the shell's convention.
  The host role exits 0 when a signal stops it, as a unit's SIGTERM does, so
  consumers' units need no `SuccessExitStatus`.
  With `--json` a clankerbox error prints `{error: {message, tag, retryable}}`;
  a usage error prints effect/cli's usual output, and its non-zero exit is the
  contract. `ssh` exits with ssh's code.
- **Name lookup:** the CLI takes IDs, so there is no resolution by fan-out.
- **Host knobs:** `port_lease_root`, `port_min/max`, `dns`, `launchctl_path`,
  `launchd_domain`, `systemctl_path`, `tls_*`, `HostOS`, `ControllerID`, and
  `SystemdUser`/`LaunchdDomain`.
- **Unprivileged and macOS smolvm:** `systemd-run --user` jobs and lingering,
  launchd jobs per smolvm VM, home-directory smolvm paths and their socket-length
  limit. So Linux guests run only on a Linux host; a Mac runs macOS guests.
- **`dev`:** the one-command local host, with everything around it: the dev
  host under launchd/systemd, bundle relocation, sticky `--cpus`/`--ram-mib`,
  per-project state-dir hashing, `--listen`, the teardown journal and token,
  dev's private controller, `dev stop` and `dev destroy`, the owner marker file
  and the hashed runtime root. A consumer that wants a local host runs
  `clankerbox host` with its own config, listening on loopback.
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

### State and claims

- One owner lock for the process lifetime: a second host process on the same
  state dir refuses to start. The lock is SQLite's own: the host opens its
  database with `locking_mode = EXCLUSIVE` and holds the exclusive lock from
  its first transaction until it exits. The OS drops it when the process ends,
  so a crash leaves no stale lock to judge; the cost is that nothing else,
  `sqlite3` included, can read the database while the host runs.
- **One row per machine and per checkpoint,** with its spec, `instance`,
  `native`, `createdAt` and `action`. There is no operation log. A machine row
  also holds its host `port` (see [Guest access](#guest-access)) and `hostKey`,
  the key the last successful preparation printed. Checkpoint rows arrive with
  phase 4, as the second migration; phase 3 has no action that writes one.
- **Claims:** the store has one claim primitive: hold these rows, insert this
  one, return a token, in one SQLite transaction. A claimed row has
  `action.status = running`. A missing row is `NotFound`, one already running
  `Conflict{kind: busy}` and a taken new name `Conflict{kind: exists}` (the
  primary key's refusal), and then nothing is written. A claim can join an
  earlier token, so an action can claim in steps; `release(token)` (remove
  the inserted rows, put back each held row's last `action`) and
  `end(token, outcome)` each write every row of the token in one transaction.
  A release that fails is logged; its rows stay held until the next startup
  marks them failed.
  - Fork and capture claim their source first, then insert the new row into
    the same claim: a fork with the source's spec, a capture once it has read
    the source's state once for the kind. A host crash between the two leaves
    the source's action `failed` and no new row; that is accepted.
  - Fork and capture end with their outcome on both rows: the source's
    `action` reads `fork` or `capture`, `done` or `failed`, like the new row's.
    The host key preparation read goes on the new machine only.
  - A checkpoint row also keeps the source's host port at capture, which a
    `ram` restore comes up on, so the restore knows which port to swap
    without reading ports back from smolvm.
  - Ready checkpoints never change, so actions that only read them don't claim
    them, and restores of one checkpoint run in parallel. A restore whose
    checkpoint is deleted under it fails like any runtime failure.
  - Runtime state checks run after the claim, so nothing changes between the
    check and the use.
  - Ports are recorded in the same transaction (see [Guest access](#guest-access)).
  - The actions that boot a machine or allocate a port (create and start;
    fork and restore in phase 4) hold one permit, a `Semaphore`, across claim
    and check (steps 2–3). The RAM budget counts the machines that booting
    actions hold, so two checked at once would each count the other and both
    could be refused; one at a time, exactly one of two that fit only alone
    passes, and no two pick the same port.
- **No global native lock.** smolvm and Tart take their own locks. P12 found
  that smolvm CLI calls on different machines need no serializing, except the
  first use of a new prefix, which the install step settles (see
  [Runtimes: smolvm](#runtimes-smolvm)); so no semaphore serializes native
  calls.
- **The row comes before any native effect,** so that after a crash `delete` has
  something to own.
- **Native IDs:** machine and checkpoint rows have one `native` column that the
  runtime owns. boat keeps its sandbox ID or snapshot name there. smolvm and
  Tart derive native names from the name and the instance (see IDs and names
  under [API contract](#api-contract)) and leave it empty.
- **On host startup:** every `running` action becomes `failed` with "host
  restarted during <name>". The machine shows whatever the runtime reports,
  possibly `missing`. The smolvm forks area is wiped (see
  [Runtimes: smolvm](#runtimes-smolvm)).
- **Native errors** leave `action.status = failed`, and the same tagged error is
  the call's reply. Nothing is released without an explicit delete, so no
  failure needs a proof that it left nothing behind. The one exception is the
  refusal rule (see Synchronous mutations under [API contract](#api-contract)):
  errors that a runtime documents as creating nothing, listed per runtime.
- **No lineage:** a fork is an independent machine, so a source can be stopped
  or deleted while its forks run.
- **Stop and delete after a failure:** they are never refused because of an
  earlier failure, and they cope with leftover native state, including a live
  orphan VM process. They are refused only while another action holds the row.
  Each runtime's phase verifies this. Phase 3 verified it live on smolvm:
  after a host crash during setup, `stop` stopped the VM the create left
  running; after a crash before the runtime's create, `stop` wrote nothing;
  and `delete` removed both, and a VM whose stop failed.
- **A failed fork or `ram` restore leaves no VM:** smolvm makes the VM on the
  source's port and moves it to the new machine's own before the first boot,
  and `machine start` never re-applies ports, so a VM left between would
  publish on another machine's port. `start` can't repair it: `machine status
  --json` and `machine ls --json` report only a port count
  (S@1.22.2:src/cli/vm_common.rs:3102), so it can't know which port to remove,
  although `machine update` is idempotent (src/cli/machine.rs:5917-5929). So
  whatever fails in the restore's create, port move or first boot deletes the
  VM, reading status first like `delete`. The row stays `failed`, the machine
  reads `missing`, `start` says to delete it, and `delete` removes the row. A
  host crash inside that window can still leave a VM on the source's port;
  that is accepted. The fork's source ends `fork` `failed` like any fork's,
  which blocks nothing.
- **Completion is recorded even when the caller has gone away.**
- **Schema:** `PRAGMA user_version` and an ordered list of migrations, starting
  at version 1. A database newer than the binary is refused.

### Profiles and bases

- **A profile is a client-side file,** decoded with the Schema in
  `packages/contract`:
  - `base`: a base name;
  - `cpu`, `ramMib` and `diskGib`;
  - `setup`, optional: `{path, timeoutSeconds}`, where `path` is a script or
    a recipe directory. The timeout is part of the setup, so it can't be left
    out: the profile author sets it and records its reason; there is no
    default;
  - `host`, optional: the host ID to create on, instead of placement by base.
- **Profile files are JSON,** so the Schema decodes them with no parser dependency.
- **Hosts never see a profile.** The client library turns it into a create
  request, and the machine keeps only the name the client passes as its
  `profile` label. Editing a profile affects only machines created afterwards.
- **The host receives one script.** In the CLI, a profile's `setup.path` is
  relative to the profile file, and `--setup` to the working directory.
  - A file is sent as its text.
  - A directory holds a `setup.sh` and the files it needs, as existing
    recipes do with `files/`. The client library packs it into one
    self-extracting script: a base64 tar that unpacks into a temporary
    directory, then runs `setup.sh` from there. Stock Ubuntu, macOS and boat's
    image all have `base64` and `tar`.
  - The packer sets `COPYFILE_DISABLE=1` and passes `--no-xattrs`, so macOS
    `tar` adds no `._*` files and no provenance headers.
  - SDK clients pass a script's text or use the same packer.
  - A packed recipe can carry secrets, such as gg-linux-dev's clankercreds
    key. The host never stores a setup script.
  - **Nothing logs a setup script or a packed recipe:** not the client
    library, the host, nor any test or spike driver. A spike driver once logged
    a packed recipe with its key into run evidence. Errors and logs carry the
    script's output, never its text. The same holds for preparation, whose
    script carries a random seed.
- **A checkpoint holds everything the machine had,** including credentials its
  `start` synced. Capture a checkpoint meant for other machines from one that
  holds none, or clean up first.
- **Bases:** each host names its bases in config, mapping a name to an image,
  digest-pinned where the runtime allows. Hosts that offer the same image use
  the same name, and placement matches on it.
  - smolvm: a stock OCI image from Google's Docker Hub mirror, every base
    digest-pinned as
    `mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7`
    (`ubuntu:26.04` on 2026-10-04, the same digest as Docker Hub's). It has no
    sshd; setup installs it. On mirror.gcr.io neither the host's image-seed
    build nor a guest's own pull touches Docker Hub and its anonymous limit of
    100 pulls an hour per address (P12). The reference has no tag: smolvm
    can't parse tag plus digest and then pulls the image inside every guest
    (about 7 s per create), while `…/ubuntu@sha256:…` builds a host-side copy
    once and later creates take 1.36 s (P8).
  - Tart: a stock Cirrus image, `ghcr.io/cirruslabs/macos-<version>-base` or
    `macos-<version>-xcode:N` (with Xcode), pinned by digest. Both ship sshd
    and tart-guest-agent.
  - boat: boat's one image (Ubuntu 24.04, x86_64, with sshd, Docker and
    coding agents), which boat updates, so it can't be pinned. boat offers no
    26.04 image, so a profile on `ubuntu:26.04` doesn't land on boat. A boat
    host names its image apart from stock images. Sharing a name with a stock
    image is the operator's call, and works only if the profile's setup handles
    both.

### Setup and preparation

Both are host-side scripts run over `Runtime.exec`, which runs as root in the
guest (see [Other host rules](#other-host-rules)), as part of the action.

**Setup** runs once, at create, after the first boot and before preparation:

- It runs the create request's script with its timeout. A non-zero exit, or
  running past the timeout, fails the create, and the error carries the
  script's last lines of output. The machine stays, with
  `action.status = failed`, until `delete`.
- The script arrives on exec's stdin, so it never appears in a process list,
  and runs as its own file under `/var/tmp`, honouring its `#!` line, with
  stdin closed. An exit trap removes the file when the shell exits.
  - A setup killed by its timeout or by a host crash may leave its script, or
    a packed recipe's files, in the guest: smolvm SIGKILLs the guest command
    and every process descended from it, so no trap runs (phase 3, live).
    Nothing guards against that. Only Linux's reseed uses `perl`, so Tart
    guests don't need it.
- A failing or overrunning setup, `new-identity`, `start` or preparation fails
  the action with `Precondition`: the guest refused, not the host. The error
  carries the last 20 lines of the output, at most 4000 characters.
- Nothing runs setup again: `start` doesn't, and machines from fork or restore
  carry its results.
- A typical setup installs sshd and the operator's public key, sets the guest's
  environment, and writes `/etc/clankerbox/start`.
- On Linux, `/etc/environment` reaches ssh sessions only, through `pam_env`
  (P3). On macOS there is no `pam_env`; ssh sessions read `/etc/zshenv`.
  Either way `start`, and whatever it launches, runs under exec and must read
  the environment file itself.

**Preparation** is one script, shipped inside the host binary, run after every
create, start, fork and restore, in one exec. Its arguments are the row's
instance and the machine's ID, and a fresh 64-byte seed arrives on stdin. The
60 s timeout below covers the whole exec. In order:

1. **Identity.** Each machine row gets a random `instance` value when it is
   inserted. Compare `/var/lib/clankerbox/instance` with it. On a mismatch:
   - Reseed the guest's kernel RNG, before anything else. The host writes a
     fresh random seed into `/dev/random`, then, on Linux guests, issues
     `RNDRESEEDCRNG` (with `perl`, which stock Ubuntu ships as `perl-base`).
     Tart and boat guests cold-boot, so the seed write is enough there.
     macOS refuses writes to `/dev/urandom` and reseeds on a write to
     `/dev/random` (P3); Linux handles writes to both nodes alike, and P1
     tested `/dev/urandom` there. Phase 3 checked `/dev/random` live: the
     seed write and `RNDRESEEDCRNG` succeed as root in a smolvm guest.
     - Why: a RAM restore, and so a fork, clones the guest's CRNG, and the
       guest has no vmgenid or hwrng. smolvm's own re-mint only stirs the pool
       (S@1.22.2:src/fork.rs:3245-3250). Across restores of one RAM state, it
       gave 4 distinct host keys of 20, and a second `ssh-keygen -A` 5 of 7;
       with the reseed, 8 of 8 (P1).
     - It only fixes the kernel's RNG from then on. User-space generators
       seeded before the fork stay duplicated; a profile resets those in its
       `new-identity` hook.
   - Re-mint the SSH host keys, if the guest has any, on every runtime. A Tart
     clone, so also a machine restored from a Tart `disk` checkpoint, and a
     machine created from a base (keys from the image or from setup) need it. smolvm already re-mints on a `ram` restore, and so on
     a fork; doing it again there keeps preparation free of runtime cases and
     of a smolvm behaviour that every bump would have to re-check. P3 measures
     what it adds to a fork. On boat every activation is a new machine with
     new keys, so re-minting there is redundant but harmless.
   - Restart sshd if it is running. A sshd carried over in RAM can keep serving
     the old key until restarted (seen on OpenSSH 10.0).
     - The listener is `/run/sshd.pid`, checked against `/proc/<pid>/comm`
       for a stale pid file. It gets SIGHUP, which makes sshd re-execute
       itself with the new keys and keep its listener, under whatever
       launched it: a `start` script, or boat's systemd unit. macOS has no
       `/run/sshd.pid`; launchd starts sshd per connection.
     - Phase 3's live tests verified SIGHUP on a smolvm guest (OpenSSH on
       stock 26.04): after a re-mint under a running sshd, the listener kept
       its pid and served the new key, which equals `Machine.hostKey`.
   - Write `/var/lib/clankerbox/machine-id` (the ID).
   - Run `/etc/clankerbox/new-identity`, if the profile installed one. It
     resets per-machine state that the copy carried over, such as tailnet
     node state, so a fork or restore doesn't share it with its source. Like
     `start`, it must be idempotent; a non-zero exit fails the action.
   - Write the instance value **last**, so a crash before it repeats these
     steps.
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
     error carries the script's last lines of output. The timeout is 60 s: P3
     measured at most 0.55 s for re-mint plus an sshd restart, and at most
     1.52 s for a `start` that runs a successful clankercreds sync right after
     a cold start, so 60 s leaves room for a slow network.
   - Check for sshd's listener (`/run/sshd.pid`), not `pgrep -x sshd`: an open
     ssh session also matches `pgrep`, so a dead listener would never be
     relaunched.
   - `start` on a running machine runs preparation again. That is the repair
     path: it relaunches a dead sshd without a cold boot, which would lose the
     guest's RAM state. Re-running it takes about 50 ms.
   - The machine ID is written before `start` runs, because clankercreds reads it.
3. **Host key.** Print the SSH host public key, if there is one: ed25519,
   else ecdsa, else rsa, after a marker line. It becomes `Machine.hostKey`.

A crashed preparation is simply run again on the next activation; no
`prepared` flag is needed.

### Guest access

- **SSH only:** each machine exposes guest port 22 and nothing else. Other
  guest ports go through `ssh -L`. boat can also put a guest port on a public
  HTTPS URL itself (`POST /sandboxes/{id}/host`); nothing uses it.
- **smolvm:**
  - Every machine is created with `--net --net-backend virtio-net`, plus
    `-p hostPort:22`. `-p` alone doesn't turn on outbound access, and setup
    needs the network. TSI also serves `-p`, but checkpoints with published
    ports require virtio-net.
  - The VM job's environment sets `SMOLVM_PUBLISH_ADDR` (the host's tailnet
    address) and `SMOLVM_EGRESS_FLOOR=strict` explicitly. It also sets
    `SMOLVM_RESTORE_TMPFS=0`: only `machine pause`/`resume` stage memory in
    tmpfs, and clankerbox uses neither, but without `=0` every root restore
    still creates `/dev/shm/smolvm-restore` and leaves it. Restores cost the
    same either way (evidence.md, Restore tmpfs).
- **Port allocation** (smolvm and Tart; boat needs no host port):
  - The host picks one host port per machine from 10000–19999: below smolvm's
    fork range (20000–32000) and the Linux ephemeral range (32768 and up). It
    excludes the ports on its machine rows and confirms each one with a bind
    probe on the publish address. It takes the lowest such port, so
    allocation is deterministic.
  - Ports are picked and recorded with the action's claim, under the permit
    that admits one booting action at a time (see [State and
    claims](#state-and-claims)), so two actions can't take the same port. The
    unique index on the port is a backstop.
  - A `ram` restore, and so a fork, keeps the checkpoint's port: smolvm refuses
    topology flags when creating from a live checkpoint. The host allocates a
    new one and applies it with `machine update --remove-port … -p …` before
    start. To read ports back, use `machine ls -v` or the VM's
    `agent.config.json`; `machine status --json` reports only a count.
- **Tart:**
  - Tart has no port publishing, and the guest's Softnet address is reachable
    only from the Mac.
  - The host runs a forwarder, used only by Tart: for each running machine it
    listens on `publishAddress:hostPort`. Each accepted connection runs
    `tart exec -i <vm> nc 127.0.0.1 22`.
  - This needs no guest IP, no Softnet exception and no Local Network
    permission. A host that dials guest IPs needs a fresh Local Network grant
    for every new build, which would mean a manual step after every release.
  - Opening a connection adds about 0.29 s (P2). A host restart drops open
    Tart connections, whereas smolvm's listeners live in the VMM.
  - The forwarder ends a connection by closing the exec's stdin. A killed
    `tart exec` leaves the guest's `nc` and `sshd-session` running until the
    session next writes.
- **boat:** guest port 22 is reached at boat's SSH relay (see
  [Runtimes: boat](#runtimes-boat)), with no host port and no forwarder.
- **Security:** a published port is reachable by whatever garaba-home's tailnet
  policy lets reach the host, which denies by default: the operator's admin
  device, plus any rule that names the host. sshd's keys and the pinned host
  key are the protection. smolvm's strict floor and Softnet keep guests away
  from private ranges. The guest can still reach the host's public address, so
  production adds a firewall rule (see [Phases](#phases)). A boat machine's SSH
  relay is a public address, protected by sshd the same way, and boat guests
  have full outbound internet.

### Supervision

The smolvm CLI starts the VMM in the caller's cgroup, so without its own job a
host restart would kill every VM. boat runs its own machines and needs no
supervision. `Supervisor.launch(label, argv, env)` covers the other two
runtimes:

- **smolvm (Linux, root):** set `SMOLVM_VM_USE_SCOPE=1` on every `start`,
  including a restored machine's first start. Each VM gets its own
  `system.slice/smolvm-vm-<name>.scope` and survives its launcher. No
  `systemd-run` and no unit files. Verified for plain starts and restores.
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
  `HOME=/opt/smolvm/1.22.2 install.sh --version 1.22.2 --prefix /opt/smolvm/1.22.2 --no-modify-path`.
  With `HOME` at the prefix, the installer's `~/.local/bin` link and agent
  rootfs land inside it, and it doesn't refuse a prefix outside `HOME`. Host
  config points at that prefix.
  - The install also expands both disk templates beside their `.zst` files,
    `zstd -d --sparse <prefix>/X.zst -o <prefix>/X` for `storage-template.ext4`
    and `overlay-template.ext4`. smolvm would expand them on first use with no
    lock, and concurrent first starts destroyed both (P12, 6 of 6). Startup
    refuses a prefix without them.
  - At startup the host compares `smolvm --version` with the version this
    release was tested on, and refuses to start on a mismatch. It also refuses
    to run as anyone but root.
  - Every smolvm call sets `SMOLVM_AGENT_ROOTFS=<prefix>/.local/share/smolvm/agent-rootfs`:
    with `SMOLVM_DATA_DIR` set, smolvm moves `HOME` to the data dir and
    doesn't find it otherwise. The wrapper finds its libraries from the prefix.
  - smolvm looks for templates in `$SMOLVM_DATA_DIR/.smolvm` first, and a
    stale one there is used silently. Nothing of ours writes there.
  - Machines keep using their prefix (qcow2 backing files and the agent
    rootfs), so an old prefix stays until its last machine is deleted.
- **Inventory:** one smolvm inventory per host, placed by `SMOLVM_DATA_DIR` at
  `<stateDir>/smolvm`, with `HOME` set to it too. Machine names are unique per
  host, which the scope names need anyway. Socket paths are limited to 108
  bytes, so startup refuses a state dir whose control-socket path,
  `<stateDir>/smolvm/.cache/smolvm/vms/<16 hex>/control.sock`, would exceed
  107 (so the state dir itself is at most 52 bytes).
- **State:** read from `machine status --name X --json`. `running`, `pausing`,
  `unreachable` and `frozen` have a live VMM and read as `running`;
  `created`, `stopped`, `paused` and `failed` read as `stopped`; smolvm's
  "machine '<name>' not found" reads as `missing`.
- **Machines:** run from a digest-pinned OCI image, on smolvm's own 48 MiB agent
  rootfs (about 200 MiB of disk per machine).
  - Each VM runs as its own uid (2000000 and up), so guests can't write the
    shared agent rootfs.
  - Restores, and so forks, get a fresh uid, so no two machines share one.
- **RAM budget:** every create, start, fork and restore that boots a machine
  checks in step 3 that the host's machines fit its RAM budget, and refuses
  with `Capacity` when they don't. `start` on a running machine boots nothing
  and doesn't check.
  - The sum is the `ramMib` of every machine that is running or held by a
    running create, start, fork or restore, each counted once. The target is
    already held when step 3 runs, so it is in the sum. Booting actions are
    checked one at a time (see [State and claims](#state-and-claims)), so of
    two concurrent creates that each fit only alone, exactly one passes.
  - The budget is `ramBudgetMib` in host config. It defaults to physical RAM
    minus 2 GiB, for the OS and the host processes. P9's memory figures per
    restored machine show whether VMs need more headroom. Set it above
    physical RAM to overcommit on purpose.
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
  40–170 ms instead of 0.5–3 s (on this Mac, 1 vCPU / 1 GiB; 0.72–1.30 s on the
  Linux host as root, 2 vCPU / 2 GiB after package installs), and the source's
  resident RAM doesn't grow.
  Restored machines are branchable anyway. `machine status --json` reports
  `branchable: false` regardless, so don't read it.
- **Fork is a checkpoint plus a restore:** of a running source only; a fork of
  a stopped source is `Precondition` in step 3.
  1. Capture the running source into a store of the fork's own,
     `forks/<child native>/`.
  2. `machine create --from` that checkpoint.
  3. Swap the ports.
  4. Start and prepare.
  5. Remove `forks/<child native>/` whole.

  Step 5 runs whether the fork succeeded or failed (`Effect.ensuring`), and host
  startup wipes the forks area, since nothing is in flight then. No prune is
  needed: restored machines hold no reference into a store, and the restore
  cache is off. P9 confirms deleting a whole store under running children.

  The child continues the source's RAM state, gets a fresh identity and its own
  uid, and has no lineage. It took 1.6–2.4 s on this Mac (1 vCPU / 1 GiB,
  unprivileged) and 6.87–7.32 s on the Linux host as root (2 vCPU / 2 GiB, two
  samples; in the first, a 3.34 s capture and a 2.81 s create). The cost is
  disk: a restored
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
  - `delete` must still work on such a VM. It reads status first and touches
    nothing for a name smolvm doesn't know. When `machine stop` fails, delete
    kills the VM's scope (`systemctl kill --signal=SIGKILL
    smolvm-vm-<name>.scope`, the signal smolvm's own `kill_scope` uses), then
    runs `machine delete -f` (`-f` only skips the prompt), then `systemctl
    reset-failed` on the scope, since systemd keeps a failed scope until then.
    Phase 3 verified this live, on a guest whose frozen `/storage` made
    `machine stop` fail.
- **Checkpoints:** always `ram`, a running machine's RAM and disks; smolvm
  captures only running machines. A capture of a stopped machine is
  `Precondition` ("start it first"), read in step 3 like a fork's source.
  `disk` checkpoints (packs) were dropped in the phase-4 review: what is lost
  is a checkpoint that outlives a smolvm upgrade, which the pin below already
  refuses to restore. They live in the state dir: the one store at
  `<stateDir>/checkpoints/` (a checkpoint is `<native>.checkpoint` there), and
  fork stores under `<stateDir>/forks/<child native>/`. Startup makes the store
  and empties the forks area.
  - A store checkpoint (below). A restore continues the source's RAM state
    and keeps a RAM file (about 280–620 MiB) for its life.
  - **Pin:** a `ram` checkpoint records the smolvm version and the platform at
    capture (`smolvm 1.22.2 linux-x64`), and a restore under a different pin is
    refused with `Precondition`, writing nothing. The runtime names its pin; the
    core compares it. smolvm enforces sizes, platform, CPU contract and network,
    but not the engine build or the agent. The core keeps the pin check for
    `ram` checkpoints only: Tart's and boat's `disk` checkpoints have none.
  - **Capture:** smolvm publishes a checkpoint durably or not at all. After a
    crash, the host discards the interrupted capture, and `checkpoint-prune`
    removes the staging that smolvm marked. Partial RAM artifacts are never
    published.
  - **Store mode:** checkpoints go into one store per host (`--store`,
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
    a copy-on-write disk top (about 0.7 MiB of private disk). P9 measured store
    restores: still read-only RAM and copy-on-write tops, but each restore
    materializes the checkpoint privately, about 725 MiB of disk and 25 MiB of
    dirty memory plus page cache of its own RAM file per 1 GiB guest
    (evidence.md, Phase 4).
- **DNS:** no `DNS` knob. smolvm's gateway relays DNS, and smolvm refuses
  capturing a machine with custom DNS.
- **Disk sizing:** one disk-size field per machine (`diskGib`), passed as
  `--storage <diskGib>`; the overlay keeps smolvm's default. Workload writes
  land on the storage disk. Below the 20 GiB template smolvm uses host
  `resize2fs`, which Ubuntu hosts have; no compact templates (P8).
  - smolvm builds a host-side image seed only at the default 20 GiB
    (S@1.22.2:src/image_seed.rs:184-195). At any other size every first start
    pulls the image in the guest, from mirror.gcr.io like the seed (see
    Bases). smolvm's default seed behaviour is kept.

### Runtimes: Tart

- **Names:** native names carry the host ID, the kind and the instance:
  `cbx-<host>-m-<name>-<inst>` for machines and `cbx-<host>-c-<name>-<inst>`
  for checkpoints. Tart has one VM namespace, shared by both kinds, by the
  operator's own VMs and by every host process on the Mac, such as a test host
  beside the production one. The prefix keeps them apart, and listings filter
  on it.
- **Softnet:** `--net-softnet-block=@host`. Blocking `@host` also blocks gateway
  DNS, so setup sets public resolvers first.
- **Removed:** no `tart ip`, no `HOME=<root>` for tart (test the keychain when
  removing it), and no refusal to replace a live launchd job.
- **Clone:** `tart set --random-serial` once per clone. No `--random-mac`, since
  clone already regenerates a colliding MAC.
- **Trust Tart's clone:** it builds in a temp directory under a lock and
  garbage-collects interrupted clones. Since 2.40.1, clone refuses an existing
  destination, and the instance in the name means it never meets one. Never
  pass `--overwrite`.
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
  the refusal writes nothing. Apple's own refusal is the backstop when two
  starts race: it maps to `Capacity` too, but the clone that a create, fork or
  restore has already made then stays, with `action.status = failed`, like any
  other failure from step 4. P11 checks what that refusal looks like.
- **Guest agent:** stock Cirrus images run tart-guest-agent ≥ 0.15.0 as a
  per-user LaunchAgent, which starts after auto-login. Tart's `Runtime.exec`
  waits for `tart exec` to answer after boot, then runs its command through
  `sudo -n`. A base without passwordless sudo fails the create loudly. On
  `macos-tahoe-base` the agent is 0.15.0, `admin` has passwordless sudo, and
  exec first answered 18.5–32.3 s after `tart run` (P3), so the wait allows a
  minute. The forwarder calls `tart exec` directly,
  since `nc` needs no root.

### Runtimes: boat

- **The service:** boat.dev runs Linux sandboxes (x86_64 VMs) in its cloud.
  - The host calls boat's HTTP API v1 directly, with Effect's HTTP client and
    Schemas for the endpoints it uses. It uses no boat SDK or CLI.
  - Host config holds a boat API key.
  - The account must be past boat's trial. The trial forces auto-stop
    within 2 hours, allows 2 sandboxes and no `large` type, and a
    subscription stays on it until its first payment.
- **Every create, fork, resume and restore** sends:
  - `noEnv: true`, so no account secrets, GitHub token or model logins reach
    the guest. The guest still gets a boat token confined to itself.
  - `ttlSeconds: null`, so boat never stops it on a timer. A fork otherwise
    defaults to one hour.

  Snapshots stay on: stop, resume, fork and checkpoints depend on them.
- **IDs:** boat assigns sandbox IDs (`bx_…`), kept in the row's `native`
  column. Create, fork and restore send an `Idempotency-Key` derived from the
  row's `instance` value, so a repeat within boat's 24-hour key window returns
  the original.
  - An unclear outcome of the call (a dropped connection, a 5xx) is retried
    inside the action, with backoff and the same key and body, for up to 5
    minutes: long enough to ride out a brief outage, and far inside the key
    window. Then the action fails.
  - A row without its sandbox ID (that failure, or a host crash before the ID
    was recorded) is `failed` like on any runtime, and `delete` removes only
    the row. A sandbox may exist. boat's create takes no name or tag and a
    sandbox echoes nothing the client chose, so look on the dashboard for an
    unrenamed `Box <time>` sandbox created around the row's `createdAt`.
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
  12 GiB) to `xlarge` (16 vCPU, 32 GiB, 251 GiB, from the $100 plan).
  - The host picks the smallest type that covers `cpu`, `ramMib` and
    `diskGib`, and the machine reports that type's sizes.
  - A request that no type covers is refused with `Precondition` in step 3.
- **Refusals:** none of these leaves anything on boat, so all of them fall
  under the refusal rule and remove the row:
  - 429 (`limit_reached`, `rate_limited`, `daily_limit_reached`);
  - 403 for a type the account's plan doesn't include
    (`trial_machine_class_not_allowed`, `machine_class_plan_required`);
  - 409 `named_snapshot_limit`, for an 11th checkpoint;
  - a create or fork that ends in state `cancelled` when boat finds no
    machine.

  They map to `Capacity`. Every call waits for a machine; none sends
  `failFast`, whose 503 `no_ready_machine` only helped placement move on.
- **Ready:** boat reports `ready` before its lazy restore has finished.
  - `/var/lib` and `/var/opt` are restored in full before boat's marker
    `/var/lib/ascii-lazy/sys-done` appears: a few seconds after ready with
    little data there, 10–14 s with 1 GiB. Enabled units start after that.
  - Preparation writes `/var/lib/clankerbox/`, so after a fork, start or
    restore the runtime also waits, over exec, for that marker. A fresh create
    is not a restore, has no marker, and doesn't wait.
  - The marker is undocumented. boat's documented signal, the
    `sandbox.hydrated` webhook, can't reach a host on the tailnet. Ask boat
    for a documented one, and re-check the marker at every change of boat's
    API or image.
  - Files under `/home/user`, `/etc`, `/usr`, `/opt`, `/root` and `/srv` are
    there at ready but fetched on first read. 2 GiB in `/home/user` took
    24–277 s to read after a restore.
- **Exec:** SSH as `user`, through `sudo -n`.
  - The host owns one ed25519 key, generated at init, and authorizes it with
    `POST /sshkey` after create. Forks, resumes and restores carry it in
    `/home/user/.ssh/authorized_keys`.
  - ssh joins argv into one string, so the runtime quotes it.
  - Before its first SSH to a new activation, the host reads the guest's host
    keys through boat's command API, over HTTPS, and pins them. After
    preparation, the pin is `Machine.hostKey`. `POST /sshkey`'s reply also
    carries a `hostKey`; P14 checks whether it is the current activation's,
    which would make the command-API read unnecessary.
  - boat's command API is not the exec: it takes no stdin and caps a call at
    600 s. An SSH session has neither limit.
  - Each exec opens its own SSH connection, about 0.3 s. There is no shared
    connection to keep alive.
- **Endpoints:** guest port 22 is reached at boat's `sshEndpoint`, a public IPv4
  relay, or at `ip:22` when the machine has an IPv4 address of its own.
  - Host and port change on every start, so the host reads them with the
    state and never stores them.
- **Fork:** a fork of a running machine would come from boat's last background
  snapshot, which can be a minute old.
  - So the host first syncs the guest's filesystems and notes the time. It
    waits until a snapshot attempt that began after that time has completed
    (41 s with little new data, 102 s after writing 3 GiB), then forks.
  - The source keeps running, and a stopped source forks at once.
  - Forks carry the disk only, never RAM.
- **Checkpoints** are boat named snapshots, always `disk`, from a running or a
  stopped machine. Capture takes about two minutes from a running machine and
  0.2–21 s from a stopped one.
  - A restore creates a sandbox `from` the snapshot.
  - Named snapshots don't depend on their source and survive its deletion.
  - Names are account-wide, so the host uses `cbx-<host>-<inst>`.
  - boat keeps at most 10 per account. An 11th is refused with 409
    `named_snapshot_limit`, which is `Capacity`.

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
  - boat's sshd accepts root with a key, so setup can authorize the
    operator's key for root. `/etc/environment` reaches SSH sessions. boat's
    image already uses systemd-resolved; smolvm's rule against it doesn't
    apply here.

### Other host rules

- **One exec per runtime:** `Runtime.exec(machine, argv, stdio)` runs as root in
  the guest. Each runtime gets there its own way: smolvm's exec already runs as
  root, and Tart's and boat's add `sudo -n`. Setup and preparation have no
  runtime cases.
- **State dir:** the host's SQLite database is its only marker. Init creates
  the database in one transaction and leaves other files in the directory
  alone, as a mount point holds `lost+found`: `application_id` refuses a
  foreign database, and the owner lock a second host. There is no separate
  marker file and no temp-directory rename.
  - The database is `host.db`, marked with `PRAGMA application_id` `0x63627868`
    ("cbxh"). An empty `host.db`, as a crash during init leaves, is
    initialized; any other SQLite file under that name is refused.
- **Host config:** one JSON file, read from `clankerbox host --config PATH`.
  There is no default path: units pass it.
  - It holds `id`, `runtime`, `listen: {address, port}`, `stateDir` (relative
    to the config file), `bases` (name to image) and the runtime's own
    settings, for smolvm `smolvm: {prefix, publishAddress?, ramBudgetMib?}`.
    Unknown keys are refused, as in every input.
  - `listen.address` and `publishAddress` must be a tailnet address
    (100.64.0.0/10 or fd7a:115c:a1e0::/48, Tailscale's ranges:
    tailscale.com/kb/1015, kb/1033) or a loopback address. The tailnet is the
    API's only gate, so a wildcard or public address is refused.
  - `publishAddress` defaults to `listen.address`.
  - `ramBudgetMib` defaults to `os.totalmem()` in MiB minus 2048.
  - The runtime comes from a registry keyed by `runtime`; each runtime module
    adds its entry.

## CLI

- **`clankerbox ssh MACHINE [ssh args…]`:** looks up the machine's `ssh`
  endpoint and host key, writes a one-line known-hosts file, then execs the
  system `ssh`. Ports change on fork and restore, and on boat the host and port
  change on every start, so typing them by hand isn't practical.
- **IDs:** every command takes IDs. `create NAME` is placed and prints the new
  ID; `create ID` goes to the host the ID names.
- **`create`:** `--profile` takes a path to a profile file, or a name looked up
  in the profiles directory from client config, and passes the profile's name
  as the machine's `profile` label. The flags merge with the profile by
  top-level field: `--base`, `--cpu`, `--ram-mib` and `--disk-gib` each
  override the profile's, and `--setup FILE|DIR` with `--setup-timeout`
  replaces the profile's setup as a unit. One of those two alone is
  `Invalid`, with or without a profile. The merged spec is decoded once, which
  reports a missing base or size.
- **Shared options:** `--json` and `--timeout`. A mutation returns when its
  action has finished; `--timeout` only stops waiting.
- **Client config:** one file holding the host list, in placement order, and
  an optional profiles directory.
  - It is JSON, so a Schema decodes it with no parser dependency.
  - It is read from `--config PATH`, or else from
    `$XDG_CONFIG_HOME/clankerbox/config.json` (`~/.config` when that is unset).

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
Every live run uses `scripts/work_runs.py`. Phases 3–6 build the runtimes in
slices, end to end through the CLI: smolvm in two, then Tart, then boat. Unit tests use a fake runtime layer; live
tests use real VMs.

0. **Spike.** Run spikes P1, P2, P3, P5 and P8. If P1 fails, change guest access
   to the fallback in [Spikes](#spikes) before phase 2.
1. **Scaffold.** The root workspace, catalog, lint and CI. Scaffold the
   `apps/clankerbox` role dispatcher and the SEA build for both targets, with a
   hello world per role.
2. **Contract and CLI.** Schemas, the tagged errors, `<host>_<name>` IDs, the
   action groups, the profile file schema, the client library (host list,
   routing, fan-out with partial results, placement by base, recipe packing),
   and the CLI's commands and `ssh`. Long mutation calls: the client's timeouts
   off.
3. **smolvm, end to end.** Until phase 4, `fork` and `restore` answer
   `Precondition`, and the checkpoint group isn't mounted: effect-actions
   needs a handler for every action of a group it serves, and serves only the
   groups it is given.
   - The state table, claims, the error-reply invariant and the refusal rule,
     the schema version, lifecycle, the smolvm runtime, supervision, setup and
     preparation (with the `new-identity` hook), port allocation and
     publishing, the RAM budget, bases and the runtime in config, and listening
     only on the tailnet address.
   - `stop` and `delete` after an interrupted operation, including a crash
     between inserting the row and calling the runtime, and `delete` of a VM
     whose stop failed.
   - Spike P12. Live tests on Linux, through the CLI.
4. **smolvm checkpoints and fork.** `ram` checkpoints and fork. Spike P9.
5. **Tart.** The runtime, its names, the forwarder and the two-VM count.
   `stop` and `delete` after an interrupted operation. Spike P11. Live tests
   on the Mac. Freeze the `Runtime` interface only after this slice.
6. **boat.** The runtime, the machine-type choice, its refusals and its
   bounded retry. `stop` and `delete` after an interrupted operation. Spike
   P14. Live tests against boat.
7. **Release and live tests.** `tools/release` (SEA, bundle, notices) and the
   full `tests/live`. Then the README design section and the bump skills
   (seeded from evidence.md).
8. **Cut over.**
   - Cut-over waits until every API consumer runs on the new SDK, or the
     operator accepts that consumer's downtime.
   - Run the full live acceptance suite on Apple Silicon (Tart), on
     Linux/amd64 with KVM (smolvm as root), and against boat on an account
     past its trial.
   - Release.
   - Publish the SDK major.
   - Delete these plans in the last commit before the merge.
9. **Redeploy production,** from garaba-home, which replaces personal-cloud:
   - Destroy the 0.11.0 machines and checkpoints on both hosts, and the
     controller.
   - Move the hosts onto the tailnet if not already done.
   - Delete the clankerbox WireGuard link, the PKI and the UniFi rule.
   - In garaba-home's `access.ts`, replace the controller rule (`tag:apps` to
     `tag:agent-host` on 8444, for the controller's mTLS identity) with the host
     API ports (two on the Linux host, one on the Mac), opened to the clients
     that call hosts. A client other than the admin device that runs
     `clankerbox ssh` also needs the published range, 10000–19999. Drop the
     clankerbox controller from the compute node's apps. Its PLAN.md has the
     controller minting tailnet keys for elevated agent profiles. With no
     controller, guests join the tailnet only when a profile does it: an
     elevated profile carries a tagged, reusable, ephemeral pre-authorized key,
     which expires within 90 days and is rotated by hand. Its `start` joins the
     tailnet, never its setup, and its `new-identity` hook removes the tailnet
     node state, so every fork and restore joins as a new node.
   - Install smolvm 1.22.2 from upstream under `/opt/smolvm/1.22.2` on the Linux
     host, and Tart ≥ 2.40.1 on the Mac.
   - Run the smolvm host as root: system units, and host state out of
     `/home/clanker`. As root, smolvm adds others-execute to every directory
     above its data root.
   - **Change the egress guard before any guest runs:** `meta skuid 1000` becomes
     `meta skuid 2000000-101999999`, smolvm's per-VM uid range, for IPv4 and
     IPv6 alike. Until then, a guest can reach services on the host's public
     addresses: in P1 guests reached root-owned listeners on both, and the
     host's sshd on :22.
   - `SMOLVM_RESTORE_TMPFS=0` needs no deploy step: the host sets it on every
     smolvm call (see Guest access).
   - Add a boat host: a second host process on the Linux host, unprivileged,
     with host ID `boat`, its own state dir, and a boat API key on an account
     past its trial. Any always-on machine on the tailnet would do; the Linux
     host is already deployed and reachable, so this needs no image or proxy,
     only its port in the hosts' access rule. Nothing backs that machine up, so
     a lost boat database leaves its sandboxes to be found by display name and
     deleted by hand.
   - Check the smolvm host's RAM budget against everything else that runs
     there.
   - Configure each host's bases: a digest-pinned stock `ubuntu:26.04`
     (`mirror.gcr.io/library/ubuntu@sha256:…`) on Linux;
     digest-pinned Cirrus base and Xcode images on the Mac; boat's image on the
     boat host.
   - Rewrite the profiles as profile files next to their recipes: `linux-dev`
     and `mac-xcode` in personal-cloud, `gg-linux-dev` in the local
     `clankerbox-profiles` directory, and `cliamp-dev` in cliamp-verify.
     `clankerbox-profiles` is not a git repository, and `gg-linux-dev/files/`
     holds its clankercreds key, so it stays a local directory on the operator's
     machine. Each profile has a base, sizes, and a setup script or recipe
     directory that installs sshd and the operator's key, sets the guest's
     environment (`gg-linux-dev`'s `env` moves there; P3 checks the paths), and
     writes an idempotent `/etc/clankerbox/start` that daemonizes what it
     launches. Recipes keep their `files/`; `machine.json` goes.
     `gg-linux-dev` installs `libatomic1` first: Node needs it and stock 26.04
     lacks it (P3).
   - Update the consumers' docs: `clankercreds/docs/recipe.md`, which still
     documents `machine.json`, and cliamp-verify's `clankerbox.md`, where
     `shell -T` becomes `ssh MACHINE -- cmd`, `create` takes the `cliamp-dev`
     profile file, and `profile publish`, `logs` and `operation` are gone.
10. **Clean up the test machines,** following
    [Test machine footprint and final cleanup](#test-machine-footprint-and-final-cleanup).

## Spikes

The ones already done, with numbers, are in evidence.md: S3 (exec transport), S4
and its 26.10.0 re-run (SEA), the stock-image test (including `pack` and host
keys), the ESTALE and fork-state runs on Linux, root mode on Linux, fork as
checkpoint + restore on this Mac and on Linux as root with restore tmpfs, on
1.22.2 the `machine branch` depth limit and fork through the checkpoint store,
and the three boat runs on a trial account.

### Phase 0

| Spike | Gates |
| --- | --- |
| **P1. Published ports on the tailnet.** On the Linux host as root (ask for approval first): a stock-image machine with `-p` on the tailnet address and `SMOLVM_EGRESS_FLOOR=strict`, then ssh, scp and rsync from another tailnet machine. Also over the tailnet: a fork (store checkpoint + restore) and two restores beside a running source, each with its swapped port and new host key, all under `SMOLVM_VM_USE_SCOPE=1` and on 1.22.2. Loopback and `127.0.0.2` already work, and restores under scopes do too. Then, from inside a guest, try the host's API port on the tailnet, public and loopback addresses, and confirm each is refused. | guest access, or its fallback; the tailnet as the only gate |
| **P2. Tart forwarder.** Listener → `tart exec -i` → guest `nc 127.0.0.1 22`: ssh and rsync throughput, idle survival, and whether accepting on the tailnet interface needs Local Network permission. | guest access on Tart |
| **P3. Setup and preparation.** Setup on a stock `ubuntu:26.04` image over plain exec (the earlier stock-image runs used 24.04 and 25.10): installing openssh-server with `--no-install-recommends` and a key, and how long it takes. On a current Cirrus image: how long until `tart exec` answers after boot, with no manual login, and does `sudo -n true` succeed? On smolvm, does a child started with `setsid -f` outlive the exec (sshd's own daemonizing already does)? Re-mint on Tart clones and on machines restored from a pack, and the time a second re-mint adds to a smolvm fork. How do ssh sessions and daemonized processes pick up the guest's environment (`/etc/environment` through PAM)? How long does a realistic `start` (sshd plus a clankercreds sync) take, to set its timeout? Re-running `start` on a running smolvm machine already works. How long does gg-linux-dev's real setup take, which decides whether a setup cache is ever worth adding? | setup, preparation, Tart bases |
| **P5. Pins.** Smoke-test effect-actions 0.9.0 on Effect 4.0.0 inside a SEA, including one unary call that runs past 300 s, to find any timeout of its own. | phase 1, long calls |
| **P8. Disk sizing and install.** Which disk holds workload writes for a stock-image machine? Do sizes above or below smolvm's 20/10 GiB templates need host `resize2fs`? Can machines drop the overlay size and the compact templates? With smolvm installed under a prefix, does a stale `~/.smolvm` shadow its templates, and does the upstream wrapper find its libraries? | disk sizing, smolvm install |

**Fallback if P1 fails:** no published ports. `clankerbox pipe MACHINE PORT`
carries bytes over `Runtime.exec` into the guest's `nc`, used as an ssh
`ProxyCommand`. clankerbox then sits in the data path, which needs a streaming
call next to the unary ones. smolvm's `--expose-socket` is the other fallback.

### Phases 3–6

| Spike | Gates |
| --- | --- |
| P12 (phase 3). Concurrent smolvm CLI calls on different machines in one inventory: do any need serializing? | a semaphore around those calls |
| P9 (phase 4). Restores as root. A store-mode `ram` restore: does it still share RAM read-only and use a copy-on-write disk top, as single-file restores did? Private disk and memory per restored machine with `--restore-cache-entries 0`. Then delete a fork's whole store while its children run. A `disk` restore: `create --from` a pack with `--net` and `-p`, its disk per machine, and the re-mint. | checkpoint and fork cost, fork cleanup (smolvm `disk` checkpoints, since dropped) |
| P11 (phase 5). Tart's own refusal of a third VM: a fast refusal, or a hang until timeout. | the capacity backstop |
| P14 (phase 6). boat past its trial (after the subscription's first payment): `ttlSeconds: null` on create, fork, resume and restore, and a `large` create. Whether `POST /sshkey`'s `hostKey` is the current activation's. The rest of P14 ran on the trial (evidence.md). | boat's auto-stop, the host-key read |

## Test machine footprint and final cleanup

Everything the rewrite creates on a test machine is removed when the work ends.

- **Machines:**
  - this Apple Silicon Mac: Tart, and smolvm for the earlier spikes;
  - `ssh clanker@37.27.63.112`: Linux/amd64 with KVM. This is the production
    personal-cloud Linux host. `clankerbox-host.service` (user unit) runs there
    and is never touched. Each root-mode run (`sudo`, system units, uids outside
    the owned root) needs the user's approval first;
  - the operator's boat.dev account, still on boat's trial. Runs record every
    sandbox ID and named snapshot as they create it, and their teardown
    deletes them. A deleted sandbox answers 404 at once, while boat's deletion
    operation purges its data later.
- **One owned root per machine:**
  - Linux: `~/clankerbox-rewrite/`. Never touch `~/clankerbox`, its service, its
    VMs or its smolvm state, and never restart `user@1000`.
  - Mac: this worktree's `.work/`, which `.gitignore` excludes.
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
  - boat: no sandboxes and no named snapshots. boat's deletion operations for
    the runs' sandboxes purge their data on their own, within hours.
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
  - placement: a create landing on the first host in list order that offers
    its base, a full ID sending it to a named host, and no host offering the
    base replying `Precondition` with each host's bases;
  - the refusal rule: boat's refusals (its account limit) leaving no row;
  - a native resource that already carries a machine's name (a VM or VM
    directory named like an earlier row) left alone by that machine's create
    and `delete`;
  - setup running once at create, and a failing or overrunning setup failing the
    create with its output;
  - a recipe directory with `files/` packed and run as one script;
  - a real recipe (gg-linux-dev) through a create, then a stop and a cold
    start, with ssh and its services working after each;
  - a profile with `host` creating on that host, whatever placement by base
    would pick;
  - a `new-identity` hook running on create, fork and restore and not on
    `start`, and a failing hook failing the action;
  - a guest refused when it calls its own host's API port;
  - a guest refused when it calls 100.100.100.100, which its host reaches,
    and the host's routes to the tailnet unchanged by running machines. The
    case of another tailnet peer follows from the strict floor's CGNAT rule
    (S@1.22.2:crates/smolvm-network/src/egress.rs:205-213): every tailnet
    IPv4 address is in 100.64.0.0/10, which the floor refuses as a
    destination, as it does fc00::/7, which holds Tailscale's IPv6 range
    (egress.rs:228-229). Live, a guest was refused the host's own tailnet
    address, 100.100.100.100 and the host's ULA IPv6 address (evidence.md, P1
    over the tailnet and Phase 4 live), so the suite has no peer check;
  - smolvm's RAM budget refusing with `Capacity`, and of two concurrent
    creates that each fit only alone, exactly one passing;
  - RAM fork, `ram` checkpoint capture, restore and delete on smolvm, a
    capture of a stopped smolvm machine refused with `Precondition`, and
    `disk` checkpoints on Tart;
  - on boat:
    - a stop and start that bring a new endpoint and host key;
    - a fork of a running machine that holds a file written just before the
      fork;
    - a checkpoint captured from a running machine and restored after its
      source is deleted;
    - preparation finding `/var/lib/clankerbox/` from before a start;
    - `delete` replying once boat answers 404;
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
    file, wiping the forks area, and Tart's forwarded endpoints coming back
    after the forwarder restarts;
  - `stop` and `delete` after an interrupted operation on every runtime;
  - a mutation whose client disconnects still finishing and recording its
    outcome, and a call that runs past 300 s replying normally;
  - a duplicate name refused with `Conflict{exists}`, and a second action on a
    claimed machine refused with `Conflict{busy}`;
  - Tart's two-VM limit refused with `Capacity` before any clone, with nothing
    written;
  - list fan-out with one host down and `--json` error tags, which the unit
    suite covers against the real host process over the fake runtime
    (`apps/clankerbox/tests/host.test.ts`) rather than live.
- Every live run goes through `scripts/work_runs.py`, following AGENTS.md.
  It runs `clankerbox host` from its own config, like any consumer.
