# clankerbox

clankerbox runs machines (VMs) for coding agents and reports where each one is reachable over SSH.

- Lifecycle: create, start, stop, pause, resize, delete, fork, checkpoint capture and restore.
- Two kinds of host: `linux`, Linux guests on a Linux host under smolvm, with RAM forks and RAM checkpoints, and `mac`, macOS guests on a Mac under Tart, with disk copies.
- A client talks to one control plane, `clankerbox-server`, by machine name. It never learns which host a machine is on. Adding a host is one line in the control plane's config.
- A template lives on the control plane: a base, sizes and builds, each a copy of a machine its setup ran on. A create from a template clones its current build, so no setup runs.
- Each machine exposes only SSH, reported as a `host:port` with the guest's host key. That key is Ed25519 only: each new machine, fork or restore replaces the image's host keys with one new Ed25519 key. A host can also join its machines to the tailnet, each as its own node, so their ports are reachable there.
- The control plane, the hosts and the clients share a Tailscale tailnet, and its policy is the only gate: the APIs have no keys and no TLS.

## How it fits together

```text
clankerbox CLI / SDK
        | client contract, HTTP
        v
clankerbox-server              one process, one SQLite file
  a loop per machine           what was asked, how far it got, the leases
        | host contract, HTTP, control plane calls hosts
        v
clankerbox-host  ...           one per Linux box or Mac, keeps no database
  runs whole operations        on smolvm or Tart
        |
        v
VMs  <---------- SSH, directly from the client to the host's port
```

The control plane keeps every machine's row and decides what happens next. It gives a host one whole step at a time (make, start, stop, pause, remove, resize, capture), and the host runs that step to its end whether or not the control plane stays. A host holds nothing a restart of the control plane can lose, and the control plane holds nothing a host's restart can lose.

A mutation answers once the control plane has recorded it, and the client waits by reading the row. Nothing but the wait is lost when a client goes away. Each write of a row runs a statechart inside that write, so a request and what it does to the row can't be pulled apart by a crash.

What happens when something fails:

| What fails | What you see |
| --- | --- |
| The control plane is down | Running machines keep running. Open SSH sessions stay up. A new `ssh` fails, since it asks the control plane where the machine is. Every other command fails `Unavailable`. A step a host already has runs to its end. |
| The control plane comes back | It finds each step in flight on its host, and carries on. A create whose setup hadn't reached its host is undone and fails, since a setup is never stored. |
| A host is unreachable | Its machines read `unknown`, phase `waiting`. A request on one stays saved, and its wait reads on as through an outage of the control plane, ending `Unavailable` once the host has been unreachable for two minutes; it acts when the host is back. A create goes to another host, and only fails if no host could take it. |
| A host restarts | Its VMs stay up. A step it held ends, and the control plane decides afresh from the VM's state. A create it held is undone, and a capture it held fails and leaves no checkpoint. |
| A template build's host stops answering | The build rides out a fault shorter than a recheck, 30 s, and fails `Unavailable` past that, and the template's current build stays as it was. Its builder goes once the host is back. |
| A create fails | The VM is deleted, again at each recheck while that fails, and the row stays `failed` to say why, for a day once the VM is gone. `delete` clears it. A create of the name replaces it once the VM is gone, and answers `Conflict` until then. |
| A host has no room for a create | The create moves to the next host. |

Machines and checkpoints stay on the host they were made on: forks and restores land beside their source, and machines don't move between hosts yet.

The control plane is one instance over one SQLite file. Back up its state directory: it is the only record of what exists.

The npm packages are `@gjermundgaraba/clankerbox` (the CLI), `@gjermundgaraba/clankerbox-server`, `@gjermundgaraba/clankerbox-host`, and the TypeScript SDK `@gjermundgaraba/clankerbox-sdk`. All four share a version, and a control plane refuses a client or host of another `major.minor`, so upgrade them together.

## Install

Each package needs Node 26.13 or later, and bundles everything else it runs.

```sh
npm install --global @gjermundgaraba/clankerbox          # where you run commands
npm install --global @gjermundgaraba/clankerbox-server   # on one machine
npm install --global @gjermundgaraba/clankerbox-host     # on each host
clankerbox --version
```

Each host needs its kind's runtime, installed by the operator:

| Kind | Host | Prerequisite |
| --- | --- | --- |
| linux | Linux/amd64 with KVM | smolvm 1.33.0 or later, upstream, in a versioned prefix; runs as root |
| mac | Apple Silicon, macOS 26 or later for the base's ASIF disk, checked on 27.2 | Tart 2.41.1 or later, Softnet 0.25.0 installed SUID root |

