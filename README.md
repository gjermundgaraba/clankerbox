# clankerbox

clankerbox runs machines (VMs) for coding agents and reports where each one is
reachable over SSH.

- Lifecycle: create, start, stop, delete, fork, checkpoint capture and restore.
- Two kinds of host: `linux`, Linux guests on a Linux host under smolvm, with
  RAM forks and RAM checkpoints, and `mac`, macOS guests on a Mac under Tart,
  with disk copies.
- Clients talk to hosts directly; there is no controller. A create goes to the
  first host in the client's list that offers the requested base, unless it
  names a host.
- A profile is a client-side file: a base, sizes, a setup script and,
  optionally, a host. A prebuild is a checkpoint of a machine whose setup has
  run, which later creates of the same profile restore.
- Each machine exposes only SSH, reported as a `host:port` with the guest's
  host key. A host can also join its machines to the tailnet, each as its own
  node, so their ports are reachable there.
- Hosts and clients share a Tailscale tailnet, and its policy is the only gate:
  the API has no keys and no TLS.

One `clankerbox` command, the npm package `@gjermundgaraba/clankerbox`, is both
the CLI and the host (`clankerbox host`). The TypeScript SDK is
`@gjermundgaraba/clankerbox-sdk`.

## Install

The package needs Node 26 or later, and bundles everything else it runs.

```sh
npm install --global @gjermundgaraba/clankerbox
clankerbox --version
```

Each host needs its kind's runtime, installed by the operator:

| Kind  | Host                    | Prerequisite                                                         |
| ----- | ----------------------- | -------------------------------------------------------------------- |
| linux | Linux/amd64 with KVM    | smolvm exactly 1.31.1, upstream, in a versioned prefix; runs as root |
| mac   | Apple Silicon, macOS 26 | Tart 2.41.1 or later, Softnet 0.24.0 installed SUID root             |

smolvm, with both disk templates expanded beside their `.zst` files:

```sh
version=1.31.1
prefix=/opt/smolvm/$version
HOME=$prefix install.sh --version $version --prefix $prefix --no-modify-path
for t in storage-template.ext4 overlay-template.ext4; do
  zstd -d --sparse $prefix/$t.zst -o $prefix/$t
done
```

Softnet, for Tart: `sudo install -o root -g wheel -m 4755 softnet /usr/local/bin/softnet`.

## Run a host

A host process runs one kind from one JSON config file:

```json
{
  "id": "linux",
  "kind": "linux",
  "listen": { "address": "100.64.0.10", "port": 8484 },
  "stateDir": "state",
  "bases": {
    "ubuntu": "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7"
  },
  "linux": { "prefix": "/opt/smolvm/1.31.1" }
}
```

- `id` is short and lowercase (`linux`, `mac`); it starts every ID the host
  holds.
- `listen.address` is a tailnet address or loopback.
- `stateDir`, relative to the config, holds the database. Keep it with its
  host ID and kind; the host refuses a config that names others. On linux
  it is at most 52 bytes and outside every home directory, such as
  `/srv/clankerbox/smolvm`.
- `bases` maps names clients ask for to images, pinned by digest. Hosts
  offering the same image should use the same name.
- The kind's block: `linux: {prefix, ramBudgetMib?}`, smolvm's install, or
  `mac: {binary}`, the `tart` executable of a versioned install.
- `machinePorts: {first, last}`, optional, is the range machines' SSH ports
  come from, 10000–19999 by default; `listen.port` lies outside it.
- `tailnet: {oauthClient: {id, secret}, tags}`, optional, joins the host's
  machines to the tailnet (see below). The client needs the `auth_keys` scope
  and the tags; its secret never leaves the host.

```sh
clankerbox host --config /etc/clankerbox/linux.json
```

The host exits 130 on SIGINT or SIGTERM and 1 when it fails.

### Upgrading from 0.20

0.21 reads no 0.20 state dir, and logs in to machines of either kind as
`admin`. For each host:

1. While it still runs 0.20, delete its machines and checkpoints
   (`clankerbox delete`, `clankerbox checkpoint delete`) until
   `clankerbox machines` and `clankerbox checkpoint list` show none of its
   own, then stop it. 0.21 never reads a VM it leaves, which keeps running:
   on mac, `tart stop` then `tart delete` each in `tart list` named
   `cbx-<host ID>-…`; on linux, `systemctl stop` each of
   `systemctl list-units 'smolvm-vm-*.scope'` named
   `smolvm-vm-<machine name>-<8 hex>.scope` for one of the host's machines,
   leaving any other smolvm VM running.
