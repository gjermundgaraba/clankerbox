# clankerbox

clankerbox runs machines (VMs) for coding agents and reports where each one is reachable over SSH.

- Lifecycle: create, start, stop, pause, resize, delete, fork, checkpoint capture and restore.
- Four runtimes a host can run: `smolvm`, Linux guests on a Linux host, with RAM forks and RAM checkpoints; `tart`, macOS guests on a Mac under Tart, with disk copies; `smol-cloud`, Linux guests at the smol cloud provider under one account, with checkpoints that keep RAM and disks; and `boat`, Linux sandboxes of a [boat](https://boat.dev/) account, in its fixed machine types, with disk copies. Each host reports its runtime's traits, and each machine and checkpoint keeps those of the runtime it was made on.
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
clankerbox-host  ...           on a Linux box, a Mac or a cloud account, no database
  runs whole operations        on smolvm, Tart, smol cloud or boat
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
| The control plane comes back | It finds each step in flight on its host, and carries on. A template build that was running ends failed and its builder is deleted, since a setup is never stored. |
| A host is unreachable | Its machines read `unknown`, phase `waiting`. A request on one stays saved, and its wait reads on as through an outage of the control plane, ending `Unavailable` once the host has been unreachable for two minutes; it acts when the host is back. A create goes to another host, and only fails if no host could take it. |
| A host restarts | Its VMs stay up. A step it held ends, and the control plane decides afresh from the VM's state. An `exec` through it fails at once, as its request is cut when the host stops. A create it held is undone, and a capture it held fails and leaves no checkpoint. A smolvm host that starts, or whose create's boot is cut short or fails, removes the VM smolvm runs to seed an image for a machine's first boot when the smolvm call that ran it has ended, and resumes a machine a pause cut short by the restart left half-paused, so the pause decided afresh runs its pause hook in a running guest. |
| A template build's host stops answering | The build rides out a fault shorter than a recheck, 30 s, and fails `Unavailable` past that, and the template's current build stays as it was. Its builder goes once the host is back. |
| A create fails | The VM is deleted, again at each recheck while that fails, and the row stays `failed` to say why, for a day once the VM is gone. `delete` clears it. A create of the name replaces it once the VM is gone, and answers `Conflict` until then. |
| A host has no room for a create | The create moves to the next host. |

Machines and checkpoints stay on the host they were made on: forks and restores land beside their source, and machines don't move between hosts yet.

The control plane is one instance over one SQLite file. Back up its state directory: it is the only record of what exists.

The npm packages are `@gjermundgaraba/clankerbox` (the CLI), `@gjermundgaraba/clankerbox-server`, `@gjermundgaraba/clankerbox-host`, and the TypeScript SDK `@gjermundgaraba/clankerbox-sdk`. All four share a version, and a control plane refuses a client or host of another `major.minor`, so upgrade them together. `clankerbox hosts` shows such a host `incompatible`, with why under `PROBLEM`, as it does one that answers in another contract, and the control plane uses it for nothing: a create passes it over, saying why.

## Install

Each package needs Node 26.13 or later. The CLI bundles everything it runs. The control plane and the host bundle the SDK and the host contract, and install `effect`, `@effect/platform-node` and `@gjermundgaraba/effect-actions` from npm, the control plane `xstate` too, with what those depend on. The SDK takes `effect`, `@effect/platform-node` and `@gjermundgaraba/effect-actions` as peers, from the program that uses it.

```sh
npm install --global @gjermundgaraba/clankerbox          # where you run commands
npm install --global @gjermundgaraba/clankerbox-server   # on one machine
npm install --global @gjermundgaraba/clankerbox-host     # on each host
clankerbox --version
```

Each host needs its runtime, installed by the operator:

| Runtime | Host | Prerequisite |
| --- | --- | --- |
| smolvm | Linux/amd64 with KVM | smolvm 1.34.0 or later, upstream, in a versioned prefix; runs as root |
| tart | Apple Silicon, macOS 26 or later for the base's ASIF disk, checked on 27.2 | Tart 2.41.1 or later, Softnet 0.25.0 installed SUID root |
| smol-cloud | Any host that reaches `api.smolmachines.com` | A smol cloud account's API key, in a file only the host's user reads |
| boat | Any host that reaches `boat.dev` and its sandboxes' SSH | A boat account's API key, in a file only the host's user reads, and OpenSSH's `ssh` and `ssh-keygen` |

smolvm, with both disk templates expanded beside their `.zst` files:

```sh
version=1.34.1
prefix=/opt/smolvm/$version
HOME=$prefix install.sh --version $version --prefix $prefix --no-modify-path
for t in storage-template.ext4 overlay-template.ext4; do
  zstd -d --sparse $prefix/$t.zst -o $prefix/$t
done
```

A box runs one smolvm host. smolvm counts each VM's uid up from the same base in every host's state and names its systemd scope by the VM alone, so a smolvm host holds the abstract unix socket `@clankerbox-smolvm-host` while it runs, and a second one, under any `stateDir`, refuses to start, naming the first's PID and `stateDir`. The kernel frees the name however a host ends, so an old `stateDir` left beside the live one stops nothing. The lock holds between hosts in one network namespace, as an abstract socket belongs to one, and a host older than 0.41 holds none, so stop an old host before you start a new one on its box. Any local process can take the name first: a host then waits at most a second for that process to answer, refuses to start, saying so, and `ss -xlp | grep clankerbox-smolvm-host` names that process.

smolvm runs every VM in `smolvm.slice`. Cap it at 97% of physical RAM, once per host, so that VMs that outgrow the RAM budget are killed rather than the host's own services. The host doesn't check for it; `systemctl show smolvm.slice -p MemoryMax` does.

```sh
printf '[Slice]\nMemoryMax=97%%\n' > /etc/systemd/system/smolvm.slice
systemctl daemon-reload
```

Softnet, for Tart: `sudo install -o root -g wheel -m 4755 softnet /usr/local/bin/softnet`.

### Upgrading smolvm

A smolvm host's runtime pin names the smolvm release in its `runtime.smolvm.prefix`, so moving it to another release:

- Start or stop each paused machine first. It resumes only under the smolvm that paused it, so after the move a `start` or `stop` of it fails `PinMismatch` and it can only be deleted. A stop needs room for one machine at a time.
- Install the new release into its own prefix, as above, point `runtime.smolvm.prefix` at it and restart the host. Keep the old prefix until its last machine is deleted, since running VMs and their disks still use it.
- A machine left running across the move can't be forked or captured until it is stopped and started again, and its next pause stops it: a `fork`, `checkpoint capture` or `pause --capture` of it answers `PinMismatch` and records nothing.
- RAM checkpoints captured before can't be restored: a `restore` of one answers `PinMismatch` and records nothing. Delete them, and capture again where needed.
- Each template build's copy on the host is `outdated`, so no create from it goes there: build each template again once every smolvm host has moved.
- The first create of each base pulls its image again.

## Run a host

A host process runs one runtime from one JSON config file:

```json
{
  "id": "smolvm-1",
  "listen": { "address": "100.64.0.10", "port": 8484 },
  "stateDir": "state",
  "bases": {
    "ubuntu": "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7"
  },
  "runtime": { "smolvm": { "prefix": "/opt/smolvm/1.34.1" } }
}
```

- `id` is short and lowercase. The control plane's config names the host by it.
- `listen.address` is a tailnet address or loopback, and machines' SSH ports are published on it.
- `stateDir`, relative to the config, holds the runtime's files. On smolvm it is at most 52 bytes and outside every home directory, such as `/srv/clankerbox/smolvm`.
- `bases` maps names clients ask for to images, pinned by digest. A name holds no `/`. Hosts offering the same image should use the same name, as a create may land on any of them. The release was checked on smolvm's `ubuntu` above and on Tart's `macos`, `ghcr.io/cirruslabs/macos-golden-gate-xcode@sha256:d7641b1d985fd53fbac071c663bf249007b9b387e16b7d576144588acb1d93f9`, Cirrus's Xcode 27.2 on macOS 27, whose 140 GB ASIF disk takes a `diskGib` of 131 or more: 130 GiB rounds to 140 GB, and Tart refuses to set an ASIF disk to its own size as it refuses a smaller one. A smolvm host also creates from any image reference a create names as its base, one with a `/`, such as `registry.example/team/image:tag`. A template build records the image its base named and clones its own copy, so a build made from a tag keeps the image the tag named then.
- `runtime` names the host's one runtime, with its settings: `{ "smolvm": {prefix, ramBudgetMib?} }`, smolvm's install, `{ "tart": {binary} }`, the `tart` executable of a versioned install, `{ "boat": {apiKeyFile, api?} }`, a boat account (see below), or `{ "smol-cloud": {apiKeyFile, api?, ttlSeconds?} }`, smol cloud's machines under one account, with the key in the file `apiKeyFile` names, an absolute path. `api`, optional, is the provider's URL, `https://api.smolmachines.com` by default, and is `https`, or `http` only to a loopback address, as the key rides on every request. The host runs each command in a smol cloud machine through the provider's exec API, so every stdin it gives one, a template's setup script, a tailnet join's key and an `exec --stdin` included, reaches the provider in an exec request's body. That body holds at most a MiB as JSON encodes it, so a larger stdin reaches the guest's tmpfs first, in pieces that each fit, and the command reads it from there. A smol cloud host names each machine `cbx-<host id>-<instance>`, so its `id` is at most 26 characters, and it lists only what carries its own ID: run one host per account, or give each host of an account its own ID. At each check it deletes only the machines it made that the control plane retired there: one whose row is gone, or whose create failed or moved to another host, as one whose answer was lost and that landed late. A checkpoint the provider holds through its machine, such as the one a pause leaves or a capture whose answer was lost, goes at the machine's next start or its `delete`, unless a checkpoint row keeps it. A record in the provider's lists it can't read fails the list only when it is the host's own, by its name or its machine's, and is skipped otherwise, logged once. The host waits at most 30 seconds for the provider's answer to a read, a minute to a change, and 5 minutes to a start, stop, pause, resume, branch, resize, capture or the head of an exec, which it answers once the machine settles, and takes a request unanswered by then as one whose answer was lost. Its room, as `capacity` reads it, is the account's limits on running machines and on machines kept, with the vCPUs and RAM its running machines hold, for the whole account. A machine larger than the account lets one machine be, 4 vCPUs, 16G of RAM and a 200G disk on an account without a card, is refused `Unsizable`, made or resized. `ttlSeconds`, optional, has the provider delete each machine the host creates from an image that long after it is made; a restore from a checkpoint carries no expiry. The host publishes each machine's port 22 at the provider, which its tunnel and a kernel-mode tailnet join need, and whether the provider's `hostPort` for it answers from outside is not settled; sshd there takes keys only. A client reaches it through the host's relay on `listen.address`, which dials the provider's tunnel with the account's key, so a client holds no smol cloud credential.
- `ramBudgetMib` is the RAM a smolvm host admits machines up to. By default it is physical RAM less smolvm's own reserve for the host, 6% of it, but at least 8 GiB and at most a quarter: at most 94% of it, below `smolvm.slice`'s cap of 97% (see Install), which leaves room for each VM's own memory beside its guest's. A budget set past the cap overcommits physical RAM, which works while branches share their bases' pages, and past the cap the kernel kills a VM.
- `machinePorts: {first, last}`, optional, is the range machines' SSH ports come from, 10000–19999 by default; `listen.port` lies outside it. A host refuses to start with machine ports in its box's ephemeral ports: on Linux the box's own `net.ipv4.ip_local_port_range`, read as the host starts, or the default 32768–60999 where it can't be read, and 49152–65535 on macOS. A Linux box set to hand out every port from 1024 up, as `1024 65535`, leaves machines only the privileged ports below 1024: narrow its range first, as with `sysctl -w net.ipv4.ip_local_port_range="32768 60999"`, and keep it across a boot with the line `net.ipv4.ip_local_port_range = 32768 60999` in a file under `/etc/sysctl.d/`. A smolvm host also refuses them in 20000–31999, the ports smolvm picks for a fork.
- `tailnet: {oauthClient: {id, secret}, tags, buildTags?}`, optional, joins the host's machines to the tailnet, and a template build's builder for its setup (see below). A builder's node carries `buildTags`, or `tags` without them, so the tailnet's policy can grant a build what it grants no machine, or the reverse. The client needs the `auth_keys` scope and every tag; its secret never leaves the host.
- `builds: {endpoint, bucket, region, accessKeyId, secretAccessKey}`, optional, is the S3 bucket template builds are copied through, so a create from a template can land on any host of its runtime (see Templates). `endpoint` is an `http(s)` URL with no path and no credentials, such as `http://127.0.0.1:8333`, and addressed path-style. Every host of a runtime names the same bucket; the secret never leaves the host. A host without it keeps its builds to itself. A smol cloud or boat host keeps its checkpoints at its provider, not as files, so it refuses to start with `builds`, and keeps its builds to itself.

A boat host drives one boat account:

- `apiKeyFile` names the file holding the account's API key, and `api`, optional, is boat's API, `https://boat.dev/api/v1` by default, and is `https`, or `http` only to a loopback address, as the key rides on every request. The host waits at most 30 seconds for boat's answer to a read and a minute to a change, and takes a request unanswered by then as one whose answer was lost.
- The host labels each sandbox it makes with its `id`, and lists only those, so give each host of an account its own ID. It sends each create and fork under the Idempotency-Key `cbx-<host id>-<instance>`, so no two hosts and no two creates share one. When a create's answer is lost, the host looks for the sandbox by its labels before it sends the create again, under the same key; boat counts a start for a create it refuses because one under its key is still in progress, so the host then waits for the sandbox to be listed instead of sending a third. At each check it deletes only the sandboxes the control plane retired there. Its room is the account's limit on active sandboxes and the starts boat counts per minute, hour and day, which `capacity` reads for the whole account, so two hosts of one account each count the other's machines too.
- Its one base image is `ubuntu-24.04`, Ubuntu 24.04 on x86_64, so `"bases": { "ubuntu": "ubuntu-24.04" }`. Any other image a base names is a saved snapshot of the account, by its name.
- A machine's sizes must be one of the machine types the account's plan offers, as `GET /limits` lists them when the host starts: `small` (2 vCPUs, 4G of RAM, 80G of disk), `default` (4, 8G, 80G), `large` (8, 16G, 149G), and `xlarge` (16, 32G, 251G) on the plans that offer it. Any other sizes are refused `Unsizable`, naming the types; nothing rounds.
- A pause stops the machine, and a running machine can't be resized. A stopped one changes type on boat's next start of it, which the resize spends and stops again. boat counts every start, and a start within minutes of a stop gives back the same machine and counts none.
- A checkpoint is a saved snapshot, `cbx-<instance>`, of a stopped machine's disk, and a fork copies a stopped machine's disk. The host finds each snapshot through the machine it was saved from: the machine's next start and its `delete` unsave each of its snapshots no checkpoint row keeps, such as one a capture whose answer was lost saved. A `delete` looks again once the sandbox is gone, for a save that landed meanwhile, since boat keeps a snapshot past its sandbox. boat's snapshots carry no labels, so names of that shape, `cbx-` and 32 hex digits, are reserved: a snapshot of your own of a machine a host made, so named, is unsaved with it; any other name is left alone. A saved snapshot the host can't read fails its list only when its name is of that shape.
- Every sandbox is made with no account secrets, no command history and no auto-stop. Setups and commands reach the guest over SSH from the host, never through boat's API. The host keeps its own SSH key in `stateDir`, readable by its user alone, and refuses to start, saying how to mend it, when it finds one others can read, which OpenSSH would refuse at every command.
- A boat guest's sshd also answers on boat's public address, with key-only login. clankerbox never hands that address to a client, which reaches the machine through its host, and can't close it, since boat resets a guest's firewall rules on every start.

```sh
clankerbox-host --config /etc/clankerbox/smolvm-1.json
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
    { "id": "smolvm-1", "url": "http://100.64.0.10:8484" },
    { "id": "tart-1", "url": "http://100.64.0.20:8484" }
  ]
}
```

- `listen.address` is a tailnet address or loopback: this API can change every machine, and takes no key.
- `hosts` is in placement order: a create goes to the first that offers its base and has room, and a create from a template to the first that holds a copy of its build and has room. A create or a template build that names a host goes to that host alone.
- `draining: true` on a host passes it over for new machines, and leaves what it runs alone.
- `stateDir`, relative to the config, holds `server.db`. One process holds it at a time.
- `authorizedKeys`, relative to the config, is a public-key file, such as an `id_ed25519.pub`, or several concatenated: each line that isn't blank is `<type> <base64> [comment]`, so a private key or any other file is refused. The control plane reads the file as it starts and sends the keys with every template build's setup and every create that clones a template's build, and the host installs those it lacks for the login user once the setup exits 0 or the clone is made. A template's build holds the keys its setup was sent, and a clone of it adds any key it lacks, so a key added since the build reaches it, and one removed since stays. A create from a base gets none, and a fork or restore of a checkpoint only those its source had. The keys are never stored or logged. To change them, edit the file and restart the control plane: machines made after it take the new set, and those made before keep theirs.
- `hookTimeout`, a whole number of seconds above 0, is how long a machine's guest hook may run before its stop, pause or delete (see Writing a setup), 120 unless set. The Amp orb provider gives each job 270 seconds for its capture, hook and pause together, so keep it well under that when orbs are used.
- To add a host, add its line and restart the control plane. Machines keep running through the restart, and clients need nothing.

```sh
clankerbox-server --config /etc/clankerbox/server.json
```

The control plane exits 130 on SIGINT or SIGTERM and 1 when it fails. It stops at once: a write it began commits whole, and a request still open, an `exec` or a held read, is cut as a crash would cut it, so a mutation whose reply it cut answers `Unavailable` saying it may have run, and a read `Unavailable`, which a wait reads on through until it is back. A client reads a reverse proxy's 502, 503 or 504 in front of the control plane the same way. Its log holds what an operator acts on: a host that stops answering and answers again, a step a host refuses, a request that answers `Internal` or fails as no action declares, a loop, recheck or build that fails, and an expiry. Each line of a machine's or checkpoint's own work names it, and the step it follows. An answered request, a refusal or a path no route takes included, logs at debug, which `--log-level debug` shows, and a request its client abandons or the stop cuts logs nothing.

### Upgrading from 0.40

In a smolvm host's unit, set `KillMode=mixed` and `TimeoutStopSec=300` where `KillMode=control-group` stood, and run `systemctl daemon-reload` before the restart, so the restart's own stop already spares a smolvm call the host has begun (see Deploy).

Stop a 0.40 smolvm host before you start the new one on its box, as an upgrade does in its unit: a 0.40 host holds no box lock, so the new one can't tell it runs.

A machine a 0.40 smolvm host made under such a name, `image-seed` or `init-bake` or one beginning `image-seed-` or `init-bake-`, is left alone by the new host, but smolvm deletes it at its next seed build or init bake once it is 30 minutes old, as it already did under 0.40: fork it to another name to keep it.

A host now refuses `machinePorts` only in the ports its own box and runtime take (see Run a host), where 0.40 refused smolvm's fork ports and both Linux's and macOS's default ephemeral ports on every host. A config 0.40 took starts unchanged, but on a Linux box whose `ip_local_port_range` was tuned to reach into its `machinePorts`, which the host now reads and refuses, naming the range. An `exec` whose command name holds `=`, such as `/opt/x=1/tool`, now answers 127 where 0.40 ran it when given no `--env`. Every `exec` now runs through the guest's `/bin/sh` and `env`, where 0.40 handed a root exec given no `--env` straight to the runtime, so a machine from an image that lacks either, which a smolvm host can create from any image, no longer runs one, and a command's environment gains what the guest's shell adds, such as `PWD` and `SHLVL` (see Use the CLI).

A host config's `kind` and its block become `runtime`, an object naming the host's one runtime with that block's settings: `"kind": "linux"` with `"linux": { "prefix": ... }` becomes `"runtime": { "smolvm": { "prefix": ... } }`, and `"kind": "mac"` with `"mac": { "binary": ... }` becomes `"runtime": { "tart": { "binary": ... } }`. A host whose config still says `kind` refuses to start, saying so. Nothing else in a host config or the server config changes, host IDs included. The host contract changed, so upgrade hosts and the control plane together.

State carries over: the control plane migrates its database on its first start, stamping each machine and checkpoint with its runtime's traits from its kind, and a database holding a kind it doesn't know is refused, unchanged. A migrated machine or checkpoint has no handle, the name its runtime knows it by, until its host's first answer after the upgrade: a machine's comes with the adopt that follows the host's start, and each checkpoint's, a template build's copy included, with the recheck's find, again at each recheck until its host finds it in time, so until then a step that names one searches its runtime for it. `clankerbox hosts` prints `RUNTIME` where it printed `KIND`, `hosts --json` gives each host that answers `runtime` and `traits` in place of `kind`, and `get --json` gives a machine `traits` in place of `kind`: `traits.runtime` is `smolvm` where `kind` was `linux`, and `tart` where it was `mac`. A checkpoint's `kind` stays `ram` or `disk`. In the SDK, `Kind` and `checkpointKinds` are gone: read `machine.traits`, and `traits.checkpoint` for what a capture keeps. `create` and `template build` take `--host`, and the API's `host`, to land on one host.

What a client reads changes in a few places:

- A `fork` or `checkpoint capture` of a machine at rest in the state its host doesn't copy answers `WrongState` before anything is recorded, where it left a failed row of the copy's or checkpoint's name; `forkMachine` and `captureCheckpoint` declare `WrongState`.
- A machine's `traits` gain `stop`, `resumes` on smolvm and smol cloud and `discards` on Tart and boat, and the migration stamps it on every row.
- A machine shows `ssh` only once its host has read it an SSH host key, so a machine created from a base on smolvm, which has no sshd, shows none, and `ssh` answers `WrongState` saying why. A machine on a host that can't be read shows its login if it was last read running and is asked to run still, and `ssh` and `ssh-proxy`, the SSH config's ProxyCommand, give up on an endpoint that hasn't connected and spoken within 15 s of the dial, naming it.
- `checkpoint list` and `listCheckpoints` show every checkpoint in any phase, as `checkpoint get` does, and the table adds `ERROR`.
- A create whose sizes no host that offers the base gives answers `Unsizable`, not `NotOffered`, and so does a template build. A refusal carries `made` only where something may have been made.
- `hosts` shows `incompatible` for a host of another release or contract, which the control plane uses for nothing. `capacity` says of such a host that it is incompatible, and why, and of one that doesn't answer why; in `--json` and the SDK's `CapacityReport`, `unreported` lists each with its `host`, `state` and `problem`, replacing `unreachable`. An `exec` on a machine there answers `Unavailable`, saying why the host is incompatible, with `readOnly` set, since nothing reached it.
- `pause --capture` on a host whose traits capture a stopped machine and stop it on a pause, as boat, pauses first and captures what the pause left, and on one that saves it, as a Mac, answers `WrongState`. A host that can't be read answers `Unavailable`.
- A retired instance's day now runs from the first sweep that reached its host and left nothing of it, a provider whose deletes fail keeps the record until one succeeds, and the migration retires every row that already rested undone or failed, so its host's next sweep deletes what such a make left.
- A mutation's `--timeout`, and the SDK's `timeout`, bound its reply and its wait together, where they bounded the wait alone, so a capture whose host can't be read ends within it.
- `ssh`, and an ssh through the SSH config clankerbox keeps, end a session whose endpoint leaves 4 of ssh's checks, 30 s apart, unanswered, where nothing ended one that went silent after its banner; a network that drops for longer than two and a half minutes ends a session too (see Use the CLI).
- The control plane logs an answered request at debug, not at info, a path no route takes at debug, not at error, and a request its client abandons or its stop cuts not at all.

### Upgrading from 0.30

Hosts and the control plane start fresh: 0.30's machines aren't carried over. Before you upgrade, delete each machine and checkpoint with the old release, then stop its host, and remove its `stateDir`. IDs no longer carry a host: `linux_dev` is `dev`, and `ssh dev.cbx` replaces `ssh linux_dev`. Client configs name `server` instead of `hosts`, and profiles lose `host`. `clankerbox host` is now `clankerbox-host`.

### Upgrading from 0.38

A smolvm host needs smolvm 1.34.0 or later, and one on an older release refuses to start: move it to 1.34.1 as Upgrading smolvm says, which leaves its RAM checkpoints and template builds from 1.33 unusable on it. Add `smolvm.slice`'s cap (see Install). A host without `ramBudgetMib` admits less than before: 12 GiB of machines' RAM on a 16 GiB host rather than 14 GiB, 56 GiB on a 64 GiB one rather than 62 GiB.

### Upgrading from 0.36

State carries over. A template's build now holds the server config's `authorizedKeys`. A build made before keeps none, and a create from it still installs them, so nothing needs a rebuild.

A host now prepares a base before its setup runs, and runs the setup as `admin` rather than root: see Writing a setup. A setup that creates `admin` itself fails where it does so unguarded, as `useradd` refuses a user that exists, and one that writes outside `admin`'s home needs `sudo`. Upgrade hosts and the control plane together.

`template build` now takes one template file, `NAME.yaml`, which holds the base, the sizes, the setup and its timeout (see Templates), and `--base`, `--cpu`, `--ram`, `--disk` and `--setup-timeout` are gone from it. A build no longer takes anything from the build before it, so write each template's file in full: a file without `setupTimeout` gets the host's default. `client.buildTemplate` needs `base`, `cpu`, `ramMib` and `diskGib` on every build.

A create runs no setup: `create --setup` and `create --setup-timeout` are gone, and the API's `createMachine` refuses a `setup`. Build a template from the setup instead, by writing a template file `NAME.yaml` that names it and running `clankerbox template build NAME.yaml`, and create with `--template NAME`; in the SDK, call `client.buildTemplate` with the setup and create with `{ template }`. A create from a base still works, with no setup and no keys. The control plane migrates its database on its first start, and keeps every machine. A create that 0.36 took with a setup and hadn't made yet is undone, failed, since its setup left with the old control plane: create it again from a template.

### Upgrading from 0.35

State carries over, but the host contract changed: a host's make now carries the authorized keys, so upgrade hosts and the control plane together, since a create placed on a host of the other release fails. The authorized keys moved from each client config to the server config: gather the public keys of every client config's `authorizedKeys` into one file, name it in the server config's `authorizedKeys`, and delete `authorizedKeys` from each client config, which a client now refuses, and from the Sandbox Agent provider's options. Every machine made with a setup, or from a template, then takes every key in that file, and a create sends none. Machines already made keep the keys they have. A client config that still names `authorizedKeys` fails every command, `ssh-proxy` and `ssh-known-hosts` included, so `ssh <name>.cbx` stops working until the key is deleted from that config.

Templates replace profiles and prebuilds. The control plane migrates its database on its first start: it drops the profile from each machine and checkpoint and the prebuild from each machine, and adds the tables templates and their builds take. For each profile you create from, write a template file `NAME.yaml` with the profile's base, sizes and setup (see Templates) and run `clankerbox template build NAME.yaml` once from any client, then create with `--template NAME` instead of `--profile NAME`. Delete `profiles` from each client config, which a client now refuses, and in the Sandbox Agent provider's options give `from: { template }` for `from: { profile }`, and drop `fresh`. `profiles`, `prebuild`, `prebuild get`, `--profile` and `--fresh` are gone. 0.35's prebuilds stay as plain checkpoints, named `prebuilt-<digest>`, which no create restores: delete them with `checkpoint delete`.

A smolvm host parks a base for each build's copy it keeps (see Templates) as it starts. The bases' RAM counts in its budget, so it admits that much less of machines' RAM.

### Upgrading from 0.34

State carries over: the control plane migrates its database on its first start, adding the columns that labels, expiry and a pause's capture take, and nothing on a host changes. Upgrade hosts and the control plane together, as always.

## Use the CLI

The client config is `$XDG_CONFIG_HOME/clankerbox/config.json` (`~/.config` when unset), or `--config PATH`:

```json
{
  "server": "http://100.64.0.1:8484"
}
```

A machine made from a template's build, and a fork or restore of one, is logged in to as `admin`, with the keys of the server config's `authorizedKeys`. A create from a base gets no keys, and only smol cloud and boat prepare it, creating `admin` and installing sshd as a build's setup does: on smolvm, whose images lack both, it has no `admin` and no sshd, and on a Mac it has the base's own `admin`. A machine shows an `SSH` login only once its host has read it an SSH host key, so one without sshd shows none, and `exec` reaches it.

```sh
clankerbox create dev --template web       # waits until it runs, prints dev
clankerbox create review --base macos --cpu 4 --ram 8G --disk 150G
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
clankerbox hosts                           # for an operator: each host, its state, runtime and versions
clankerbox capacity                        # for an operator: each host's resources and limits
```

- A name is unique across every host, per resource type. A checkpoint's name doesn't begin `built-` or `fetched-`, which the control plane gives template builds' copies. A smolvm host makes no machine named `image-seed` or `init-bake`, or beginning `image-seed-` or `init-bake-`: smolvm takes such a VM for a builder of its own and deletes it once it is 30 minutes old, so a create, fork or restore of such a name fails `Invalid`, saying so.
- `create` makes a machine from a template's build (see Templates), or from `--base` with `--cpu`, `--ram` and `--disk`. A create runs no setup: a template's build runs one. `--host ID` places it on that host alone, as `hosts` lists it, as if it were the only one. A host the control plane doesn't know answers `NotOffered`, as does a base no host offers, while sizes no host that offers the base gives answer `Unsizable`, naming the sizes each host gives. One draining refuses a create from a base `NotOffered` and one from a template `NotBuilt`, as does a host without a current copy of the template's build, whose refusal says to build the template there with `--host`. One that doesn't answer gives `Unavailable` when it could have taken the create, so not when it is draining or holds no copy of the build.
- A command waits until the machine rests. `--no-wait` answers once the request is recorded, and `--timeout 10m` bounds the request, its reply and its wait together; either way a request the control plane answered stays saved and acts, and one whose reply hadn't come by then may have run. A wait goes on through a short restart of the control plane.
- Sizes and durations carry their unit: `--ram 8G`, `--disk 60G`, `--setup-timeout 15m`.
- `fork` copies a running smolvm machine with its RAM, a running smol cloud machine, or a stopped Tart or boat machine's disk. `fork` and `restore` take `--cpu`, `--ram` and `--disk` for the copy, its source's by default: a smolvm copy, holding its source's RAM, only grows, live once it runs; a smol cloud copy takes only its source's sizes, its disk's included; a Tart copy takes any vCPUs and RAM, and a boat copy any of the account's types; a disk only grows. `checkpoint capture` does the same, so a smolvm or smol cloud checkpoint is `ram` and a Tart or boat one `disk`. A `fork` or `checkpoint capture` of a machine at rest in the other state answers `WrongState` and records nothing, so it leaves no row, and one of a machine still moving is recorded and its host decides. A `fork` takes its host's traits and its source's sizes as the host answers now, so one whose host can't be read answers `Unavailable` and records nothing; a `checkpoint capture` of such a machine is recorded, reads `capturing` until the host answers, and its host decides. A machine's `traits`, in `get --json`, say which of these hold for it.
- `start`, `stop` and `pause` ask for a state and wait until the machine is there; a request fails `Superseded` when a later one for the same machine asked for something else before it got there. `delete` waits until the machine is gone, and nothing supersedes it. A machine that stops by itself while asked to run is started again at the control plane's next check, every 30 s.
- `pause` saves a running machine's RAM, processes and disks and stops its VM, so it holds no RAM, and on a Mac none of its two VMs, until a `start` resumes it where it was. A `pause` leaves a stopped machine stopped, and a paused machine can't be forked or captured. A `pause` stops a machine it can't save, which then reads `stopped`: on smolvm one booted under another smolvm build, or before its host recorded which, on a Mac one an older host booted, and on boat every machine.
- On smolvm a paused machine resumes only under the smolvm build that paused it: after a host moves to another one, a `start` of it fails `PinMismatch` (see Upgrading smolvm). A Mac tries the resume under any Tart and macOS, and a restore it can't make fails, keeping the saved state: a `stop` discards it, and the next `start` boots from the disk.
- A `stop` of a paused machine resumes it to end its processes where the machine's traits' `stop` is `resumes`, as on smolvm and smol cloud, needing room as a start does, and on smolvm fails `PinMismatch` after an upgrade too; where it is `discards`, as on a Mac, it discards the saved state without booting. Each keeps the disk.
- On a Mac, macOS restores a VM's state only in the operator's unlocked login session: a `start` of a paused machine while it is locked fails and keeps the saved state (see Deploy).
- `resize` changes vCPUs and RAM as the machine's `traits.resize` takes them in its state: a stopped smolvm or Tart machine takes any, a stopped boat machine any of the account's types, which spends a start (see Run a host), a stopped smol cloud machine only larger ones, and a running smolvm or smol cloud machine grows live, needing room for its RAM as a start does; smaller ones where a runtime only grows fail `Unsizable`. A running Tart or boat machine or a paused one is refused, so stop it first. A disk only grows: smolvm grows the guest's filesystem, at once when it runs, smol cloud grows the disk at the provider, boat gives the disk of the type, and on a Mac the base's Tart guest agent grows APFS at the next boot. A resize waits for a step under way, and keeps what the runtime gave when it fails part way, or when the host stops during it, which the machine's sizes then show; asking for the same sizes again finishes a live grow that failed part way. A `resize` answers at the machine's next rest under any later wish but a delete, as each runs after it.
- A create, fork or restore whose make or copy fails deletes its VM, keeps its row for a day to say why, and answers the error; so does a fork, a restore or a create from a template whose preparation fails, as each prepares its copy in the step that makes it. A delete that fails runs again at the next check. A create that a host had no room for moves to the next host first, unless the control plane restarted since it took the create. Only a `delete` stops a machine being made: a `stop` waits for it to be made, then stops it. A `start` on a running machine runs its preparation again.
- A request on a machine whose host can't be reached stays saved, and its wait reads on, failing `Unavailable` once the host has been unreachable for two minutes; it acts once the host answers. A capture on such a machine reads `capturing` until the host answers, so `checkpoint capture` waits that long, or until its `--timeout`.
- A machine being deleted can't be captured or forked: either answers `NotFound`.
- A checkpoint is `ready` until its delete begins, and a delete that fails runs again. `checkpoint list` shows every checkpoint in any phase, as `checkpoint get` reads it and as `machines` shows a failed create: a failed capture, kept a day, with its error under `ERROR`, and one being deleted. Only a `ready` one restores.
- `exec` runs a command in a running machine through its host, as root or `--user`, which runs it through the guest's `sudo` with that user's groups and home, as a login would have them, with `--env NAME=VALUE` set, or `--env NAME` with `NAME`'s value in this shell's environment, an empty one included, and, with `--stdin`, this stdin sent whole. A secret is safest on stdin, which no command line shows, then as `--env NAME`, whose value shows only on `env`'s command line in the guest, for an instant, as below, and never as a `VALUE` on the command line, which shows in the client's process arguments to every user of its computer. An argument, `--user` or `--env` value holding a NUL byte, which no program can be given, and a `NAME` that isn't a variable's name, a letter or `_` then letters, digits and `_`, are refused `Invalid` before anything is sent. It prints the command's output, its last 65,536 characters, saying on stderr when it was cut, and exits with the command's code. It waits for a step under way on the machine first, and a stop, pause or delete asked meanwhile ends it. `--timeout 90s` ends the command and exits 124. Nothing of a command is stored or logged, and its arguments and `--env` reach the guest on the stdin of its `/bin/sh`, so no command line on the host shows them. In the guest, that shell hands them to `env`, which sets each `--env` name exactly as given, whatever the guest's `/bin/sh` makes of names such as `UID` or `SHLVL`, and runs the command: `env`'s own command line, which the guest's `ps` shows, holds the `--env` values for the instant before it runs the command, and the command's line holds its arguments while it runs. The guest needs `/bin/sh` and `env` for every exec. The command's environment also holds what that shell adds to it, `PWD` under each, `SHLVL` under bash, zsh and busybox, and `OLDPWD`, `LOGNAME` and `_` under zsh, though `--env` still sets each name it gives exactly. A command whose name holds `=`, or is a lone `-`, answers 127, since `env` would take the first for a variable and the second for `-i`. On a smol cloud machine, a command and its stdin reach the provider (see Run a host).
- `--label KEY=VALUE`, repeated for more, tags a machine or checkpoint when it is made: on `create`, `fork`, `restore`, `checkpoint capture` and `pause --capture`. Labels never change after that, and a copy takes only the labels its own request gives. `machines --label KEY=VALUE` and `checkpoint list --label KEY=VALUE` list what carries every pair given. A resource takes at most 16 labels; a key is a name like a resource's, and a value up to 63 characters. A key that isn't a name is refused `Invalid`, naming it, before anything is sent.
- `--expires 7d` on `checkpoint capture` or `pause --capture` has the control plane delete the checkpoint once it is ready and that long has passed, at its next check; `checkpoint get` shows `EXPIRES`.
- `pause --capture NAME` also captures the machine, and `--label` and `--expires` go on the checkpoint. Its host's traits, as the host answers now, decide when, so a host that can't be read answers `Unavailable` and records nothing. Where `captureFrom` is `running`, as on smolvm and smol cloud, the capture comes first and the pause begins once it has, so the checkpoint holds the machine as it ran, and a stopped or paused machine answers `WrongState`, which says to start it and capture it. Where `captureFrom` is `stopped` and `pause` is `stops`, as on boat, the pause stops the machine first and the capture takes it stopped. Where `captureFrom` is `stopped` and `pause` is `saves`, as on a Mac, no pause leaves a machine a capture takes, so the command answers `WrongState` and records nothing: stop the machine and `checkpoint capture` it, or pause it alone. A capture that fails fails the command with its error once the machine has paused; `checkpoint get NAME` says why.
- `ssh` pins the machine's host key and logs in as `admin`. `get` shows the login under `SSH` while the machine runs, and while its host can't be read (`STATE` `unknown`), if it was last read running and is asked to run still, as its VM may run then; a machine with no host key on record has none, and `ssh` answers `WrongState` saying so. The control plane can't tell whether a client reaches a host it can't, so it shows the login; where the runtime's endpoint is the host's relay, as on Tart, smol cloud and boat, a host that doesn't answer leaves that login dead too, as the relay runs in the host. So `ssh` and `ssh-proxy` give up on an endpoint that hasn't connected and sent its banner within 15 s of the dial, which follows a read of the machine, itself up to 10 s on a host that doesn't answer: `ssh` with ssh's own `Connection timed out during banner exchange`, naming the address, and `ssh-proxy`, and so an ssh through the SSH config clankerbox keeps, with `Unavailable`, naming the machine and the address. That config sets no `ConnectTimeout`, as one would end ssh while the proxy still reads the machine, naming none. Once the endpoint has sent its banner, both `ssh` and that config have ssh ask a quiet endpoint whether it is there every 30 s and end the session, saying `Timeout, server not responding`, after 4 asks go unanswered, so a relay that holds a dead host's connection open ends the session within two and a half minutes, and a network that drops for less than two minutes doesn't end one. `ssh` sets them ahead of your arguments, so a later `-o ServerAliveInterval` doesn't change them; in the config, a `ServerAliveInterval` or `ServerAliveCountMax` of your own for the machine comes first and wins.
- Plain OpenSSH reaches machines as `<name>.cbx`, so `ssh dev.cbx`, scp, rsync and tools that run ssh work. A command on the default client config keeps `~/.ssh/clankerbox` with one `Host *.cbx` block, as `admin`, and ends `~/.ssh/config` with `Match all` and `Include clankerbox`, so your own entries come first and win. Each connection runs `clankerbox ssh-proxy` and `clankerbox ssh-known-hosts` for the machine's current endpoint and host key, so nothing goes stale when a port changes or a machine is recreated, and the connection goes straight to the machine's host. Both run through your login shell, `$SHELL` as of the command that wrote the file (`/bin/sh` without one), so `clankerbox` must be on the `PATH` that shell sets up, even for an app started outside a terminal. `CLANKERBOX_SSH_CONFIG=false` removes both.
- `--json` prints the resource or `{"error": {...}}`.

### Templates

A template is a base, sizes and builds, kept by the control plane, so every client sees the same ones. A template file says how to build one, and its name is the file's: `gg-linux-dev.yaml` builds the template `gg-linux-dev`.

```yaml
base: ubuntu
cpu: 8
ram: 16G
disk: 100G
setupTimeout: 15m
setup: gg-linux-dev
```

`template build` creates a machine from the base at the file's sizes, runs the setup in it, captures a copy of it on its host, and deletes the machine. A create from the template clones that copy, so no setup runs.

```sh
clankerbox template build gg-linux-dev.yaml     # prints gg-linux-dev@1
clankerbox template build gg-linux-dev.yaml     # prints gg-linux-dev@2, from the file as it is now
clankerbox template list                        # each template's current build, its base, and state
clankerbox template get gg-linux-dev            # each build kept, with its base and sizes
clankerbox create box --template gg-linux-dev   # clones its current build
clankerbox create old --template gg-linux-dev@1 --ram 32G # clones that build, with more RAM
clankerbox template delete gg-linux-dev
```

- The file holds `base`, `cpu`, `ram`, `disk` and `setup`, and optionally `setupTimeout`, the host's 10 minutes by default; any other key fails the file. `ram` and `disk` are sizes, such as `16G`, and `setupTimeout` a duration, such as `15m`.
- `setup` is a setup script, or a recipe directory with a `setup.sh`, found from the file's directory. The client reads it and sends it with the build. The control plane holds it in memory for that build only, and never stores or logs it, so each build sends it again.
- Each build takes everything from its file and nothing from the build before it, so a file without `setupTimeout` gets the host's default even when the last build had one. Each build keeps its own base, sizes and setup timeout, which `template get` shows per build, and a template has none of its own.
- A build's ID is the template's name, `@` and its number, such as `web@2`. `template build` waits until the build ends and prints its ID; `--no-wait` prints it at once, and `template get` follows the build. A build number never names two builds: after `template delete`, the next build of the name goes on from the highest number it has had, so a machine whose `TEMPLATE` reads `web@1` was cloned from that build alone, and `--template web@1` answers `NotBuilt` once it is gone.
- The current build is the newest that is ready: it moves to a build only once its setup has run and its copy is made, so a build that fails leaves the one before it current. The control plane keeps the last 2 ready builds, and deletes an older one's copy once the creates cloning it are done.
- One build of a template runs at a time: a build or a delete asked meanwhile fails `Conflict`. A control plane that restarts during a build ends it failed and deletes its builder.
- `create --template NAME` clones the current build, and `--template NAME@N` that build while it is kept; one with no ready build to clone, or none a host that could take its clone holds a current copy of, fails `NotBuilt`, saying why it passed over each host. A create from a template takes no `--base`. It takes the build's sizes, or larger ones from `--cpu`, `--ram` and `--disk`; smaller ones fail `Unsizable`. A smolvm create grows the clone while it runs, so smolvm's limits on a live grow hold: RAM grows in 128M steps.
- A build goes to the first host that offers the base, or with `--host` to that host alone. On Tart and boat the build stops its machine before the copy, so a clone boots from the disk. A host with `builds` then uploads the copy to the bucket, only what the bucket lacks, and the build is ready once that is done, so a build whose upload fails fails. Every other host of the runtime with `builds` that offers the base then downloads a copy of each ready build, only what it doesn't hold already, and the control plane retries a download that fails at each recheck. Without `builds`, a build's copy stays on the host that built it.
- Creates from a build go only to a host whose copy is ready, in the config's order: when none has room the create fails `Capacity`. A copy on a host that now runs another runtime pin, or names another image for the base, than the build was made under is `outdated`: no create goes there, and the host downloads none. `template get` lists each build's copies, `ready`, `fetching`, `failed` or `outdated`, with why. Deleting a build's copy on the host that built it also deletes its objects from the bucket, those no other build holds.
- A smolvm host keeps a parked base of each build's copy it holds, built there or fetched: a VM restored from the copy and frozen, which a create from the build branches instead of restoring the copy. Branches of one base run one at a time, each in a few hundred milliseconds. A build parks its base before it ends, a fetch before it ends, and a host that starts parks one again for each copy it keeps, in the background; a create restores the copy while its base isn't parked or can't be branched. A copy captured under another smolvm than the host's parks no base, so its creates restore. A base holds the RAM its guest touched, which the host's RAM budget counts, as it counts that of the VM smolvm runs while it seeds an image, and `capacity` leaves out, so `capacity` can show more free RAM than the host admits. A base goes once no machine branched from it remains and its build's copy is deleted, the kernel boot it was parked under has ended, or the host runs another smolvm, so a machine cloned from a build keeps its base after `template delete`. `smolvm machine ls` names each `base_<boot>_<copy>`, where `<boot>` is the first 8 hex digits of the kernel's boot ID.
- A build's copy is no checkpoint: `checkpoint list` leaves it out, and `restore` can't reach it. `get` shows the build a machine was cloned from as `TEMPLATE`. `template delete` deletes a template and its builds' copies, once the creates cloning them are done, and leaves the machines cloned from it.

### Joining machines to the tailnet

A host with `tailnet` joins each machine whose guest has `tailscale` and `tailscaled` in one of `/usr/local/sbin`, `/usr/local/bin`, `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin` or `/opt/homebrew/bin`. Nothing else is searched, not the guest's own `PATH`, `/snap/bin` or Linux Homebrew. Installing them in a recipe is the opt-in:

- clankerbox runs its own `tailscaled` from `/var/lib/clankerbox/tailscale`, on its socket there, `tailscaled.sock`; pass it to `tailscale --socket` and to tools that ask the daemon who calls, such as Rex's `--tailscaled-socket`. It runs in kernel mode: the guest gets a tailnet interface and address, so every program in it reaches the tailnet, and only a server listening on that address or on all addresses is reachable there, never one bound to `127.0.0.1`. Leave the distribution's own `tailscaled` service off.
- It takes over the guest's DNS (`--accept-dns`), so MagicDNS names resolve, and in a Linux guest it installs no firewall rules (`--netfilter-mode=off`): smolvm's guest network lies in Tailscale's `100.64.0.0/10`, and Tailscale's rules drop that range on any other interface, the host's SSH included. A check sets both each time it finds the daemon answering. In a Linux guest a check also binds `/var/lib/clankerbox/resolv.conf`, a copy of the guest's `/etc/resolv.conf`, over that file when it is a file and no mount stands there, so Tailscale writes the bound file. smolvm writes the file beneath at every exec, and without the mount Tailscale put its own back only some of the time, which left MagicDNS names unresolved. The mount lasts until the machine stops, and a machine made before 0.40.1 gets it at its next check, within half an hour, or at its next start.
- The login user, and no other user but root, may fetch the node's certificates from that `tailscaled`: `/localapi/v0/cert/<domain>` through its socket, granted by `TS_PERMIT_CERT_UID`. No operator is set, so nothing else on the daemon is open to it; reading its status is open to every local user.
- Once a create, fork, restore or start has prepared a machine and answered, the host joins it to the tailnet in a step of its own: it starts `tailscaled` from its saved state if it isn't running, and a node that needs a login gets a key. So `ssh cbx-<name>` right after `create` can fail until the join ends, while `clankerbox ssh <name>`, over the published port, works at once. The host mints one key per join: single-use, ephemeral, preauthorized, for the configured tags, expiring in 10 minutes, and passes it on stdin. A request that arrives meanwhile cuts the join short. A failed join is reported in `TAILNET`, and the control plane retries it with backoff. The tailnet credentials stay on the host.
- The node is named `cbx-<name>`. A fork or restore kills the daemon its source left and drops the node first, so it joins as its own node.
- `get` shows `TAILNET`, while the machine runs: the MagicDNS name Tailscale gave the node, why the last check failed, or that the guest has no `tailscaled`. The status is the control plane's memory only, never stored. A joined machine is checked again every 60 rechecks (half an hour at the default 30 seconds), which restarts a daemon that died; a failed one after 1 recheck, then 2, 4 and so on up to 64. A guest without `tailscaled` is checked again at its next start.
- A template build's builder joins in its make, after the base is prepared and before the setup runs, as `cbx-<builder>`, such as `cbx-building-0123456789abcdef`, with a key for `buildTags`, or for `tags` without them, so the setup reaches the tailnet: see Writing a setup. A builder whose join fails fails its build before the setup runs. Once the setup ends, also when it fails, the host logs the node out, so it leaves the tailnet at once, kills its `tailscaled` and deletes its state; in a Linux guest it then puts back `/etc/resolv.conf` as it was before the join, if the logout didn't. The copy holds no node, and a clone joins as its own. A builder joins nothing on a host without `tailnet`, and its setup runs off the tailnet. On Tart the host leaves the DNS as the logout left it, and logs a warning when it differs from before the join.
- Nodes are ephemeral, so a deleted machine's node goes once it has been offline a while; a machine of the same name made again before then gets a suffixed name.

`clankerbox COMMAND --help` documents each command.

### Writing a setup

A setup runs once, in a template build's machine, as the login user `admin` in its home, on a base clankerbox has prepared; the build's copy, and each clone, fork and restore of it, carry its results. The guest holds its script only while it runs, in `/dev/shm`, in memory, on Linux and in `/var/tmp`, on disk, on macOS, which has no memory-backed directory but one root mounts, and the host removes it when the setup fails, runs past its timeout or is cut short; one a host was killed holding goes with the builder, which the failed build deletes. Before the setup starts, clankerbox makes the base ready as root:

- on smolvm, smol cloud and boat, it installs `openssh-server`, `sudo`, `perl`, `ca-certificates`, `curl` and `libnss-myhostname` with `apt-get`, creates `admin` where the image lacks it, and sets `PermitRootLogin no`. An image without `apt-get` is refused: build on a Debian or Ubuntu image;
- on Tart, whose bases ship `admin`, it names public DNS resolvers, as Softnet blocks the gateway's, and waits for the clock, which the base boots behind;
- on a host that joins its machines to the tailnet, it installs `tailscale` and `tailscaled` without starting them, with `apt-get` from Tailscale's repository on smolvm, smol cloud and boat and with `brew` as `admin` on Tart;
- it gives `admin` passwordless `sudo`, and installs each key of the server config's `authorizedKeys` that its `~/.ssh/authorized_keys` lacks, so a template's build holds them.

A setup that needs root uses `sudo`. It may:

- write `/etc/clankerbox/start`, run as root after each boot, fork or restore: idempotent, daemonizing what it launches, and exiting 0 once it's up. clankerbox relaunches sshd itself, before the hook runs;
- write `/etc/clankerbox/new-identity`, run when a fork or restore gets its new identity, to reset per-machine state of its own;
- write `/etc/clankerbox/stop`, `/etc/clankerbox/pause` and `/etc/clankerbox/delete`, each run as root before its step and only while the machine runs, to finish the guest's work, such as flushing what it ships. Each runs under the control plane's `hookTimeout`, 120 seconds unless the server config sets it, so a hook bounds its own work below that. A `pause` hook can't count on its RAM surviving: a VM booted under another runtime pin is stopped instead, and so is one a Mac can't suspend and every boat machine. A hook runs only in a guest that has taken its own identity, so a fork, restore or clone whose make ends before then runs none, while one whose `start` hook fails, later in the make, runs its `delete` as it is undone. A stop or delete of a machine that isn't running runs none, so work needed before every delete belongs in `pause` and `stop` too. A hook may run more than once, and a later request may cut it short, so it must be idempotent. One that fails or runs past its time is logged on the host, and the step goes on. The host logs no node out before a hook, so a joined machine is still on the tailnet while it runs; one that isn't joined yet, or whose join failed, isn't, so a hook that needs the tailnet must fail fast without it. A template's builder runs none: a Tart or boat build stops its builder before the copy, so a stop hook's effects would land in every clone, and a builder's delete has no user work to finish.

On a host with `tailnet`, the setup runs with the builder on the tailnet, as its own node (see Joining machines to the tailnet), so it can fetch from tailnet services, such as credentials or a private git server, and make first clones. Whatever the setup fetches, credentials included, stays in the build: in its copy on each host, in the build store when the host has `builds`, and in every clone. The builder's node is logged out before its copy is made, so no clone carries it.

A service of the login user that serves TLS on the tailnet can take the node's certificate from clankerbox's `tailscaled` (see above). A clone's join comes after `/etc/clankerbox/start` has run, so the hook can't wait for the tailnet.

A create from a template's build adds each key of `authorizedKeys` that the build lacks, the same way. Put no key in root's: nothing logs in as root. A checkpoint, like a template's build, holds everything the machine had, credentials too.

## Deploy

Install each package in a versioned prefix; VMs never reference it, so a release replaces it while machines run. Its bin runs the `node` on the service's `PATH`, which must be Node 26.13 or later.

```sh
npm install --global --prefix /opt/clankerbox/<version> @gjermundgaraba/clankerbox-host@<version>
```

**smolvm**, as root, in a system unit:

```ini
[Unit]
Description=clankerbox host (smolvm)
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=exec
ExecStart=/opt/clankerbox/<version>/bin/clankerbox-host --config /etc/clankerbox/smolvm-1.json
KillMode=mixed
TimeoutStopSec=300
SuccessExitStatus=130
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

VMs run in their own scopes, so restarting the unit leaves them running. `KillMode=mixed` sends a stop's SIGTERM to the host alone, which ends at once, cutting each exec and step in flight, but first lets a smolvm stop or pause it has begun finish, as a SIGTERM to that smolvm call would leave it half done, and removes a setup's script from its guest, which waits up to 10 s on a guest that doesn't answer. `TimeoutStopSec=300` bounds that wait, with room for smolvm's longest stop; systemd then kills what is left, and a host that starts resumes a machine a killed pause left half-paused.

A host's log holds one info line for each step it ends, done, cancelled or failed with its error's first line, annotated with its `operation`, its `step` and its machine or checkpoint, as the operation's report carries a setup's output; an error for a step that died, with its cause; a warning for what a host went on past, such as a leftover it couldn't remove; and no line for a request it answered: the control plane reads and polls each host every few seconds. A request that answers `Internal`, or fails as no declared error does, logs an error with its cause; any other answer, `Unavailable` and a 404 for a path that names no action included, logs at debug; one cut short, by its caller or by the host's stop, logs nothing. `--log-level debug` on `ExecStart` logs every response too, with its method, path and status.

**The control plane** runs in the same kind of unit, as any user that owns its `stateDir`, with `ExecStart=/opt/clankerbox/<version>/bin/clankerbox-server --config /etc/clankerbox/server.json`. It runs no VMs and can share a box with a host, or sit on anything small on the tailnet. Keep a backup of its `stateDir`: with the file gone, the VMs run on with nothing that knows them.

**Leftovers at a provider.** Each recheck has a smol cloud or boat host delete only what its own store retired, so three things leave resources at the provider, billed, that no sweep reaches: a wiped `stateDir`, a second control plane over the same hosts, and a restored backup older than what was made since. A retired one whose delete fails, or that its provider refuses to delete while something depends on it, stays billed until a sweep deletes it: its host's log warns once, `sweep: couldn't delete machine <instance> (<handle>)` or `checkpoint`, and each sweep after tries again. Find them by the host's mark. On smol cloud, it names each machine `cbx-<host id>-<instance>`. On boat, it labels each sandbox `cbx-host=<host id>` and `cbx-instance=<instance>`, and names each snapshot `cbx-<instance>`. One whose instance no row holds is a leftover. The rows' instances are in the store, which the control plane holds locked while it runs, so stop it first:

```sh
sqlite3 -readonly <stateDir>/server.db 'SELECT instance FROM machines UNION SELECT instance FROM checkpoints'
```

Start the control plane again, and delete each leftover in the provider's console or API. Don't delete a marked resource the query lists.

**tart**, as the operator's user, in a LaunchAgent in its GUI session, with `KeepAlive` set to `{SuccessfulExit: false}`; stop it with `launchctl bootout gui/<uid>/<label>`. Pull each base with `tart pull` as that user before its first create. For `pause`, keep that session unlocked: set **Lock Screen → Require password after screen saver begins or display is turned off** to **Never** (the display can still sleep), and log in once after each reboot, since FileVault rules out automatic login. macOS keeps the key that seals saved VM state in the session's keychain, so a root daemon can't save it at all. The first pause on a Mac creates that key, so make it while you're logged in and unlocked: a save while locked before then powers the VM off, keeping its disk, and fails. Later pauses work while locked, but every resume needs the session unlocked.

**Network:** three paths cross the tailnet, and its policy is the only gate.

| From | To | Port | For |
| --- | --- | --- | --- |
| Clients | The control plane | its `listen.port` | every command |
| The control plane | Each host | its `listen.port` | steps and reads |
| Clients that run `ssh` | Each host | its `machinePorts` | SSH straight to machines |

Clients never need a host's API port. The control plane logs one line when a host stops answering, and one when it answers again. On a smolvm host, nothing may listen on a public address: guests can reach those. On macOS with the application firewall on, allow incoming connections for each new `node` binary, which allows them for every program that `node` runs.

## SDK

The SDK and the Sandbox Agent provider require Effect and `@effect/platform-node` `~4.1.3` and `@gjermundgaraba/effect-actions` `^0.31.0`. Release 0.37 took Effect and `@effect/platform-node` `~4.1.1` and effect-actions `^0.30.0`, 0.34 to 0.36 the same Effect versions and effect-actions `^0.29.0`, 0.33 effect-actions `^0.27.0`, and 0.32 effect-actions `^0.26.0`; 0.31 took `~4.0.5` and `^0.23.0`. Upgrade these peers together.

`@gjermundgaraba/clankerbox-sdk` holds the API's schemas, errors and the client. SDK 1.2.3 talks to a control plane of release 1.2.x, which refuses other releases. A release's runtime traits are part of its contract: a new trait, or a new value of one, comes only with a new major.minor, so a client decodes every trait it reads and can decide on each value. A runtime added in a patch release declares values its release knows. `effect` and `@effect/platform-node` (`~4.1.3`) are peer dependencies.

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client, readSetup } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Console, Effect } from "effect";

