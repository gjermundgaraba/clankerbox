# clankerbox

clankerbox runs machines (VMs) for coding agents and reports where each one is
reachable over SSH.

- Lifecycle: create, start, stop, delete, fork, checkpoint capture and restore.
- Three runtimes: smolvm (Linux guests on a Linux host, with RAM forks and RAM
  checkpoints), Tart (macOS guests on a Mac, with disk copies) and boat (Linux
  guests in boat.dev's cloud, with disk forks and checkpoints).
- Clients talk to hosts directly; there is no controller. A client holds a host
  list, and a create goes to the first host in it that offers the requested
  base, unless the request names a host.
- A profile is a client-side file: a base, sizes, a setup script and,
  optionally, a host. Hosts store no profiles.
- Each machine exposes only guest port 22, reported as a `host:port` with the
  guest's SSH host key. Anything done inside a guest goes through the sshd its
  setup installs.
- Hosts and clients share a Tailscale tailnet, and its policy is the only gate:
  the API has no keys and no TLS.

One `clankerbox` binary is both the CLI and the host (`clankerbox host`). The
TypeScript SDK, `@gjermundgaraba/clankerbox-sdk`, holds the contract and the
client library the CLI uses.

## Install

Releases are on the repository's GitHub releases page,
<https://github.com/gjermundgaraba/clankerbox/releases>, tagged `v<version>`.
Each release has one bundle per target, `clankerbox-<version>-<target>.tar.gz`,
beside its `.sha256`. The targets are `darwin-arm64` and `linux-x64`. A bundle
holds, with no top directory:

- `clankerbox`, a Node single-executable binary (Node 26.10.0 inside; nothing
  else to install);
- `LICENSE`, clankerbox's own;
- `notices/node/LICENSE` and `notices/npm/`, the licenses of Node and of every
  production npm dependency.

Download a bundle and its `.sha256` into one directory, and check the bundle
against it before extracting it: the `.sha256` holds `<sha256>  <bundle name>`,
which `shasum -a 256 -c` (macOS) and `sha256sum -c` (Linux) check.

```sh
base=https://github.com/gjermundgaraba/clankerbox/releases/download/v1.0.0
curl -fLO "$base/clankerbox-1.0.0-linux-x64.tar.gz"
curl -fLO "$base/clankerbox-1.0.0-linux-x64.tar.gz.sha256"
shasum -a 256 -c clankerbox-1.0.0-linux-x64.tar.gz.sha256   # or sha256sum -c
mkdir clankerbox && tar -xzf clankerbox-1.0.0-linux-x64.tar.gz -C clankerbox
clankerbox/clankerbox --version
```

The darwin binary is ad-hoc signed and not notarized, which a curl, tar or scp
install doesn't need. The binary ignores `NODE_OPTIONS`.

The release ships no runtime. Each host needs its own, installed by the
operator (see [Runtime notes](#runtime-notes)):

| Runtime | Host                    | Prerequisite                                                         |
| ------- | ----------------------- | -------------------------------------------------------------------- |
| smolvm  | Linux/amd64 with KVM    | smolvm exactly 1.22.2, upstream, in a versioned prefix; runs as root |
| Tart    | Apple Silicon, macOS 26 | Tart 2.40.1 or later, Softnet 0.24.0 installed SUID root             |
| boat    | either, unprivileged    | a boat.dev API key                                                   |

At startup a smolvm host refuses any smolvm but the one it was tested on, and a
Tart host any Tart older than 2.40.1.

## Quick start

### Run a host

A host process runs one runtime, from one JSON config file
(`packages/host/src/config.ts`). Two runtimes on one machine are two host
processes, each with its own ID, state dir and port.

```json
{
  "id": "linux",
  "runtime": "smolvm",
  "listen": { "address": "100.64.0.10", "port": 8484 },
  "stateDir": "state",
  "bases": {
    "ubuntu": "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7"
  },
  "smolvm": { "prefix": "/opt/smolvm/1.22.2" }
}
```

- `id` matches `^[a-z][a-z0-9-]{0,31}$`. It is the host part of every ID the
  host holds, so keep it short (`linux`, `mac`).
- `listen.address` must be a tailnet address (100.64.0.0/10 or
  fd7a:115c:a1e0::/48) or loopback; a wildcard or public address is refused.
  `listen.port` must lie outside 10000–19999, the machines' range.
- `stateDir` is relative to the config file. It holds the database and the
  runtime's own state; one host process owns it at a time.
- `bases` maps the names clients ask for to images. Hosts that offer the same
  image should use the same name: placement matches on it.
- Runtime settings, one block named after the runtime:
  - `smolvm: {prefix, publishAddress?, ramBudgetMib?}`; `ramBudgetMib`
    defaults to physical RAM minus 2 GiB;
  - `tart: {binary, publishAddress?}`, `binary` being the `tart` executable of
    a versioned install, such as `/opt/tart/2.40.1/tart.app/Contents/MacOS/tart`;
  - `boat: {apiKey}`.

  `publishAddress` defaults to `listen.address`. Unknown keys are refused.

```sh
clankerbox host --config /etc/clankerbox/linux.json
```

There is no default config path: a unit passes it. A smolvm host runs as root
(a system unit); a Tart host as the operator's user, in its GUI session, since
its VMs are LaunchAgents in `gui/<uid>`; a boat host unprivileged. The host
exits 0 when a signal stops it, so a unit needs no `SuccessExitStatus`.

### Use the CLI

The client config is one JSON file, `$XDG_CONFIG_HOME/clankerbox/config.json`
(`~/.config` when that is unset), or `--config PATH`:

```json
{
  "hosts": [
    { "id": "linux", "url": "http://100.64.0.10:8484" },
    { "id": "mac", "url": "http://100.64.0.20:8484" }
  ],
  "profiles": "profiles"
}
```

The host list is in placement order. `profiles`, relative to the config file,
is where `--profile NAME` finds `NAME.json`; a `--profile` value with a `/` or
ending in `.json` is a path. A profile file:

```json
{
  "base": "ubuntu",
  "cpu": 2,
  "ramMib": 4096,
  "diskGib": 20,
  "setup": { "path": "dev", "timeoutSeconds": 900 }
}
```

`setup.path`, relative to the profile, is a script or a recipe directory (a
`setup.sh` and the files it needs). Its timeout is required. An optional
`host` sends every create from the profile to that host instead of placing
it. The file's name, without `.json`, becomes the machine's `profile` label.

```sh
clankerbox hosts                           # every host, its runtime, versions and bases
clankerbox create dev --profile dev        # placed; prints the new ID, linux_dev
clankerbox create mac_review --base macos --cpu 4 --ram-mib 8192 --disk-gib 60
clankerbox create scratch --profile dev --setup ./other.sh --setup-timeout 300
clankerbox machines                        # every host's machines, with their age
clankerbox ssh linux_dev -- -l root
clankerbox stop linux_dev
clankerbox start linux_dev
clankerbox fork linux_dev dev2             # linux_dev2
clankerbox checkpoint capture linux_dev base
clankerbox checkpoint list
clankerbox restore linux_base dev3         # linux_dev3
clankerbox delete linux_dev3
clankerbox checkpoint delete linux_base
```

- Every command takes IDs, `<host>_<name>`, except `create`, which takes a
  name (placed) or a full ID (sent to that host).
- `create` flags override the profile's fields one by one; `--setup` with
  `--setup-timeout` replaces its setup as a unit, and one without the other is
  refused.
- `ssh` writes a one-line known-hosts file pinning the machine's host key and
  runs the system `ssh` with strict checking. The destination is the machine's
  ID, so `-l USER` or a `Host` block in `~/.ssh/config` picks the user; other
  ports go through `-L`. For scp or rsync, take `ssh` and `hostKey` from
  `clankerbox machines --json`.
- A mutation returns when its action has finished. `--timeout SECONDS` only
  stops waiting: the action runs on, and the CLI says it may have run.
- `--json` prints the resource, or `{"error": {"message", "tag", "retryable"}}`.
  Lists print what reachable hosts answered and name the unreachable ones.
- The CLI exits 0 or 1, 130 on Ctrl-C, and `ssh` with ssh's code. Deleting
  something already gone exits 0.

`clankerbox COMMAND --help` documents each command.

## SDK

`@gjermundgaraba/clankerbox-sdk` (`packages/contract`) holds the Schemas, the
action groups, the errors, the profile file schema and the client library. It
is versioned with the binaries: SDK 1.2.3 talks to hosts of release 1.2.3.
`effect` and `@effect/platform-node` `^4.0.0` are peer dependencies, so an app
has one copy of Effect and Schema identity holds.

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client, readSetup } from "@gjermundgaraba/clankerbox-sdk";
import { Console, Effect } from "effect";

const program = Effect.gen(function* () {
  const client = yield* Client.Client;

  // A name is placed on the first host that offers the base; "linux_dev" would name the host.
  const machine = yield* client.create("dev", {
    base: "ubuntu",
    cpu: 2,
    ramMib: 4096,
    diskGib: 20,
    setup: { script: yield* readSetup("recipes/dev"), timeoutSeconds: 900 },
  });

  yield* Console.log(machine.id, machine.ssh, machine.hostKey);

  const { answers, unreachable } = yield* client.machines;

  yield* Console.log(answers.length, unreachable);
}).pipe(Effect.catchTag("Capacity", (error) => Console.error(`no room: ${error.message}`)));

program.pipe(
  Effect.provide(Client.layer([{ id: "linux", url: "http://100.64.0.10:8484" }])),
  Effect.provide(NodeServices.layer),
  Effect.runPromise,
);
```

- `Client.layer` runs over Node's `http` module, which sets no timeout, so a
  create with a long setup isn't cut off. `Client.make` takes the app's own
  `HttpClient` instead; one over `fetch` gives up on a reply after 300 s, and
  `NodeHttpClient.layerUndici` after an hour.
- `readSetup` sends a file as its text and packs a directory into one
  self-extracting script (`packRecipe`). `loadProfile` reads a profile file.
- Every call but the lists fails with one of seven tagged errors
  (`errors.ts`), each with `retryable`; see [Errors](#errors). A list returns
  what reachable hosts answered and names the unreachable ones with their
  errors.
- A mutation whose reply is lost fails `Unavailable`, not retryable, naming
  the resource: it may have run, so read it to see. Nothing retries for you.

## Design

The code is the reference; each part below names where it lives. The design
rests on one rule for every dependency it wraps (smolvm, Tart, boat, Node,
Effect, effect-actions). Before building a mechanism around it, and again at
every bump of it:

1. Does the dependency already track this? Don't duplicate its bookkeeping.
2. Are we deleting its files or managing its processes, and so owning proofs
   it doesn't need?
3. Every layout choice, limit and timeout carries a recorded reason, in a
   comment beside it.
4. Our comments are not evidence: check each claim against the dependency's
   source or docs at the pinned version.
5. A bump re-checks that dependency's claims, not just the tests. The bump
   skills in `.agents/skills/` (`bump-smolvm`, `bump-tart`, `bump-boat-api`,
   `bump-node`) carry each one's claims with their source lines.

### Architecture

- **Clients** (`packages/contract/src/client.ts`) hold the host list.
  `create` is placed; every other call names an ID and is routed by its host
  part, without the network. Lists fan out to every host and return partial
  results. There is no name lookup and no client-side state beyond config and
  profile files.
- **A host** (`packages/host/src`) owns everything durable for its machines:
  machine and checkpoint rows, and their ports. Machine state (`running`,
  `stopped`, `missing`) is always read from the runtime, never stored. A
  machine and its checkpoints stay on the host that made them.
- **One runtime per host process**, behind the `Runtime` interface
  (`runtime.ts`), picked by the config's `runtime` from the registry in
  `runtimes.ts`. State, claims, setup and preparation are shared; fork,
  checkpoint and access are each runtime's. A new provider is a new runtime
  module behind its own host.
- **No clankerbox code runs in a guest.** Setup and preparation are host-side
  scripts over the runtime's exec.
- **The API** (`packages/contract/src/api.ts`) is unary HTTP through
  effect-actions: machine, checkpoint and host action groups under `/api`.
  Input is closed: undeclared fields are refused, and a Schema error in input
  is `Invalid`.

### IDs and names

- Every machine and checkpoint ID is `<host>_<name>` (`packages/contract/src/ids.ts`).
  A host ID matches `^[a-z][a-z0-9-]{0,31}$`; a name matches
  `^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$` (no `--`, no trailing `-`, which
  smolvm refuses in native names). Neither has `_`, so an ID splits at its one
  `_`, and a `create` target with `_` is a full ID.
- The whole ID matches `^[A-Za-z0-9_-]{1,62}$` because it is written to
  `/var/lib/clankerbox/machine-id`, and clankercreds, which reads it as the
  machine's audit-log label, accepts only that pattern. The host validates
  every new ID, including one a raw HTTP caller sends.
- Names are unique per host and resource type. Reusing a name is a
  `Conflict{kind: "exists"}`; there are no idempotency keys.
- **Native names carry the row's instance**, a random hex value each row gets
  at insert (`packages/host/src/ids.ts`); `<inst>` is its first 8 characters.
  smolvm VMs and their scopes are `<name>-<inst>`; Tart VMs
  `cbx-<host>-m-<name>-<inst>` and checkpoints `cbx-<host>-c-<name>-<inst>`;
  boat named snapshots `cbx-<host>-<inst>`. So a native resource left by an
  earlier row with the same name never carries the new row's name, and
  `delete` only removes what its row could have made.
- Bases have names, not IDs. Each host names its bases in config.

### Placement

Only `create` is placed (`client.ts`, `place`). A full ID, or else the
profile's `host`, sends it to that host. Otherwise the client reads every
host's bases in parallel and picks the first host in list order that offers
the base, skipping hosts that don't answer. Whatever that host replies,
`Capacity` included, is the reply; placement never moves on. With no host
offering the base the reply is `Unavailable` if some host didn't answer, and
otherwise `Precondition` listing each host's bases. Fork, restore, start, stop
and delete go to the host of the resource they name: nothing migrates.

### Actions

Every mutation replies when its action has finished, with the resource as it
is afterwards or a tagged error. Each runs in this order (`actions.ts`):

1. Validate the input.
2. Claim the rows, inserting the new row.
3. Check runtime state: the runtime's `admit` (Tart's two-VM count, smolvm's
   RAM budget, boat's machine types), a base the host doesn't offer, a
   machine that was never made.
4. Only then call the runtime.

- **An error before the first runtime call writes nothing:** the claims are
  released, an inserted row removed, and a held row gets its last `action`
  back.
- **The refusal rule:** a runtime error the runtime knows created nothing
  native (a `Refusal` in `runtime.ts`) is handled the same way. Each runtime
  documents its list: a fork or capture source in a state it doesn't copy,
  Tart's forwarder failing to listen on a new port, and boat's limit, capacity
  and plan refusals.
- **Any other runtime error** leaves the row with `action.status = failed` and
  the same error as the reply. Nothing native is released without an explicit
  `delete`, so no failure needs a proof that it left nothing behind. `delete`
  and `stop` are never refused for an earlier failure, only while another
  action holds the row, and `delete` copes with any leftover native state.
- **Actions outlive their request.** Each runs in a fiber of a `FiberSet` that
  lives as long as the host, so a dropped connection never interrupts native
  work, and the outcome is recorded either way.
- **`made`:** a machine row is made once its create (with setup), fork or
  restore has done its native work, before preparation. Until then `start`,
  `fork` and `capture` refuse it with `Precondition`, so a half-made machine
  never boots; it can be read, stopped and deleted. A failure only in
  preparation leaves the machine made, and `start` repairs it.
- **`action: {name, status, error?}`** is a resource's one record of work: its
  last action, `running` while held, `failed` with the error, or `done`. A
  checkpoint is ready once its action is `done`. A `stop` that does nothing
  writes nothing.
- `start` on a running machine runs preparation again (the repair path) and
  `stop` on a stopped one does nothing. `delete` of a missing resource is
  `NotFound`, which clients treat as done.
- Ready checkpoints never change, so restores read them without a claim and
  run in parallel.

### Errors

Seven tags (`packages/contract/src/errors.ts`): `Invalid`, `NotFound`,
`Conflict{kind: exists | busy}`, `Precondition` (the request can't apply as
things are; also a guest script that failed), `Capacity` (no room: Tart's two
VMs, smolvm's RAM budget, boat's account limits), `Unavailable` (the client
couldn't reach a host) and `Internal`. `retryable` follows the tag: `busy` and
`Capacity` retry; `Unavailable` retries for reads only, since a mutation's
request may have reached the host. In the client, a request that fails to
encode is `Invalid` and sends nothing; a reply that fails to decode is
`Internal`.

### State and claims

- **SQLite through `node:sqlite`**, one database per host,
  `<stateDir>/host.db` (`store.ts`). `PRAGMA application_id` (`cbxh`) refuses
  a foreign database, and an ordered migration list on `PRAGMA user_version`
  refuses one newer than the binary. Other files in the state dir are left
  alone.
- **The owner lock is SQLite's own:** the host opens the database with
  `locking_mode = EXCLUSIVE` and holds it until it exits, so a second host on
  the same state dir refuses to start and a crash leaves no stale lock. The
  cost: nothing else, `sqlite3` included, can read the database while the host
  runs.
- **One row per machine and per checkpoint:** spec, `instance`, `native` (the
  runtime's own column, such as boat's sandbox ID), `createdAt`, port, host
  key, `made` and `action`. No operation log, no setup script.
- **Claims** are single transactions: `hold` an existing row or `insert` a new
  one; a held row is `running`, so a second action on it is
  `Conflict{kind: busy}`. Fork and capture hold the source, then insert the new
  row under the same token, and end with the outcome on both rows.
- **One admission permit** (a `Semaphore` in `machines.ts`) covers claim and
  check for every action that boots a machine or allocates a port, so two
  boots never count each other or pick the same port. Native calls themselves
  aren't serialized: smolvm and Tart take their own locks.
- **The row comes before any native effect**, so after a crash `delete` has
  something to own.
- **At startup** (`startup.ts`) every `running` action becomes `failed` ("host
  restarted during …"), then the runtime does its own startup work, before the
  API listens.

### Setup and preparation

Both run over `Runtime.exec`, as root in the guest (`guest.ts`).

- **Setup** runs once, at create, after the first boot. The script arrives on
  stdin, so it never shows in a process list, and runs as its own file under
  `/var/tmp` with its `#!` line and stdin closed. A non-zero exit or overrun
  fails the create with `Precondition` and the output's last 20 lines (at most
  4000 characters). Nothing runs setup again; forks and restores carry its
  results.
- **Recipes** are packed by the client (`packages/contract/src/setup.ts`) into
  one script: a base64 tar that unpacks into a temporary directory and runs
  `setup.sh` there. The packer leaves out macOS `._*` files and xattrs.
- **Nothing logs a setup script, a packed recipe or the preparation seed:** not
  the client, the host, nor any test. Recipes can carry secrets. Errors carry a
  script's output, never its text.
- **Preparation** is one script inside the binary, run after every create,
  start, fork and restore, in one exec with a 60 s timeout. Its arguments are
  the row's instance and the machine ID; a fresh random seed comes on stdin.
  1. Identity, when `/var/lib/clankerbox/instance` differs from the row's:
     write the seed into `/dev/random` and, on Linux, issue `RNDRESEEDCRNG`
     (a RAM fork clones the guest's CRNG); re-mint the SSH host keys if there
     are any; SIGHUP the sshd in `/run/sshd.pid` so it serves the new keys;
     write `/var/lib/clankerbox/machine-id`; run `/etc/clankerbox/new-identity`
     if the profile installed one; write the instance last, so a crash repeats
     the step. The instance, not the ID, is compared, because names are
     reused.
  2. Run `/etc/clankerbox/start`, if present, on every activation, and wait
     for it.
  3. Print the SSH host public key (ed25519, else ecdsa, else rsa), which
     becomes `Machine.hostKey`.

  A failed preparation is simply run again by the next `start`.

- **The guest's contract**, for profile authors:
  - Setup installs sshd and keys, sets the guest's environment and writes
    `/etc/clankerbox/start`.
  - `start` is idempotent, daemonizes whatever it launches (`setsid -f`, or
    launchd on macOS) and exits 0 once the machine's services are up. It
    relaunches sshd if `/run/sshd.pid` is dead (not `pgrep`, which matches
    open sessions). Per-machine syncs, such as clankercreds, go here: it runs
    after every fork and restore.
  - `new-identity` resets per-machine state the copy carried over (tailnet
    node state, user-space RNG seeds); it must be idempotent too.
  - `start` and `new-identity` run under exec, not a login, so they read the
    environment file themselves. On Linux `/etc/environment` reaches ssh
    sessions through `pam_env`; on macOS ssh sessions read `/etc/zshenv`.

### Guest access

- **SSH only.** smolvm publishes guest port 22 on a host port, Tart reaches it
  through the host's forwarder (`forwarder.ts`), and boat through its own
  relay. `clankerbox ssh` pins the reported host key.
- **Ports** (`ports.ts`), for smolvm and Tart: one per machine, the lowest
  free port in 10000–19999 (below smolvm's fork range and the Linux ephemeral
  range), confirmed with a bind probe on the publish address and recorded with
  the claim; a unique index backs it up. Forks and restores get their own.
  The host refuses an API port inside the range, so a tailnet policy can open
  10000–19999 to the clients that run `clankerbox ssh`.
- **Security:** a published port is reachable by whatever the tailnet policy
  lets reach the host; sshd and the pinned key protect it. smolvm's strict
  egress floor and Softnet keep guests off private ranges, the floor the
  tailnet's too, but it doesn't block the host's public addresses, so no host
  service may listen on one. A guest must not reach its own host's API port.
  boat guests have full outbound internet, and their SSH relay is public.

### Supervision

The smolvm CLI starts the VMM in its caller's cgroup, so without its own job a
host restart would kill every VM. Each runtime supervises its own:

- smolvm: `SMOLVM_VM_USE_SCOPE=1` on every start puts each VM in its own
  `smolvm-vm-<name>.scope`, with no unit files.
- Tart: one launchd job per VM (`tart.ts`), with its plist and log in the
  state dir's `launchd/`, rewritten at every boot.
- boat runs its own machines.

Every VM job references only smolvm or tart at their versioned install paths,
never the clankerbox binary, so a release leaves running VMs alone and a
runtime upgrade goes into a new prefix. Never set `SMOLVM_BOOT_BINARY`: it arms
a parent-death watchdog.

### Deliberately absent

Each was in the Go implementation (on `main`) or proposed, and has no real
consumer: a controller and its queues and reservations; idempotency keys,
operations and `--async`; host-side profile builds and stored profiles;
machine and host labels; a guest daemon, sessions and `shell`; TLS, PKI and
bearer tokens; the `dev` command; shipping smolvm or a Linux image pipeline;
rewind to an earlier generation; a setup cache (capture a checkpoint of a
set-up machine instead); name lookup. A feature used only by tests or docs
doesn't count as a consumer.

## Accepted cases

These are known, not guarded, and accepted:

- A host crash between claiming a fork's or capture's source and inserting the
  new row leaves the source's action `failed` and no new row.
- A release or end of a claim that fails is logged, and its rows stay `running`
  until the next host start; meanwhile the RAM budget counts them as booting.
- A setup killed by its timeout or a host crash may leave its script, or a
  packed recipe's files, in the guest's `/var/tmp`: smolvm SIGKILLs the command
  tree, so no trap runs.
- A create whose setup failed, or a fork or restore whose native work failed,
  can't be repaired with `start`: delete it and make it again.
- A restore whose checkpoint is deleted under it fails like any runtime
  failure.
- A checkpoint holds everything the machine had, credentials its `start`
  synced included. Capture one meant for other machines from a machine that
  holds none.
- The reseed fixes the kernel RNG only. User-space generators seeded before a
  fork stay duplicated until the profile's `new-identity` resets them.
- A lost reply isn't resolved: the caller reads the resource.
- smolvm: a setup that installs `systemd-resolved` makes every later
  `machine start` fail (an upstream bug); nothing checks for it.
- smolvm: a stale template in `<stateDir>/smolvm/.smolvm` would be used
  silently; nothing of ours writes there.
- Tart: a `diskGib` below the base's disk fails the create at `tart set`, after
  the clone, with `Precondition`; the unmade machine can only be deleted.
  Nothing checks it before the claim: `tart get` doesn't read OCI references.
- Tart: the two-VM count sees only the host's Tart home and counts the
  operator's Linux VMs there too. Apple's own refusal is the backstop; when two
  starts race it maps to `Capacity` too, but a clone already made stays,
  `failed`.
- Tart: a port the forwarder can't listen on at startup is logged and that
  machine's endpoint goes unserved until a stop and start; the rest of the host
  serves. A host restart drops open forwarded connections, and a killed
  `tart exec` leaves the guest's `nc` and `sshd-session` until the session next
  writes.
- Tart: replacing a held launchd job that runs another tart isn't verified
  live; if its bootstrap fails the start fails, and the next start bootstraps
  it.
- boat: a row without a sandbox ID (a failed or interrupted create) is deleted
  as a row only; a sandbox may exist. Look on the dashboard for an unrenamed
  `Box <time>` sandbox near the row's `createdAt`. Likewise a lost boat host
  database leaves its sandboxes to be found by display name (the machine ID).
- boat: the ready marker `/var/lib/ascii-lazy/sys-done` is undocumented;
  re-check it at every change of boat's API or image.
- boat: a `start` of a machine boat still makes or resumes skips the resume,
  and its preparation fails until boat reads the sandbox up.

## Runtime notes

### smolvm

- **Install** upstream smolvm with its own installer into a versioned prefix,
  then expand both disk templates beside their `.zst` files (smolvm expands
  them lazily with no lock, and concurrent first starts destroyed both). The
  host refuses a prefix without them.

  ```sh
  HOME=/opt/smolvm/1.22.2 install.sh --version 1.22.2 --prefix /opt/smolvm/1.22.2 --no-modify-path
  for t in storage-template.ext4 overlay-template.ext4; do
    zstd -d --sparse /opt/smolvm/1.22.2/$t.zst -o /opt/smolvm/1.22.2/$t
  done
  ```

  Machines keep using their prefix, so an old one stays until its last machine
  is deleted. The host refuses to start unless it is root and
  `smolvm --version` is the tested one (`testedVersion` in `smolvm.ts`).

- **Environment** (`smolvm.ts`): every call gets the same one,
  `SMOLVM_DATA_DIR` and `HOME` at `<stateDir>/smolvm` (one inventory per
  host), `SMOLVM_AGENT_ROOTFS` in the prefix, `SMOLVM_PUBLISH_ADDR`,
  `SMOLVM_EGRESS_FLOOR=strict` and `SMOLVM_RESTORE_TMPFS=0` (otherwise every
  root restore leaves `/dev/shm/smolvm-restore`).
- **State dir:** at most 52 bytes, so the control socket path fits Linux's
  108-byte limit; startup checks it.
- **Machines** run a digest-pinned OCI image with
  `--net --net-backend virtio-net -p <port>:22` and `--branchable`, each as its
  own uid. Reference the base by digest only, from `mirror.gcr.io` (avoids
  Docker Hub's anonymous pull limit; smolvm's own mirror setting breaks
  `machine start`): a tag plus a digest makes smolvm pull inside every guest. The stock image has no sshd;
  setup installs it. Install packages with `--no-install-recommends`.
- **Disks:** `diskGib` is `--storage`, where workload writes land. smolvm
  builds its host-side image seed only at the default 20 GiB; other sizes pull
  the image in the guest on first start.
- **State** comes from `machine status --name X --json`, at most 8 at once.
  smolvm's exit codes are trusted: no polling around calls.
- **RAM budget** (`ram-budget.ts`): every boot checks that running and booting
  machines' `ramMib` fit `ramBudgetMib`, else `Capacity`. Set it above
  physical RAM to overcommit on purpose.
- **Fork** is a checkpoint of the running source into a store of its own,
  `create --from` it, a port swap (`machine update --remove-port … -p …`),
  start, then the store is removed whole, whatever happened. The child
  continues the source's RAM, with a fresh identity and no lineage. A failed
  fork or `ram` restore stays unmade for `delete`, since its VM may still hold
  the source's port.
- **Never call `machine branch`:** each branch adds a backing layer to the
  source (smolvm refuses the 33rd), and a cold-restarted source with a kept
  branch child reads `frozen` and refuses stop and delete.
- **Checkpoints** are always `ram`, of a running machine, in one store per host
  (`<stateDir>/checkpoints/`, `--history 0` so deletes free space, restore
  cache off). A checkpoint records `smolvm <version> <platform>`, and a restore
  under another pin is refused. A restored machine keeps its own RAM file for
  its life.
- **Stop** is `machine stop` only; a guest that doesn't confirm its flush stays
  running and the stop fails, rather than risk lost writes. **Delete** reads
  status, stops gracefully, then SIGKILLs the VM's scope if it is still loaded,
  which also ends a VMM that smolvm reads as stopped, then runs
  `machine delete -f` and `systemctl reset-failed`.

### Tart

- **Softnet:** VMs run with `--net-softnet-block=@host`, which also blocks
  gateway DNS, so setup sets public resolvers. Tart sets Softnet's SUID bit
  only from a terminal, never under launchd, so install it first:
  `sudo install -o root -g wheel -m 4755 softnet /usr/local/bin/softnet`.
- **Jobs** run `tart run --no-graphics --net-softnet-block=@host <vm>` with a
  fixed `PATH` (holding `/usr/local/bin` and `/opt/homebrew/bin`), `HOME` and
  the host's `TART_HOME` if set. Each boot waits up to three minutes for
  `tart exec` to answer, retrying, since the guest agent starts after
  auto-login.
- **Bases** are stock Cirrus images (`ghcr.io/cirruslabs/macos-<version>-base`
  or `-xcode`), pinned by digest. They ship sshd, tart-guest-agent and
  passwordless sudo for `admin`; exec runs through `sudo -n`, so a base
  without it fails the create.
- **Clones** get `tart set --random-serial` and the sizes; Tart rounds
  `diskGib` up to whole GB and only grows a disk. Never `--overwrite`.
- **Fork and capture need a stopped machine** (our rule); checkpoints are
  `disk` clones.
- **Capacity:** Apple runs two macOS VMs per Mac, the operator's included. Each
  boot counts `tart list` plus machines being booted and refuses with
  `Capacity` at two.
- **Stop** runs `shutdown -h now` in the guest, then `tart stop --timeout 0`
  after a minute, and waits for `tart list` to read it stopped. **Delete**
  forces a running VM off, then boots out its job.
- **The forwarder** listens for each machine from its create until its delete,
  whatever its state, and carries each connection over
  `tart exec -i <vm> nc 127.0.0.1 22`: no guest IP, no Softnet exception and no
  Local Network permission. A new connection costs about 0.3 s.
- If the Mac's application firewall is on, the binary needs an "Allow incoming
  connections" entry, and each release's new binary asks again.

### boat

- **API:** boat's HTTP API v1 directly (`boat-api.ts`), no boat SDK or CLI. The
  API key is held `Redacted` from decoding on and travels only as the bearer
  token; errors carry method, path, status and boat's code and message, never
  a request or body, and are scrubbed of the key.
- **Designed for boat's trial:** two active sandboxes, auto-stop within two
  hours, no `large` type. Every create, fork, resume and restore sends
  `noEnv: true` (no account secrets in the guest) and `ttlSeconds: 7200`.
- **Bases:** boat's one image (Ubuntu 24.04, x86_64, with sshd), which boat
  updates, so it isn't pinned and the base's image value is only a label. Name
  it apart from stock images unless every profile on that name handles both.
- **Sizes:** the smallest of `small`, `default`, `large` and `xlarge` that
  covers the request; none is `Precondition`, and a type the plan lacks is
  boat's 403, a `Precondition` refusal.
- **Retries:** create, fork and restore carry an `Idempotency-Key`
  (`clankerbox-<host>-<instance>`), and an unclear outcome is repeated for
  5 minutes with backoff from 1 s to 30 s. A refusal that answers a repeat
  isn't trusted as a refusal: the row stays `failed`. Resume takes no key and
  is never repeated.
- **Refusals** that leave nothing on boat remove the row: 429s and 503
  `out_of_capacity`/`no_ready_machine` are `Capacity`, as is 409
  `named_snapshot_limit` (boat keeps 10 named snapshots per account).
- **State** is a `GET` of each recorded sandbox, never a list; a failed read
  fails rather than reading `missing`. The SSH endpoint changes at every start
  and is only reported for a running machine.
- **Ready:** after a fork, start or restore the host waits for boat's
  lazy-restore marker before preparation writes `/var/lib/clankerbox/`.
- **Exec** is SSH as `user` with `sudo -n`, one connection per exec, with the
  host's own key (`<stateDir>/boat-ssh/id_ed25519`, authorized after create)
  and the guest's host keys read through boat's command API and pinned per
  connection.
- **Fork** syncs the guest, then waits for a boat snapshot begun after the
  sync; forks carry the disk only. **Checkpoints** are named snapshots
  (`disk`), from a running or stopped machine, and outlive their source.
- **Stop** never passes `force`, which drops writes since the last snapshot;
  a stop boat refuses keeps the machine running and is the error.
- **Setup rules:** state that must survive a stop, fork or checkpoint lives
  under `/home/user`, `/etc`, `/usr`, `/opt`, `/srv`, `/root`, `/var/lib` or
  `/var/opt`. Leave boat's sshd, `user`'s `authorized_keys`, TCP 8911 and its
  WireGuard tunnel alone.

## Repository layout

| Path                   | Contents                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/clankerbox/`     | The binary: the CLI commands, `ssh`, and the `host` role                                        |
| `packages/contract/`   | The SDK: Schemas, action groups, errors, IDs, the profile schema, recipe packing and the client |
| `packages/host/`       | The host: state, claims, actions, setup and preparation, ports, and the three runtimes          |
| `tools/release/`       | The SEA build, bundles with their notices, and the smoke test                                   |
| `tools/oxlint/`        | The anti-slop lint plugin, vendored from upstream                                               |
| `tests/live/`          | Live acceptance suites per runtime, with their drivers                                          |
| `scripts/work_runs.py` | Disposable build and test runs ([WORK_RUNS.md](scripts/WORK_RUNS.md))                           |

## Development

Node 26 and pnpm 12, through vite-plus (`vp`):

```sh
pnpm install
vp check                # format, lint and type-check
vp run -r test          # unit tests, over a fake runtime and a fake boat
vp run -r build
vp run ready            # all three; CI runs it
```

Release builds (`tools/release`, on the Node `.node-version` pins, its archives'
checksums in `release-inputs.json`):

```sh
pnpm build
pnpm sea:build [darwin-arm64|linux-x64]   # build and bundle; darwin needs macOS
pnpm sea:smoke tools/release/dist/clankerbox-<version>-<target>.tar.gz
```

CI (`.github/workflows/quality.yml`) runs `ready` and builds, bundles and
smokes both targets, on pull requests and on pushes to `main` and release tags.
A release tag `v<version>` that names the SDK's version runs the release
(`.github/workflows/publish-sdk.yml`): it builds, bundles and smokes both
targets again, uploads the bundles and their `.sha256` files to the tag's
GitHub release, then publishes the SDK to npm with provenance (see
[Releasing](#releasing)).

The live suites drive real hosts through the binary, one per runtime
(`pnpm live:smolvm`, `live:tart`, `live:boat`). See
[tests/live/README.md](tests/live/README.md) for what each needs and what it
covers. Every disposable build or live run goes through
`scripts/work_runs.py`, following [AGENTS.md](AGENTS.md).

## Releasing

The binaries and the SDK share one version, the SDK's, in
`packages/contract/package.json`.

1. Set that `version` to `X.Y.Z` and merge to `main`; wait for its CI to pass,
   since nothing gates the release on it.
2. Tag the merge commit `vX.Y.Z` and push the tag:
   `git tag vX.Y.Z <commit> && git push origin vX.Y.Z`.

The tag runs `.github/workflows/publish-sdk.yml`, which refuses a tag that
doesn't name the version, uploads both bundles and their `.sha256` files to the
`vX.Y.Z` GitHub release, then publishes `@gjermundgaraba/clankerbox-sdk@X.Y.Z`
from the `npm` environment. A failed run can be re-run: the upload replaces the
release's files.

Before the first release, the repository's owner checks two settings:

- npm's trusted publisher for `@gjermundgaraba/clankerbox-sdk` names this
  repository, the workflow `publish-sdk.yml` and the environment `npm`;
- the `npm` environment's protection rules: required reviewers, if any, and
  deployments limited to `v*` tags, so only a release tag can publish.

## License

MIT, see [LICENSE](LICENSE). Release bundles also carry Node's license and
every bundled npm dependency's under `notices/`.