2. Point `stateDir` at a new directory, rename `runtime` to `kind`, `smolvm`
   to `linux` and `tart` to `mac`, and start it on 0.21.
3. Drop each host's `sshUser` from the client config, and `sshUser` from the
   Sandbox Agent provider's options.
4. Rebuild your prebuilds and recreate your machines. A setup of your own
   must now leave `admin`, not `user`.

## Use the CLI

The client config is `$XDG_CONFIG_HOME/clankerbox/config.json` (`~/.config`
when unset), or `--config PATH`:

```json
{
  "hosts": [
    { "id": "linux", "url": "http://100.64.0.10:8484" },
    { "id": "mac", "url": "http://100.64.0.20:8484" }
  ],
  "profiles": "profiles",
  "authorizedKeys": "~/.ssh/id_ed25519.pub"
}
```

The host list is in placement order. Machines of either kind are logged in
to as `admin`. `authorizedKeys` is a public-key file, such as an `id_ed25519.pub`, or
several concatenated: each line that isn't blank is `<type> <base64>
[comment]`, so a private key or any other file is refused. Every create or
prebuild with a setup needs it: the host installs its keys for the login user
once the setup exits 0, and a create without a setup sends none. Paths in the
config, `profiles` and `authorizedKeys`, are under `~/` or else relative to
the config. `profiles` is read only by `profiles` and by commands given
`--profile NAME`, and `authorizedKeys` only by `create` and `prebuild`. `--profile NAME` reads `NAME.json` from
the profiles directory; a value with a `/` or ending in `.json` is a path:

```json
{
  "base": "ubuntu",
  "cpu": 2,
  "ramMib": 4096,
  "diskGib": 20,
  "setup": { "path": "dev", "timeoutSeconds": 900 }
}
```

`setup.path`, relative to the profile, is a script or a recipe directory with
a `setup.sh`. An optional `host` sends every create from the profile there.

```sh
clankerbox hosts                           # every host, its kind, versions and bases
clankerbox capacity                        # every host's resources and limits
clankerbox create dev --profile dev        # prints the new ID, linux_dev
clankerbox create review --host mac --base macos --cpu 4 --ram 8G --disk 60G
clankerbox prebuild --profile dev          # run dev's setup once; later creates of dev restore it
clankerbox machines
clankerbox get linux_dev
clankerbox ssh linux_dev -- uptime
clankerbox stop linux_dev
clankerbox start linux_dev
clankerbox fork linux_dev dev2             # linux_dev2
clankerbox checkpoint capture linux_dev base
clankerbox restore linux_base dev3         # linux_dev3
clankerbox delete linux_dev3
clankerbox checkpoint delete linux_base
```

- IDs are `<host>_<name>`. `create` flags override the profile's fields.
- Sizes and durations carry their unit: `--ram 8G`, `--disk 60G`,
  `--setup-timeout 15m`.
- `fork` copies a running linux machine with its RAM, or a stopped mac
  machine's disk. `checkpoint capture` does the same, so a linux checkpoint is
  `ram` and a mac one `disk`.
- `start`, `stop` and `delete` ask for a state and wait until the machine is
  there; a request fails `Superseded` when a later one for the same machine
  asked for something else before it got there. A machine that stops under
  its host while asked to run is started again at its host's next check,
  every 30 s.
- A create, fork or restore whose copy or setup fails deletes its machine and
  answers the error, and a delete that fails runs again at the next check; a
  host that restarts before it finished deletes the machine too. Only a
  `delete` stops a machine being made: a `stop` waits for it to be made, then
  stops it. A `start` on a running machine runs its preparation again, and so
  does a host that restarts, for each machine it finds running.
- A request on a machine its runtime can't read fails, and the host reads it
  again at its next check.
- A checkpoint is gone once its delete begins; what a delete that fails left
  behind is cleared by the next delete of it, or when its host next starts.
- A prebuild matches the profile, its sizes, its setup, the config's
  authorized keys and the host's runtime release; any change runs the setup
  again until a new `prebuild`. Nothing
  deletes prebuilds: `checkpoint list` shows them.
- `ssh` pins the machine's host key and logs in as `admin`.
- Plain OpenSSH reaches machines by ID too, so `ssh linux_dev`, scp, rsync and
  tools that run ssh work. A command on the default client config keeps
  `~/.ssh/clankerbox` with one `Host <host>_*` block per host, as `admin`,
  and ends `~/.ssh/config` with `Match all` and
  `Include clankerbox`, so your own entries come first and win. Each
  connection runs `clankerbox ssh-proxy` and `clankerbox ssh-known-hosts` for
  the machine's current endpoint and host key, so nothing goes stale when a
  port changes or a machine is recreated. Both run through your login shell,
  `$SHELL` as of the command that wrote the file (`/bin/sh` without one), so
  `clankerbox` must be on the `PATH` that shell sets up, even for an app
  started outside a terminal. `CLANKERBOX_SSH_CONFIG=false` removes both.
- `--json` prints the resource or `{"error": {...}}`.

### Joining machines to the tailnet

A host with `tailnet` joins each machine whose guest has `tailscale` and
`tailscaled` in one of `/usr/local/sbin`, `/usr/local/bin`, `/usr/sbin`,
`/usr/bin`, `/sbin`, `/bin` or `/opt/homebrew/bin`. Nothing else is searched,
not the guest's own `PATH`, `/snap/bin` or Linux Homebrew. Installing them in
a recipe is the opt-in:

- clankerbox runs its own `tailscaled`, in userspace networking, from
  `/var/lib/clankerbox/tailscale`, so no route, netfilter rule or firewall in
  the guest is touched. Leave the distribution's own `tailscaled` service off.
- The login user, and no other user but root, may fetch the node's
  certificates from that `tailscaled`: `/localapi/v0/cert/<domain>` through
  `/var/lib/clankerbox/tailscale/tailscaled.sock`, granted by
  `TS_PERMIT_CERT_UID`. No operator is set, so nothing else on the daemon is
  open to it; reading its status is open to every local user.
- Tailnet connections arrive on the guest's loopback, so a server bound to
  `127.0.0.1` is reachable on the tailnet: loopback is no longer private to
  the guest, and the tailnet policy is what gates it. Keep tokenless services
  off recipes that join.
- A check runs in the background once a start settles: it starts `tailscaled`
  from its saved state if it isn't running, and a node that needs a login gets
  a key. The host mints one per join: single-use, ephemeral, preauthorized, for
  the configured tags, expiring in 10 minutes, and passes it on stdin. A
  request that arrives meanwhile cuts the check short.
- The node is named after the machine's ID, `_` as `-`. A fork or restore
  kills the daemon its source left and drops the node first, so it joins as
  its own node.
- `get` shows `TAILNET`, while the machine runs: the MagicDNS name Tailscale
  gave the node, why the last check failed, or that the guest has no
  `tailscaled`. The status is the host's memory only, never stored. A joined
  machine is checked again every 60 rechecks (half an hour at the default 30
  seconds), which restarts a daemon that died; a failed one after 1 recheck,
  then 2, 4 and so on up to 64. A guest without `tailscaled` is checked again
  at its next start. A prebuild's builder joins nothing.
- Nodes are ephemeral, so a deleted machine's node goes once it has been
  offline a while; a machine of the same name made again before then gets a
  suffixed name.

`clankerbox COMMAND --help` documents each command.

### Writing a setup

Setup runs once, as root, after the machine's first boot; forks and restores
carry its results. It must:

- leave the login user, `admin`, and `sudo`: create `admin` and install
  `sudo` where the base has neither (smolvm's stock images; Tart's bases ship
  both). The recipes also give it passwordless `sudo`, which the host
  doesn't require;
- install sshd where the base has none (smolvm's stock images), with
  `PermitRootLogin no`;
- write `/etc/clankerbox/start`, if anything should run after each boot, fork
  or restore: idempotent, daemonizing what it launches, exiting 0 once it's
  up, and relaunching sshd if `/run/sshd.pid` is dead;
- optionally write `/etc/clankerbox/new-identity`, run when a fork or restore
  gets its new identity, to reset per-machine state of its own;
- install `tailscale` and `tailscaled`, without starting them, on a host that
  joins its machines to the tailnet.

A service of the login user that serves TLS on the tailnet can take the
node's certificate from clankerbox's `tailscaled` (see above), retrying until
the check after each start has the daemon up.

Once a setup exits 0, the host appends the client config's `authorizedKeys`
to the login user's `~/.ssh/authorized_keys`, as that user through `sudo`,
beside any keys already there. A setup that leaves no
login user, or no `sudo`, fails then, and its machine is deleted. Put no key
in root's: nothing logs in as root.

Linux guests need `perl`. On mac, Softnet blocks gateway DNS, so set public
resolvers. A checkpoint, prebuilds included, holds
everything the machine had, credentials too.

## Deploy

Install the package in a versioned prefix; VMs never reference it, so a
release replaces it while machines run. Its `bin/clankerbox` runs the `node` on
the service's `PATH`, which must be Node 26 or later.

```sh
npm install --global --prefix /opt/clankerbox/<version> @gjermundgaraba/clankerbox@<version>
```

**linux**, as root, in a system unit:

```ini
[Unit]
Description=clankerbox host (linux)
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=exec
ExecStart=/opt/clankerbox/<version>/bin/clankerbox host --config /etc/clankerbox/linux.json
KillMode=control-group
SuccessExitStatus=130
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