smolvm, with both disk templates expanded beside their `.zst` files:

```sh
version=1.33.0
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
  "linux": { "prefix": "/opt/smolvm/1.33.0" }
}
```

- `id` is short and lowercase. The control plane's config names the host by it.
- `listen.address` is a tailnet address or loopback, and machines' SSH ports are published on it.
- `stateDir`, relative to the config, holds the runtime's files. On linux it is at most 52 bytes and outside every home directory, such as `/srv/clankerbox/smolvm`.
- `bases` maps names clients ask for to images, pinned by digest. A name holds no `/`. Hosts offering the same image should use the same name, as a create may land on any of them. The release was checked on linux's `ubuntu` above and on mac's `macos`, `ghcr.io/cirruslabs/macos-golden-gate-xcode@sha256:d7641b1d985fd53fbac071c663bf249007b9b387e16b7d576144588acb1d93f9`, Cirrus's Xcode 27.2 on macOS 27, whose 140 GB ASIF disk takes a `diskGib` of 131 or more: 130 GiB rounds to 140 GB, and Tart refuses to set an ASIF disk to its own size as it refuses a smaller one. A linux host also creates from any image reference a create names as its base, one with a `/`, such as `registry.example/team/image:tag`. A prebuild names its base, not the image, so one made from a tag keeps the image the tag named then.
- The kind's block: `linux: {prefix, ramBudgetMib?}`, smolvm's install, or `mac: {binary}`, the `tart` executable of a versioned install.
- `machinePorts: {first, last}`, optional, is the range machines' SSH ports come from, 10000–19999 by default; `listen.port` lies outside it.
- `tailnet: {oauthClient: {id, secret}, tags}`, optional, joins the host's machines to the tailnet (see below). The client needs the `auth_keys` scope and the tags; its secret never leaves the host.

```sh
clankerbox-host --config /etc/clankerbox/linux.json
```

The host exits 130 on SIGINT or SIGTERM and 1 when it fails.

## Run the control plane

One process runs from one JSON config file:

```json
{
  "listen": { "address": "100.64.0.1", "port": 8484 },
  "stateDir": "state",
  "authorizedKeys": "authorized_keys.pub",
  "hosts": [
    { "id": "linux", "url": "http://100.64.0.10:8484" },
    { "id": "mac", "url": "http://100.64.0.20:8484" }
  ]
}
```

- `listen.address` is a tailnet address or loopback: this API can change every machine, and takes no key.
- `hosts` is in placement order: a create goes to the first that offers its base and has room, and a create from a template to the first that holds a copy of its build and has room.
- `draining: true` on a host passes it over for new machines, and leaves what it runs alone.
- `stateDir`, relative to the config, holds `server.db`. One process holds it at a time.
- `authorizedKeys`, relative to the config, is a public-key file, such as an `id_ed25519.pub`, or several concatenated: each line that isn't blank is `<type> <base64> [comment]`, so a private key or any other file is refused. The control plane reads the file as it starts and sends the keys with every create that runs a setup or clones a template's build, and the host installs those it lacks for the login user once the setup exits 0 or the clone is made. A template's build holds none. A create without a setup gets none, and a fork or restore of a checkpoint only those its source had. The keys are never stored or logged. To change them, edit the file and restart the control plane: machines made after it take the new set, and those made before keep theirs.
- To add a host, add its line and restart the control plane. Machines keep running through the restart, and clients need nothing.

```sh
clankerbox-server --config /etc/clankerbox/server.json
```

The control plane exits 130 on SIGINT or SIGTERM and 1 when it fails.

### Upgrading from 0.30

Hosts and the control plane start fresh: 0.30's machines aren't carried over. Before you upgrade, delete each machine and checkpoint with the old release, then stop its host, and remove its `stateDir`. IDs no longer carry a host: `linux_dev` is `dev`, and `ssh dev.cbx` replaces `ssh linux_dev`. Client configs name `server` instead of `hosts`, and profiles lose `host`. `clankerbox host` is now `clankerbox-host`.

### Upgrading from 0.35

State carries over, but the host contract changed: a host's make now carries the authorized keys, so upgrade hosts and the control plane together, since a create placed on a host of the other release fails. The authorized keys moved from each client config to the server config: gather the public keys of every client config's `authorizedKeys` into one file, name it in the server config's `authorizedKeys`, and delete `authorizedKeys` from each client config, which a client now refuses, and from the Sandbox Agent provider's options. Every machine made with a setup, or from a template, then takes every key in that file, and a create sends none. Machines already made keep the keys they have. A client config that still names `authorizedKeys` fails every command, `ssh-proxy` and `ssh-known-hosts` included, so `ssh <name>.cbx` stops working until the key is deleted from that config.

