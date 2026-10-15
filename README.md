# clankerbox

clankerbox runs machines (VMs) for coding agents and reports where each one is
reachable over SSH.

- Lifecycle: create, start, stop, delete, fork, checkpoint capture and restore.
- Three runtimes: smolvm (Linux guests on a Linux host, with RAM forks and RAM
  checkpoints), Tart (macOS guests on a Mac, with disk copies) and boat (Linux
  guests in boat.dev's cloud, with disk forks and checkpoints).
- Clients talk to hosts directly; there is no controller. A create goes to the
  first host in the client's list that offers the requested base, unless it
  names a host.
- A profile is a client-side file: a base, sizes, a setup script and,
  optionally, a host. A prebuild is a checkpoint of a machine whose setup has
  run, which later creates of the same profile restore.
- Each machine exposes only SSH, reported as a `host:port` with the guest's
  host key.
- Hosts and clients share a Tailscale tailnet, and its policy is the only gate:
  the API has no keys and no TLS.

One `clankerbox` binary is both the CLI and the host (`clankerbox host`). The
TypeScript SDK is `@gjermundgaraba/clankerbox-sdk`.

## Install

Each [GitHub release](https://github.com/gjermundgaraba/clankerbox/releases)
has a `clankerbox-<target>.tar.gz` and its `.sha256` for `darwin-arm64` and
`linux-x64`. The bundle holds a single-executable `clankerbox` binary with
nothing else to install.

```sh
base=https://github.com/gjermundgaraba/clankerbox/releases/latest/download
curl -fLO "$base/clankerbox-linux-x64.tar.gz"
curl -fLO "$base/clankerbox-linux-x64.tar.gz.sha256"
shasum -a 256 -c clankerbox-linux-x64.tar.gz.sha256   # or sha256sum -c
mkdir clankerbox && tar -xzf clankerbox-linux-x64.tar.gz -C clankerbox
clankerbox/clankerbox --version
```

Each host needs its runtime, installed by the operator:

| Runtime | Host                    | Prerequisite                                                         |
| ------- | ----------------------- | -------------------------------------------------------------------- |
| smolvm  | Linux/amd64 with KVM    | smolvm exactly 1.27.3, upstream, in a versioned prefix; runs as root |
| Tart    | Apple Silicon, macOS 26 | Tart 2.40.1 or later, Softnet 0.24.0 installed SUID root             |
| boat    | either, unprivileged    | a boat.dev API key                                                   |

smolvm, with both disk templates expanded beside their `.zst` files:

```sh
HOME=/opt/smolvm/1.27.3 install.sh --version 1.27.3 --prefix /opt/smolvm/1.27.3 --no-modify-path
for t in storage-template.ext4 overlay-template.ext4; do
  zstd -d --sparse /opt/smolvm/1.27.3/$t.zst -o /opt/smolvm/1.27.3/$t
done
```

Softnet, for Tart: `sudo install -o root -g wheel -m 4755 softnet /usr/local/bin/softnet`.

## Run a host

A host process runs one runtime from one JSON config file:

```json
{
  "id": "linux",
  "runtime": "smolvm",
  "listen": { "address": "100.64.0.10", "port": 8484 },
  "stateDir": "state",
  "bases": {
    "ubuntu": "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7"
  },
  "smolvm": { "prefix": "/opt/smolvm/1.27.3" }
}
```

- `id` is short and lowercase (`linux`, `mac`); it starts every ID the host
  holds.
- `listen.address` is a tailnet address or loopback.
- `stateDir`, relative to the config, holds the database. Keep it with its
  host ID and runtime; the host refuses a config that names others. On smolvm
  it is at most 52 bytes and outside every home directory, such as
  `/srv/clankerbox/smolvm`.
- `bases` maps names clients ask for to images, pinned by digest. Hosts
  offering the same image should use the same name.
- The runtime's block: `smolvm: {prefix, ramBudgetMib?}`, `tart: {binary}` (the
  `tart` executable of a versioned install) or `boat: {apiKey}`.
- `machinePorts: {first, last}`, optional, is the range machines' SSH ports
  come from, 10000–19999 by default; `listen.port` lies outside it.

```sh
clankerbox host --config /etc/clankerbox/linux.json
```

The host exits 130 on SIGINT or SIGTERM and 1 when it fails.

## Use the CLI

The client config is `$XDG_CONFIG_HOME/clankerbox/config.json` (`~/.config`
when unset), or `--config PATH`:

```json
{
  "hosts": [
    { "id": "linux", "url": "http://100.64.0.10:8484" },
    { "id": "mac", "url": "http://100.64.0.20:8484", "sshUser": "admin" }
  ],
  "profiles": "profiles"
}
```

The host list is in placement order. `sshUser` is the user plain `ssh` logs
in to the host's machines as: `root`, the default, or `admin` on Tart. `--profile NAME` reads `NAME.json` from
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
clankerbox hosts                           # every host, its runtime, versions and bases
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
- `fork` copies a running smolvm machine with its RAM, a stopped Tart
  machine's disk, or either boat machine's disk.
- A prebuild matches the profile, its sizes, its setup and the host's runtime
  release; any change runs the setup again until a new `prebuild`. Nothing
  deletes prebuilds: `checkpoint list` shows them.
- `ssh` pins the machine's host key and logs in as `root`, or `admin` on Tart.
- Plain OpenSSH reaches machines by ID too, so `ssh linux_dev`, scp, rsync and
  tools that run ssh work. The released binary, on the default client config,
  keeps `~/.ssh/clankerbox` with one `Host <host>_*` block per host, as its
  `sshUser`, and ends `~/.ssh/config` with `Match all` and `Include
  clankerbox`, so your own entries come first and win. Each connection runs
  `clankerbox ssh-proxy` and `clankerbox ssh-known-hosts` for the machine's
  current endpoint and host key, so nothing goes stale when a port changes or
  a machine is recreated. `CLANKERBOX_SSH_CONFIG=false` removes both.
- `--json` prints the resource or `{"error": {...}}`.

`clankerbox COMMAND --help` documents each command.

### Writing a setup

Setup runs once, as root, after the machine's first boot; forks and restores
carry its results. It must:

- install sshd where the base has none (smolvm's stock images), and put your
  public key in the login user's `authorized_keys`;
- write `/etc/clankerbox/start`, if anything should run after each boot, fork
  or restore: idempotent, daemonizing what it launches, exiting 0 once it's
  up, and relaunching sshd if `/run/sshd.pid` is dead;
- optionally write `/etc/clankerbox/new-identity`, run when a fork or restore
  gets its new identity, to reset per-machine state such as tailnet keys.

Linux guests need `perl`. On Tart, Softnet blocks gateway DNS, so set public
resolvers. On boat, keep state that must survive under `/home/user`, `/etc`,
`/usr`, `/opt`, `/srv`, `/root` or `/var/lib`, and leave boat's sshd, TCP 8911
and its WireGuard tunnel alone. A checkpoint, prebuilds included, holds
everything the machine had, credentials too.

## Deploy

Install the binary at a versioned path, such as
`/opt/clankerbox/<version>/clankerbox`; VMs never reference it, so a release
replaces it while machines run.

**smolvm**, as root, in a system unit:

```ini
[Unit]
Description=clankerbox host (smolvm)
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=exec
ExecStart=/opt/clankerbox/<version>/clankerbox host --config /etc/clankerbox/linux.json
KillMode=control-group
SuccessExitStatus=130
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

VMs run in their own scopes, so restarting the unit leaves them running.

**Tart**, as the operator's user, in a LaunchAgent in its GUI session, with
`KeepAlive` set to `{SuccessfulExit: false}`; stop it with
`launchctl bootout gui/<uid>/<label>`. Pull each base with `tart pull` as that
user before its first create.

**boat**, unprivileged, on any always-on machine on the tailnet. Its config
holds the API key, so keep it readable by its user only.

**Network:** the tailnet policy opens each host's API port to its clients, and
on smolvm and Tart the machines' port range to clients that run
`clankerbox ssh`. On a smolvm host, nothing may listen on a public address:
guests can reach those. On macOS with the application firewall on, allow
incoming connections for each new binary.

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
- A mutation waits until its action finishes. One whose reply is lost fails
  `Unavailable`: it may have run, so read the resource.
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
  sshArguments: ["-i", "/path/to/key"],
});

const sdk = await SandboxAgent.start({ sandbox });
const session = await sdk.createSession({ agent: "claude" });

await session.prompt([{ type: "text", text: "Summarize README.md" }]);
await sdk.destroySandbox();
```

- A sandbox comes from a profile (`{ profile }`), a checkpoint
  (`{ checkpoint }`) or a fork (`{ machine }`), and a profile's prebuild is
  used when there is one.
- A sandbox's ID is `clankerbox/<machine ID>`; `pauseSandbox` stops the
  machine and `destroySandbox` deletes it.
- `recipes/ubuntu/` (smolvm) and `recipes/macos/` (Tart) install the server,
  Node and Claude Code. Each takes an `authorized_keys` beside its `setup.sh`,
  and an optional `agent.env` of `NAME=value` lines, such as
  `ANTHROPIC_API_KEY=…`, so keep a recipe with one private.
- A tunnel that ends, say because its machine stopped, stays down until
  `sandbox.ensureServer(id)` or a new `SandboxAgent.start`.
- `effect`, `@effect/platform-node` and `sandbox-agent` are peer dependencies.

## License

MIT, see [LICENSE](LICENSE).