VMs run in their own scopes, so restarting the unit leaves them running.

**mac**, as the operator's user, in a LaunchAgent in its GUI session, with
`KeepAlive` set to `{SuccessfulExit: false}`; stop it with
`launchctl bootout gui/<uid>/<label>`. Pull each base with `tart pull` as that
user before its first create.

**Network:** the tailnet policy opens each host's API port to its clients, and
the machines' port range to clients that run `clankerbox ssh`. On a linux
host, nothing may listen on a public address:
guests can reach those. On macOS with the application firewall on, allow
incoming connections for each new `node` binary, which allows them for every
program that `node` runs.

## SDK

`@gjermundgaraba/clankerbox-sdk` holds the API's schemas, errors and the
client. SDK 1.2.3 talks to hosts of release 1.2.x; hosts refuse other
releases. `effect` and `@effect/platform-node` (`~4.0.4`) are peer
dependencies.

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client, readSetup } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Console, Effect } from "effect";

const program = Effect.gen(function* () {
  const client = yield* Client.Client;

  // Placed on the first host that offers the base; `{ host: "linux" }` would name the host.
  const machine = yield* client.create("dev", {
    base: "ubuntu",
    cpu: 2,
    ramMib: 4096,
    diskGib: 20,
    setup: { script: yield* readSetup("recipes/dev"), timeoutSeconds: 900 },
  });

  yield* Console.log(machine.id, machine.ssh, machine.hostKey);
}).pipe(Effect.catchTag("Capacity", (error) => Console.error(`no room: ${error.message}`)));