Templates replace profiles and prebuilds. The control plane migrates its database on its first start: it drops the profile from each machine and checkpoint and the prebuild from each machine, and adds the tables templates and their builds take. For each profile you create from, run `clankerbox template build NAME PATH --base BASE --cpu N --ram SIZE --disk SIZE`, with the profile's setup as `PATH`, once from any client, then create with `--template NAME` instead of `--profile NAME`. Delete `profiles` from each client config, which a client now refuses, and in the Sandbox Agent provider's options give `from: { template }` for `from: { profile }`, and drop `fresh`. `profiles`, `prebuild`, `prebuild get`, `--profile` and `--fresh` are gone. 0.35's prebuilds stay as plain checkpoints, named `prebuilt-<digest>`, which no create restores: delete them with `checkpoint delete`.

### Upgrading from 0.34

State carries over: the control plane migrates its database on its first start, adding the columns that labels, expiry and a pause's capture take, and nothing on a host changes. Upgrade hosts and the control plane together, as always.

## Use the CLI

The client config is `$XDG_CONFIG_HOME/clankerbox/config.json` (`~/.config` when unset), or `--config PATH`:

```json
{
  "server": "http://100.64.0.1:8484"
}
```

Machines of either kind are logged in to as `admin`, with the keys of the server config's `authorizedKeys`.

```sh
clankerbox create dev --template web       # waits until it runs, prints dev
clankerbox create review --base macos --cpu 4 --ram 8G --disk 150G
clankerbox create box --base ubuntu --cpu 2 --ram 4G --disk 20G --setup ./recipes/web
clankerbox machines
clankerbox get dev
clankerbox ssh dev -- uptime
ssh dev.cbx                                # plain OpenSSH, scp and rsync work too
clankerbox exec dev --user admin -- uptime # through the host, no SSH; --env, --stdin and --timeout
clankerbox pause dev                       # saves its RAM and frees it
clankerbox pause dev --capture snap --expires 7d  # captures it as it runs, then pauses
clankerbox stop dev
clankerbox resize dev --cpu 4 --ram 4G --disk 80G
clankerbox start dev
clankerbox fork dev dev2
clankerbox fork dev big --ram 8G           # a copy with more RAM
clankerbox checkpoint capture dev base --label app=web --expires 30d
clankerbox checkpoint list --label app=web
clankerbox restore base dev3 --label app=web
clankerbox machines --label app=web
clankerbox delete dev3
clankerbox checkpoint delete base
clankerbox hosts                           # for an operator: each host, its state and versions
clankerbox capacity                        # for an operator: each host's resources and limits
```