const program = Effect.gen(function* () {
  const client = yield* Client.Client;

  // Runs the setup once, on a machine it copies and then deletes.
  yield* client.buildTemplate({
    template: "dev",
    base: "ubuntu",
    cpu: 2,
    ramMib: 4096,
    diskGib: 20,
    setup: { script: yield* readSetup("recipes/dev"), timeoutSeconds: 900 },
  });

  // Waits until it runs; the control plane chooses the host.
  const machine = yield* client.create("dev", { template: "dev" });

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
- A mutation answers once recorded, and the client waits until the resource rests: a machine with what was asked, its `phase` and `error` saying how it got there. `Client.make(url, { noWait: true })` skips the wait, and `timeout` bounds a mutation's reply and its wait together. One whose reply is lost fails `Unavailable`: it may have run, so read the resource.
- `client.buildTemplate({ template, setup, base, cpu, ramMib, diskGib })` does what `clankerbox template build` does, and answers the `Build` once it ends; `client.templates`, `getTemplate` and `deleteTemplate` do the rest. `client.create(name, { template: "web" })` clones a template's current build, or the one `web@N` names, with the sizes given, and `machine.template` names the build. `{ recorded }` runs once the server has recorded the create, before the wait, with the machine it recorded.
- `client.ensure(name, { spec, checkpoint, sizing, labels })` answers a machine of `name` that runs: the one that exists, started or resumed; else one restored from `checkpoint` when that is ready, at `sizing` or its own; else one created from `spec`. A failed create's row that still answers `Conflict` is deleted and the make tried once more, and a make whose reply was lost reads the machine and decides again, once. `labels` go on what it makes.
- `client.pauseMachine({ id, capture })` waits for the machine to pause and then for the checkpoint to be ready, failing with the capture's error when it failed.
- `client.execMachine({ id, argv, user, env, stdin, timeoutSeconds })` runs a command and answers `{ exitCode, output, truncated }`; the client waits as long as the command runs, or `timeoutSeconds` and the reply timeout. `client.listMachines()` and `client.listCheckpoints()` list everything, and take `{ labels }` to filter by labels.

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

- A sandbox comes from a template (`{ template }`, `agent` or `agent@3`), a checkpoint (`{ checkpoint }`) or a fork (`{ machine }`). Build the template from a recipe below once, with `clankerbox template build recipes/agent.yaml`, which builds `agent` with 2 vCPUs, 4G of RAM and a 20G disk, on boat `recipes/agent-boat.yaml`, which builds `agent-boat` in boat's `small` type, or on Tart `recipes/agent-mac.yaml`, which builds `agent-mac`. Any source may add `cpu`, `ramMib` and `diskGib`: larger than the build's, as `create --template` takes them, or for the copy, as `restore` and `fork` take them. The key the tunnel logs in with must be in the server config's `authorizedKeys`.
- `sandbox.resize(id, sizes)` resizes a sandbox's machine as `resize` does, and answers its sizes; `id` is the machine's name, `sdk.sandboxId` without its `clankerbox/`. For what a running machine can't take, `pauseSandbox`, resize, then `sandbox.ensureServer(id)`.
- A sandbox's ID is `clankerbox/<machine name>`; `pauseSandbox` stops the machine and `destroySandbox` deletes it. Stop a sandbox's machine rather than `clankerbox pause` it: a reconnect resumes a paused one with its old agents, which then run beside the sessions the SDK replays into new ones, and a paused one can't be forked. A create that fails deletes the row it may have left, unless the answer is `Conflict`, as the name is another machine's, `Superseded`, as a later request owns it, or `Unavailable`, as the server may still act on it: the error's `made` names the machine to read or delete.
- `recipes/ubuntu/` (smolvm, smol cloud and boat) and `recipes/macos/` (Tart), built from the template files `agent.yaml`, `agent-boat.yaml` and `agent-mac.yaml` beside them, install the server, Node and Claude Code, and run the server as the login user, whose home, `/home/admin` on Linux, is the default `cwd`; on macOS, give `cwd: "/Users/admin"`. Each takes an optional `agent.env` beside its `setup.sh`, of `NAME=value` lines, such as `ANTHROPIC_API_KEY=…`, so keep a recipe with one private.
- A tunnel that ends, say because its machine stopped, stays down until `sandbox.ensureServer(id)` or a new `SandboxAgent.start`.
- `effect`, `@effect/platform-node` and `sandbox-agent` are peer dependencies.

## Amp orb provider

`@gjermundgaraba/clankerbox-amp-orbs` is the dispatch program for [Amp's self-hosted orbs](https://ampcode.com/docs/orbs/self-hosted): `amp orb provider` runs it once per job, with the job in its environment, and each orb is a clankerbox machine on a smolvm host.

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
- A spawn makes the orb's machine run, `client.ensure` with the machine named after `ORB_ID`: started or resumed when it exists, else restored from the project snapshot `ORB_SNAPSHOT_ID` names when that checkpoint is ready, at the snapshot's sizes, else created from `ORB_IMAGE` at the orb type's sizes, with no setup. Amp's image carries what bootstrap needs, so nothing is installed, and a create from a base needs no `admin`, `sudo` or key. Then `execMachine` starts `amp orb bootstrap` as the login user, detached, with `ORB_TOKEN` and `AMP_URL` in its environment, after ending one still running: a resumed or restored machine keeps the processes it paused with, and that bootstrap holds the previous job's token. Bootstrap logs to `~/.amp-orb-bootstrap.log` in the orb.
- A pause with a snapshot of a running machine deletes the checkpoint of that snapshot's name, then `pauseMachine` with `capture` makes the new one, labelled `amp-orb` and `amp-snapshot` and expiring after `snapshotExpiry`, and the pause begins once the capture has. A machine that isn't running is paused without a snapshot, and a pause of an orb with no machine does nothing. A smolvm checkpoint holds RAM, so a restore resumes where the pause left off.
- A delete deletes the machine; one already gone is done. Snapshots are a project's, not an orb's, so they stay until they expire or a pause replaces them.
- An Amp ID that is a clankerbox name, as `amp-<thread id>` is, names the machine; another gets its letters and digits with a digest of it, and the machine carries the ID as its `amp-orb` label either way, `amp-orb-type` the orb type.
- Each job is safe to repeat and fails after 4½ minutes, within the five Amp gives, saying that the control plane still acts on what was asked. Its output goes to the provider's log, and a spawn's to the thread's setup log too.
- The image has no tailscaled, so a host that joins its machines to the tailnet reports the orb's join `missing` and nothing else; the orb needs only outbound HTTPS.

## Release

A pushed tag publishes. Bump the version of every published package, commit, tag `v<version>`, and push the tag. `.github/workflows/npm.yml` checks that the tag names that version, then publishes each package whose version npm doesn't have yet, through npm trusted publishing. A new package's first version is published by hand with `vp pm publish`, then trusted with `npm trust github <package> --repo <repo> --file npm.yml --allow-publish`, which confirms at a terminal and signs in through the browser.

## License

MIT, see [LICENSE](LICENSE).