program.pipe(
  Effect.provide(NodeClient.layer([{ id: "linux", url: "http://100.64.0.10:8484" }])),
  Effect.provide(NodeServices.layer),
  Effect.runPromise,
);
```

- Every action is a method named as in the contract (`api.ts`), such as
  `client.forkMachine({ machine, name })`, and fails with tagged errors
  (`errors.ts`); `retryable(error)` says whether to try again.
- A mutation waits until the host is done with it: a machine at rest with
  what was asked, its `phase` and `error` saying how it got there. One whose
  reply is lost fails `Unavailable`: it may have run, so read the resource.
- `Prebuild.build` and `Prebuild.create` do what `clankerbox prebuild` and a
  create of a profile do.

## Sandbox Agent provider

`@gjermundgaraba/clankerbox-rivet-sandbox-agent` is a provider for Rivet's
[Sandbox Agent](https://github.com/rivet-dev/agents/tree/main/sandbox-agent)
SDK whose sandboxes are clankerbox machines, reached through an `ssh -L`
tunnel pinned to the machine's host key.

```ts
import { clankerbox } from "@gjermundgaraba/clankerbox-rivet-sandbox-agent";
import { SandboxAgent } from "sandbox-agent";

const sandbox = clankerbox({
  hosts: [{ id: "linux", url: "http://100.64.0.10:8484" }],
  from: { profile: "profiles/agent.json" },
  authorizedKeys: "/path/to/key.pub",
  sshArguments: ["-i", "/path/to/key"],
});

const sdk = await SandboxAgent.start({ sandbox });
const session = await sdk.createSession({ agent: "claude" });