- A name is unique across every host, per resource type.
- `create` makes a machine from a template's build (see Templates), or from `--base` with `--cpu`, `--ram` and `--disk`, running `--setup`, a script or a recipe directory with a `setup.sh`, if given.
- A command waits until the machine rests. `--no-wait` answers once the request is recorded, and `--timeout 10m` bounds the wait; either way the request stays saved and acts. A wait goes on through a short restart of the control plane.
- Sizes and durations carry their unit: `--ram 8G`, `--disk 60G`, `--setup-timeout 15m`.
- `fork` copies a running linux machine with its RAM, or a stopped mac machine's disk. `fork` and `restore` take `--cpu`, `--ram` and `--disk` for the copy, its source's by default: a linux copy, holding its source's RAM, only grows, live once it runs; a mac copy takes any vCPUs and RAM; a disk only grows. `checkpoint capture` does the same, so a linux checkpoint is `ram` and a mac one `disk`.
- `start`, `stop` and `pause` ask for a state and wait until the machine is there; a request fails `Superseded` when a later one for the same machine asked for something else before it got there. `delete` waits until the machine is gone, and nothing supersedes it. A machine that stops by itself while asked to run is started again at the control plane's next check, every 30 s.
- `pause` saves a running machine's RAM, processes and disks and stops its VM, so it holds no RAM, and on a Mac none of its two VMs, until a `start` resumes it where it was. A `pause` leaves a stopped machine stopped, and a paused machine can't be forked or captured. A `pause` stops a machine it can't save, which then reads `stopped`: on linux one booted under another smolvm build, or before its host recorded which, and on a Mac one an older host booted.
- On linux a paused machine resumes only under the smolvm build that paused it: after a host moves to another one, a `start` of it fails `PinMismatch`, so start or stop paused machines before upgrading; a stop needs room for one machine at a time, where each start keeps its RAM. A machine left running across the move is stopped by its next pause, and pauses after a start. A Mac tries the resume under any Tart and macOS, and a restore it can't make fails, keeping the saved state: a `stop` discards it, and the next `start` boots from the disk.
- A `stop` of a paused machine resumes it on linux to end its processes, needing room as a start does, and fails `PinMismatch` after an upgrade too; on a Mac it discards the saved state without booting. Either keeps the disk.
- On a Mac, macOS restores a VM's state only in the operator's unlocked login session: a `start` of a paused machine while it is locked fails and keeps the saved state (see Deploy).
- `resize` gives a stopped machine any vCPUs and RAM, and grows a running linux machine's live, needing room for its RAM as a start does; a running mac machine or a paused one is refused, so stop it first. A disk only grows: smolvm grows the guest's filesystem, at once when it runs, and on a Mac the base's Tart guest agent grows APFS at the next boot. A resize waits for a step under way, and keeps what the runtime gave when it fails part way, or when the host stops during it, which the machine's sizes then show; asking for the same sizes again finishes a live grow that failed part way. A `resize` answers at the machine's next rest under any later wish but a delete, as each runs after it.
- A create, fork or restore whose copy or setup fails deletes its VM, keeps its row for a day to say why, and answers the error; a delete that fails runs again at the next check. A create that a host had no room for moves to the next host first, unless the control plane restarted since it took the create. Only a `delete` stops a machine being made: a `stop` waits for it to be made, then stops it. A `start` on a running machine runs its preparation again.
- A request on a machine whose host can't be reached stays saved, and its wait reads on, failing `Unavailable` once the host has been unreachable for two minutes; it acts once the host answers. A capture on such a machine reads `capturing` until the host answers, so `checkpoint capture` waits that long, or until its `--timeout`.
- A machine being deleted can't be captured or forked: either answers `NotFound`.
- A checkpoint is `ready` until its delete begins, and a delete that fails runs again.
- `exec` runs a command in a running machine through its host, as root or `--user`, with `--env NAME=VALUE` set and, with `--stdin`, this stdin sent whole. It prints the command's output, its last 65,536 characters, saying on stderr when it was cut, and exits with the command's code. It waits for a step under way on the machine first, and a stop, pause or delete asked meanwhile ends it. `--timeout 90s` ends the command and exits 124. Nothing of a command is stored or logged, so a secret may go on its stdin.
- `--label KEY=VALUE`, repeated for more, tags a machine or checkpoint when it is made: on `create`, `fork`, `restore`, `checkpoint capture` and `pause --capture`. Labels never change after that, and a copy takes only the labels its own request gives. `machines --label KEY=VALUE` and `checkpoint list --label KEY=VALUE` list what carries every pair given. A resource takes at most 16 labels; a key is a name like a resource's, and a value up to 63 characters.
- `--expires 7d` on `checkpoint capture` or `pause --capture` has the control plane delete the checkpoint once it is ready and that long has passed, at its next check; `checkpoint get` shows `EXPIRES`.
- `pause --capture NAME` records the capture first, and the pause begins once the capture has, so the checkpoint holds the machine as it ran; `--label` and `--expires` go on the checkpoint. The machine must be running: a stopped or paused one answers `WrongState`, so capture it with `checkpoint capture` instead. A capture that fails fails the command with its error once the machine has paused; `checkpoint get NAME` says why.
- `ssh` pins the machine's host key and logs in as `admin`.
- Plain OpenSSH reaches machines as `<name>.cbx`, so `ssh dev.cbx`, scp, rsync and tools that run ssh work. A command on the default client config keeps `~/.ssh/clankerbox` with one `Host *.cbx` block, as `admin`, and ends `~/.ssh/config` with `Match all` and `Include clankerbox`, so your own entries come first and win. Each connection runs `clankerbox ssh-proxy` and `clankerbox ssh-known-hosts` for the machine's current endpoint and host key, so nothing goes stale when a port changes or a machine is recreated, and the connection goes straight to the machine's host. Both run through your login shell, `$SHELL` as of the command that wrote the file (`/bin/sh` without one), so `clankerbox` must be on the `PATH` that shell sets up, even for an app started outside a terminal. `CLANKERBOX_SSH_CONFIG=false` removes both.
- `--json` prints the resource or `{"error": {...}}`.

### Templates

A template is a base, sizes and builds, kept by the control plane, so every client sees the same ones. `template build` creates a machine from the base, runs the setup in it, captures a copy of it on its host, and deletes the machine. A create from the template clones that copy, so no setup runs.

```sh
clankerbox template build web ./recipes/web --base ubuntu --cpu 2 --ram 4G --disk 20G  # prints web@1
clankerbox template build web ./recipes/web     # prints web@2, with web's base and sizes
clankerbox template list                        # each template's base, current build and state
clankerbox template get web                     # its sizes, and each build kept
clankerbox create box --template web            # clones web's current build
clankerbox create old --template web@1 --ram 8G # clones that build, with more RAM
clankerbox template delete web
```

- `PATH` is a setup script or a recipe directory with a `setup.sh`, read by the client and sent with the build. The control plane holds it in memory for that build only, and never stores or logs it, so each build sends it again.
- A first build gives `--base`, `--cpu`, `--ram` and `--disk`, and `--setup-timeout` when the host's default won't do. A rebuild takes the template's for each it leaves out, and keeps each it gives.
- A build's ID is the template's name, `@` and its number, such as `web@2`. `template build` waits until the build ends and prints its ID; `--no-wait` prints it at once, and `template get` follows the build.
- The current build is the newest that is ready: it moves to a build only once its setup has run and its copy is made, so a build that fails leaves the one before it current. The control plane keeps the last 2 ready builds, and deletes an older one's copy once the creates cloning it are done.
- One build of a template runs at a time: a build or a delete asked meanwhile fails `Conflict`. A control plane that restarts during a build ends it failed and deletes its builder.
- `create --template NAME` clones the current build, and `--template NAME@N` that build while it is kept; one with no ready build to clone fails `NotBuilt`. A create from a template takes no `--base`, `--setup` or `--setup-timeout`. It takes the build's sizes, or larger ones from `--cpu`, `--ram` and `--disk`; smaller ones fail `Unsizable`. A linux create grows the clone while it runs, so smolvm's limits on a live grow hold: RAM grows in 128M steps.
- A build's copy stays on the host that built it, and creates from it go only to a host that holds it: when that host has no room the create fails `Capacity`, and runs no setup elsewhere. A build goes to the first host that offers the base. On a Mac the build stops its machine before the copy, so a clone boots from the disk.
- A build's copy is no checkpoint: `checkpoint list` leaves it out, and `restore` can't reach it. `get` shows the build a machine was cloned from as `TEMPLATE`. `template delete` deletes a template and its builds' copies, once the creates cloning them are done, and leaves the machines cloned from it.

### Joining machines to the tailnet

A host with `tailnet` joins each machine whose guest has `tailscale` and `tailscaled` in one of `/usr/local/sbin`, `/usr/local/bin`, `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin` or `/opt/homebrew/bin`. Nothing else is searched, not the guest's own `PATH`, `/snap/bin` or Linux Homebrew. Installing them in a recipe is the opt-in:

- clankerbox runs its own `tailscaled` from `/var/lib/clankerbox/tailscale`, on its socket there, `tailscaled.sock`; pass it to `tailscale --socket` and to tools that ask the daemon who calls, such as Rex's `--tailscaled-socket`. It runs in kernel mode: the guest gets a tailnet interface and address, so every program in it reaches the tailnet, and only a server listening on that address or on all addresses is reachable there, never one bound to `127.0.0.1`. Leave the distribution's own `tailscaled` service off.
- It takes over the guest's DNS (`--accept-dns`), so MagicDNS names resolve, and on linux it installs no firewall rules (`--netfilter-mode=off`): smolvm's guest network lies in Tailscale's `100.64.0.0/10`, and Tailscale's rules drop that range on any other interface, the host's SSH included. A check sets both each time it finds the daemon answering.
- The login user, and no other user but root, may fetch the node's certificates from that `tailscaled`: `/localapi/v0/cert/<domain>` through its socket, granted by `TS_PERMIT_CERT_UID`. No operator is set, so nothing else on the daemon is open to it; reading its status is open to every local user.
- After resetting a new instance’s identity and before running `/etc/clankerbox/start`, the host joins the tailnet: it starts `tailscaled` from its saved state if it isn't running, and a node that needs a login gets a key. The host mints one per join: single-use, ephemeral, preauthorized, for the configured tags, expiring in 10 minutes, and passes it on stdin. A request that arrives meanwhile cuts the check short. A failed join is reported in `TAILNET` and still runs the start hook; the control plane retries it with backoff. The hook keeps its own 60-second timeout, separate from the join. The tailnet credentials stay on the host.
- The node is named `cbx-<name>`. A fork or restore kills the daemon its source left and drops the node first, so it joins as its own node.
- `get` shows `TAILNET`, while the machine runs: the MagicDNS name Tailscale gave the node, why the last check failed, or that the guest has no `tailscaled`. The status is the control plane's memory only, never stored. A joined machine is checked again every 60 rechecks (half an hour at the default 30 seconds), which restarts a daemon that died; a failed one after 1 recheck, then 2, 4 and so on up to 64. A guest without `tailscaled` is checked again at its next start. A template build's builder joins nothing.
- Nodes are ephemeral, so a deleted machine's node goes once it has been offline a while; a machine of the same name made again before then gets a suffixed name.