await session.prompt([{ type: "text", text: "Summarize README.md" }]);
await sdk.destroySandbox();
```

- A sandbox comes from a profile (`{ profile }`), a checkpoint
  (`{ checkpoint }`) or a fork (`{ machine }`), and a profile's prebuild is
  used when there is one. `authorizedKeys` does what the client config's
  does, for the key the tunnel logs in with, and a profile with a setup needs
  it.
- A sandbox's ID is `clankerbox/<machine ID>`; `pauseSandbox` stops the
  machine and `destroySandbox` deletes it. A create that fails deletes the
  machine it may have made, unless the host answers `Conflict`, as the name
  is another machine's, or `Superseded`, as a later request owns it.
- `recipes/ubuntu/` (linux) and `recipes/macos/` (mac) install the server,
  Node and Claude Code, and run the server as the login user, whose home,
  `/home/admin` on Linux, is the default `cwd`; on macOS, give
  `cwd: "/Users/admin"`. Each takes an optional `agent.env` beside its
  `setup.sh`, of `NAME=value` lines, such as `ANTHROPIC_API_KEY=…`, so keep a
  recipe with one private.
- A tunnel that ends, say because its machine stopped, stays down until
  `sandbox.ensureServer(id)` or a new `SandboxAgent.start`.
- `effect`, `@effect/platform-node` and `sandbox-agent` are peer dependencies.

## Amp orbs

`clankerbox amp-orb` is a dispatch program for Amp's
[self-hosted orbs](https://ampcode.com/docs/orbs/self-hosted): each orb is a
machine on a linux host, booted from Amp's orb image.

1. Offer the image as a base on a linux host, pinned by digest:

   ```json
   "bases": {
     "amp-orb": "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb@sha256:a80a55e6561b2e69f96f73029cc1dfae53f89198465cbc117855a32514aa39be"
   }
   ```

2. Write a profile, `amp-orb.json`, whose setup is the package's
   `recipes/amp-orb/` (under `$(npm root --global)/@gjermundgaraba/clankerbox`),
   or a copy of it, and prebuild it: Amp gives each job five minutes, which a
   setup run from scratch may not fit in.

   ```json
   {
     "base": "amp-orb",
     "cpu": 4,
     "ramMib": 8192,
     "diskGib": 40,
     "setup": { "path": "amp-orb" }
   }
   ```

   ```sh
   clankerbox prebuild --profile amp-orb
   ```

3. On the machine that runs Amp's provider, with the client config and an SSH
   key that `authorizedKeys` holds, write the program Amp runs, which takes
   no arguments, and run the provider with the token from Amp's **Settings →
   Orbs**:

   ```sh
   printf '#!/bin/sh\nexec clankerbox amp-orb --profile amp-orb\n' >/opt/orbs/dispatch
   chmod +x /opt/orbs/dispatch
   AMP_ORB_PROVIDER_TOKEN=aop_live_… amp orb provider /opt/orbs/dispatch
   ```

- A `spawn` finds the orb's machine on any host in the client config and
  starts it. When there is none, it restores the orb's pause, or the checkpoint
  of `ORB_SNAPSHOT_ID`, or creates the machine from the profile and its
  prebuild. It then logs in over ssh as `admin` and starts `amp orb bootstrap`,
  detached, as the image's `user`, with `ORB_TOKEN` and `AMP_URL` sent on
  stdin. Its log is `~user/.local/state/clankerbox/amp-orb.log`.
- A `pause` keeps the orb's memory: it captures the machine, RAM and all,
  into a checkpoint named as the machine, then deletes the machine. With
  `ORB_SNAPSHOT_ID` it also captures `snapshot-<ID>`, which later orbs of the
  project restore. A spawn from a snapshot ends the bootstraps the snapshot's
  orb left running.
- A `delete` deletes the orb's machine and its pause. Snapshots stay until
  `clankerbox checkpoint delete`, since Amp's `amp projects snapshots delete`
  runs no job.
- Each job is safe to repeat, and one cut short is finished by the next. A
  job fails, and changes nothing, when a host it can't read might hold the orb.
- The machine is named `ORB_ID`, or `amp-` and a digest of it when
  `<host>_<ORB_ID>` passes 62 characters.
- Amp pauses a thread whenever it goes idle or is archived, and deletes it only
  when the thread is deleted, so each idle or archived thread keeps a checkpoint
  of its RAM and disk.
- Pauses and snapshots are `ram` checkpoints, which restore only under the
  smolvm release that captured them. Before moving a host's smolvm, delete
  them with `clankerbox checkpoint delete`, or a spawn of a paused orb, or
  from its project's snapshot, fails.
- The base, not `ORB_IMAGE`, picks the image: move its digest to take a new one,
  then prebuild again. The `amp` CLI in the orb updates itself either way.

## License

MIT, see [LICENSE](LICENSE).