`clankerbox COMMAND --help` documents each command.

### Writing a setup

Setup runs once, as root, after the machine's first boot; forks and restores carry its results. It must:

- leave the login user, `admin`, and `sudo`: create `admin` and install `sudo` where the base has neither (smolvm's stock images; Tart's bases ship both). The recipes also give it passwordless `sudo`, which the host doesn't require;
- install sshd where the base has none (smolvm's stock images), with `PermitRootLogin no`;
- write `/etc/clankerbox/start`, if anything should run after each boot, fork or restore: idempotent, daemonizing what it launches, exiting 0 once it's up, and relaunching sshd if `/run/sshd.pid` is dead;
- optionally write `/etc/clankerbox/new-identity`, run when a fork or restore gets its new identity, to reset per-machine state of its own;
- install `tailscale` and `tailscaled`, without starting them, on a host that joins its machines to the tailnet.

A service of the login user that serves TLS on the tailnet can take the node's certificate from clankerbox's `tailscaled` (see above). On a successful join, the tailnet is up before `/etc/clankerbox/start` runs.

Once a setup exits 0, and once a create clones a template's build, the host adds each key of the server config's `authorizedKeys` that the login user's `~/.ssh/authorized_keys` lacks, as that user through `sudo`, beside the keys already there. A template build's own setup installs none. A setup that leaves no login user, or no `sudo`, fails then, as does each create from a build of it, and the machine is deleted. Put no key in root's: nothing logs in as root.

Linux guests need `perl`. On mac, Softnet blocks gateway DNS, so set public resolvers. A checkpoint, like a template's build, holds everything the machine had, credentials too.

## Deploy

Install each package in a versioned prefix; VMs never reference it, so a release replaces it while machines run. Its bin runs the `node` on the service's `PATH`, which must be Node 26.13 or later.

```sh
npm install --global --prefix /opt/clankerbox/<version> @gjermundgaraba/clankerbox-host@<version>
```

**linux**, as root, in a system unit:

```ini
[Unit]
Description=clankerbox host (linux)
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=exec
ExecStart=/opt/clankerbox/<version>/bin/clankerbox-host --config /etc/clankerbox/linux.json
KillMode=control-group
SuccessExitStatus=130
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

VMs run in their own scopes, so restarting the unit leaves them running.

**The control plane** runs in the same kind of unit, as any user that owns its `stateDir`, with `ExecStart=/opt/clankerbox/<version>/bin/clankerbox-server --config /etc/clankerbox/server.json`. It runs no VMs and can share a box with a host, or sit on anything small on the tailnet. Keep a backup of its `stateDir`: with the file gone, the VMs run on with nothing that knows them.

**mac**, as the operator's user, in a LaunchAgent in its GUI session, with `KeepAlive` set to `{SuccessfulExit: false}`; stop it with `launchctl bootout gui/<uid>/<label>`. Pull each base with `tart pull` as that user before its first create. For `pause`, keep that session unlocked: set **Lock Screen → Require password after screen saver begins or display is turned off** to **Never** (the display can still sleep), and log in once after each reboot, since FileVault rules out automatic login. macOS keeps the key that seals saved VM state in the session's keychain, so a root daemon can't save it at all. The first pause on a Mac creates that key, so make it while you're logged in and unlocked: a save while locked before then powers the VM off, keeping its disk, and fails. Later pauses work while locked, but every resume needs the session unlocked.

**Network:** three paths cross the tailnet, and its policy is the only gate.

| From | To | Port | For |
| --- | --- | --- | --- |
| Clients | The control plane | its `listen.port` | every command |
| The control plane | Each host | its `listen.port` | steps and reads |
| Clients that run `ssh` | Each host | its `machinePorts` | SSH straight to machines |

Clients never need a host's API port. The control plane logs one line when a host stops answering, and one when it answers again. On a linux host, nothing may listen on a public address: guests can reach those. On macOS with the application firewall on, allow incoming connections for each new `node` binary, which allows them for every program that `node` runs.

## SDK

Since 0.34.0 the SDK and the Sandbox Agent provider require Effect and `@effect/platform-node` `~4.1.1` and `@gjermundgaraba/effect-actions` `^0.29.0`. Release 0.33 took the same Effect versions and effect-actions `^0.27.0`, and 0.32 effect-actions `^0.26.0`; 0.31 took `~4.0.5` and `^0.23.0`. Upgrade these peers together.

`@gjermundgaraba/clankerbox-sdk` holds the API's schemas, errors and the client. SDK 1.2.3 talks to a control plane of release 1.2.x, which refuses other releases. `effect` and `@effect/platform-node` (`~4.1.1`) are peer dependencies.

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client, readSetup } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Console, Effect } from "effect";

const program = Effect.gen(function* () {
  const client = yield* Client.Client;

  // Waits until it runs; the control plane chooses the host.
  const machine = yield* client.create("dev", {
    base: "ubuntu",
    cpu: 2,
    ramMib: 4096,
    diskGib: 20,
    setup: { script: yield* readSetup("recipes/dev"), timeoutSeconds: 900 },
  });

  yield* Console.log(machine.id, machine.ssh, machine.hostKey);
}).pipe(
  Effect.catchTag("Capacity", (error) =>
    Console.error(`no room: ${error.message}`)
  )
);

program.pipe(
  Effect.provide(NodeClient.layer("http://100.64.0.1:8484")),
  Effect.provide(NodeServices.layer),
  Effect.runPromise
);
```

- Every action is a method named as in the contract (`api.ts`), such as `client.forkMachine({ machine, name })`, and fails with tagged errors (`errors.ts`); `retryable(error)` says whether to try again.
- A mutation answers once recorded, and the client waits until the resource rests: a machine with what was asked, its `phase` and `error` saying how it got there. `Client.make(url, { noWait: true })` skips the wait, and `timeout` bounds it. One whose reply is lost fails `Unavailable`: it may have run, so read the resource.
- `client.buildTemplate({ template, setup, base, cpu, ramMib, diskGib })` does what `clankerbox template build` does, and answers the `Build` once it ends; `client.templates`, `getTemplate` and `deleteTemplate` do the rest. `client.create(name, { template: "web" })` clones a template's current build, or the one `web@N` names, with the sizes given, and `machine.template` names the build. `{ recorded }` runs once the server has recorded the create, before the wait, with the machine it recorded.
- `client.ensure(name, { spec, checkpoint, sizing, labels })` answers a machine of `name` that runs: the one that exists, started or resumed; else one restored from `checkpoint` when that is ready, at `sizing` or its own; else one created from `spec`. A failed create's row that still answers `Conflict` is deleted and the make tried once more, and a make whose reply was lost reads the machine and decides again, once. `labels` go on what it makes.
- `client.pauseMachine({ id, capture })` waits for the machine to pause and then for the checkpoint to be ready, failing with the capture's error when it failed.
- `client.execMachine({ id, argv, user, env, stdin, timeoutSeconds })` runs a command and answers `{ exitCode, output, truncated }`; the client waits as long as the command runs, or `timeoutSeconds` and the reply timeout. `client.listMachines({ labels })` and `client.listCheckpoints({ labels })` filter by labels; `client.machines` and `client.checkpoints` list everything.

## Sandbox Agent provider

`@gjermundgaraba/clankerbox-rivet-sandbox-agent` is a provider for Rivet's [Sandbox Agent](https://github.com/rivet-dev/agents/tree/main/sandbox-agent) SDK whose sandboxes are clankerbox machines, reached through an `ssh -L` tunnel pinned to the machine's host key.

```ts
import { clankerbox } from "@gjermundgaraba/clankerbox-rivet-sandbox-agent";
import { SandboxAgent } from "sandbox-agent";

const sandbox = clankerbox({
  server: "http://100.64.0.1:8484",
  from: { template: "agent" },
  sshArguments: ["-i", "/path/to/key"],
});

const sdk = await SandboxAgent.start({ sandbox });
const session = await sdk.createSession({ agent: "claude" });

await session.prompt([{ type: "text", text: "Summarize README.md" }]);
await sdk.destroySandbox();
```

- A sandbox comes from a template (`{ template }`, `agent` or `agent@3`), a checkpoint (`{ checkpoint }`) or a fork (`{ machine }`). Build the template from a recipe below once, with `clankerbox template build agent recipes/ubuntu --base ubuntu --cpu 2 --ram 4G --disk 20G`. Any source may add `cpu`, `ramMib` and `diskGib`: larger than the build's, as `create --template` takes them, or for the copy, as `restore` and `fork` take them. The key the tunnel logs in with must be in the server config's `authorizedKeys`.
- `sandbox.resize(id, sizes)` resizes a sandbox's machine as `resize` does, and answers its sizes; `id` is the machine's name, `sdk.sandboxId` without its `clankerbox/`. For what a running machine can't take, `pauseSandbox`, resize, then `sandbox.ensureServer(id)`.
- A sandbox's ID is `clankerbox/<machine name>`; `pauseSandbox` stops the machine and `destroySandbox` deletes it. Stop a sandbox's machine rather than `clankerbox pause` it: a reconnect resumes a paused one with its old agents, which then run beside the sessions the SDK replays into new ones, and a paused one can't be forked. A create that fails deletes the row it may have left, unless the answer is `Conflict`, as the name is another machine's, `Superseded`, as a later request owns it, or `Unavailable`, as the server may still act on it: the error's `made` names the machine to read or delete.
- `recipes/ubuntu/` (linux) and `recipes/macos/` (mac) install the server, Node and Claude Code, and run the server as the login user, whose home, `/home/admin` on Linux, is the default `cwd`; on macOS, give `cwd: "/Users/admin"`. Each takes an optional `agent.env` beside its `setup.sh`, of `NAME=value` lines, such as `ANTHROPIC_API_KEY=…`, so keep a recipe with one private.
- A tunnel that ends, say because its machine stopped, stays down until `sandbox.ensureServer(id)` or a new `SandboxAgent.start`.
- `effect`, `@effect/platform-node` and `sandbox-agent` are peer dependencies.

## Amp orb provider

`@gjermundgaraba/clankerbox-amp-orbs` is the dispatch program for [Amp's self-hosted orbs](https://ampcode.com/docs/orbs/self-hosted): `amp orb provider` runs it once per job, with the job in its environment, and each orb is a clankerbox machine on a linux host.

```sh
npm install --global @gjermundgaraba/clankerbox-amp-orbs
amp orb provider "$(command -v clankerbox-amp-orbs-dispatch)"   # a one-line script: exec clankerbox-amp-orbs --config /etc/amp-orbs.json
```

```json
{
  "server": "http://127.0.0.1:8484",
  "sizes": {
    "default": { "cpu": 4, "ramMib": 8192, "diskGib": 40 },
    "large": { "cpu": 8, "ramMib": 16384, "diskGib": 80 }
  },
  "snapshotExpiry": "14 days"
}
```

- `sizes` has an entry per orb type Amp's settings define, and `default` for a thread that picks none; a type the settings don't know gets `default` too. `user` is the image's login user, `user` as in Amp's image. `snapshotExpiry` is how long a saved project snapshot is kept, 14 days unless given.
- A spawn makes the orb's machine run, `client.ensure` with the machine named after `ORB_ID`: started or resumed when it exists, else restored from the project snapshot `ORB_SNAPSHOT_ID` names when that checkpoint is ready, at the snapshot's sizes, else created from `ORB_IMAGE` at the orb type's sizes, with no setup. Amp's image carries what bootstrap needs, so nothing is installed, and a create without a setup needs no `admin`, `sudo` or key. Then `execMachine` starts `amp orb bootstrap` as the login user, detached, with `ORB_TOKEN` and `AMP_URL` in its environment, after ending one still running: a resumed or restored machine keeps the processes it paused with, and that bootstrap holds the previous job's token. Bootstrap logs to `~/.amp-orb-bootstrap.log` in the orb.
- A pause with a snapshot of a running machine deletes the checkpoint of that snapshot's name, then `pauseMachine` with `capture` makes the new one, labelled `amp-orb` and `amp-snapshot` and expiring after `snapshotExpiry`, and the pause begins once the capture has. A machine that isn't running is paused without a snapshot, and a pause of an orb with no machine does nothing. A linux checkpoint holds RAM, so a restore resumes where the pause left off.
- A delete deletes the machine; one already gone is done. Snapshots are a project's, not an orb's, so they stay until they expire or a pause replaces them.
- An Amp ID that is a clankerbox name, as `amp-<thread id>` is, names the machine; another gets its letters and digits with a digest of it, and the machine carries the ID as its `amp-orb` label either way, `amp-orb-type` the orb type.
- Each job is safe to repeat and fails after 4½ minutes, within the five Amp gives, saying that the control plane still acts on what was asked. Its output goes to the provider's log, and a spawn's to the thread's setup log too.
- The image has no tailscaled, so a host that joins its machines to the tailnet reports the orb's join `missing` and nothing else; the orb needs only outbound HTTPS.

## Release

A pushed tag publishes. Bump the version of every published package, commit, tag `v<version>`, and push the tag. `.github/workflows/npm.yml` checks that the tag names that version, then publishes each package whose version npm doesn't have yet, through npm trusted publishing. A new package's first version is published by hand with `vp pm publish`, then trusted with `npm trust github <package> --repo <repo> --file npm.yml --allow-publish`, which confirms at a terminal and signs in through the browser.

## License

MIT, see [LICENSE](LICENSE).
