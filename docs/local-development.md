# Real local development

`clankerbox dev` starts a project-owned environment with the ordinary controller,
persistent host service and real Linux VMs. It begins with an empty inventory;
create machines through the normal CLI, generated API or Clankerdesk. Terminal
PTYs, tools, files and process memory live in those VMs, not in a workstation
shell substituted for a machine.

The supported local host targets are Apple Silicon macOS (`darwin/arm64`, using
Hypervisor.framework) and Linux/amd64 with accessible KVM. Both use the pinned
smolvm runtime for Linux guests. macOS/Xcode guests remain a separate Tart profile
and do not imply RAM-copy support for macOS processes.

Live host qualification used macOS 26.6.2 on Apple Silicon and Ubuntu 26.04.1
amd64 (kernel 7.0.0-31, glibc 2.43). The Linux engine dynamically requires the
system GNU loader, libc/libm and libgcc_s; this is not a musl-only distribution
build. Other Linux distributions and older macOS releases have not been qualified.

## Install and start

Download the self-contained archive and checksum for your host platform from
[release 0.3.0](https://github.com/gjermundgaraba/clankerbox/releases/tag/v0.3.0)
using your normal private repository access. Verify SHA256 before extraction. The archive places
`clankerbox` beside `bundle.json` and all verified controller, host, guest,
smolvm/libkrun/agent, image and profile payloads. Add that extracted directory to
PATH or invoke its CLI by absolute path. Keep the archive's directory layout and
extract into a directory owned by you that other users cannot modify. Preserve
the archive's permissions: guest programs must remain executable by unprivileged
guest users. For example:

```sh
umask 077
mkdir clankerbox-release
tar -xzpf /path/to/platform-release.tar.gz -C clankerbox-release
```
Running local development requires no repository checkout, Go compiler or Rust
toolchain. The private release is not fetched through an unauthenticated default
GitHub asset URL.

Run as the ordinary user who owns the VM service, from the project directory:

```sh
cd /path/to/project
/absolute/path/to/extracted-release/clankerbox dev
```

The CLI locates the adjacent `bundle.json`, verifies the complete bundle and
starts the environment. An explicitly supplied bundle is also supported:

```sh
clankerbox dev --bundle /absolute/path/to/bundle.json
```

Other distributors may build a CLI with an explicit pinned `DefaultBundleURL`
and `DefaultBundleSHA256`. Only such a configured build downloads its HTTPS
archive and verifies the embedded digest before extraction, then caches verified
content by digest. A standalone CLI with neither an adjacent/explicit bundle nor
those release pins fails clearly; it never selects a moving latest runtime or
builds one on demand.

Every payload is checked against the manifest. Archive extraction rejects path
traversal and escaping links; the manifest's host platform must match the current
host. On macOS the CLI checks the signed runtime's hypervisor entitlement and a
logged-in launchd GUI domain. On Linux it requires `/dev/kvm` access and a running
systemd user manager. Fix a failing preflight before starting the environment;
Clankerbox does not silently select emulation or modify host privileges.

The default profile is `linux-dev-v3`: 2 vCPUs and 1024 MiB RAM, with the bundle's
explicit storage/overlay sizes. A profile declares resources and content pins; the API derives its capabilities.
Host OS, guest OS and runtime engine are distinct: an Apple Silicon host can run
a forkable Linux guest. Startup output reports readiness and connection paths;
there is no promised download, boot or restore latency.

## Project ownership and connection files

The default private state directory is `<project>/.clankerbox`. Use an explicit
path when needed:

```sh
clankerbox dev --state-dir /absolute/path/to/environment
```

Add `.clankerbox/` to the project's ignore rules. It contains private credentials,
controller state and ownership manifests, not distributable project content.
The canonical state path derives a distinct host namespace and a short private
host root under `~/.cb/`, keeping native socket paths within platform limits.
Separate projects have separate services, credentials, machine stores and journals.
A lock prevents two foreground owners or teardown operations from racing.

The default controller listens on an available loopback port. `--listen
127.0.0.1:PORT` selects a stable local port; non-loopback listeners are refused.
Once ready, the CLI writes:

| File | Purpose |
| --- | --- |
| `environment.json` | Environment ownership, namespace and immutable bundle binding. |
| `client.json` | Ordinary CLI origin, token file and default host/profile. |
| `clankerdesk.json` | Desk origin, server-side token path and machine creation defaults. |
| `connection.json` | Current readiness/connection metadata and paths to both consumer configs. |
| `token` | Private bearer credential, readable only by the environment owner. |

Read the generated paths printed by the CLI; do not infer endpoints from runtime
internals. The port can change when the foreground controller restarts, so reread
connection files. Do not commit or paste their token contents.

In another terminal, ordinary lifecycle operations use the generated CLI config:

```sh
clankerbox --config .clankerbox/client.json profiles
clankerbox --config .clankerbox/client.json create first
clankerbox --config .clankerbox/client.json inspect first
clankerbox --config .clankerbox/client.json sessions first
clankerbox --config .clankerbox/client.json fork first experiment
clankerbox --config .clankerbox/client.json checkpoint create first
```

Create and fork use normal durable operation admission. Unknown or unresolved
outcomes retain their operation identity; inspect before resubmitting. Profiles
control which lifecycle actions are available. Public resources do not expose
host service credentials, guest endpoints or image paths.

## Clankerdesk

Start the desk server with the generated target, then run its normal Vite+ workflow:

```sh
export CLANKERDESK_CLANKERBOX="$(cat /absolute/path/to/project/.clankerbox/clankerdesk.json)"
```

Set that variable in the process launching Clankerdesk's server. The target holds
only the URL, token-file path and creation defaults; the bearer file is read by
the server per call. The browser never receives the controller credential.
Clankerdesk's generated Node Connect client uses HTTP/2 for typed MachineService
and SessionService calls, including bidirectional terminal attachment.

Create a desk workspace and add a machine. There is no preseeded `local` VM to
select. Add terminals to that machine through the usual UI. The desk catalog owns
allocation identity, while the guest daemon owns the PTY, terminal parser and
retained output. Closing a view or reloading the browser does not allocate another
machine or terminate its sessions. See [the terminal contract](terminal-sessions.md)
for snapshot/resume, engine identity and lost-ACK behavior.

## Foreground exit, stop and destroy

These operations have deliberately different lifetimes:

| Action | Effect |
| --- | --- |
| Ctrl-C the foreground `dev` | Stops the foreground controller and releases its owner lock. The native host service, running VMs, live guest sessions and durable state remain. |
| Run `dev` again for the same state directory | Verifies the retained bundle, reconnects the persistent host service and starts another ordinary controller. Refresh consumer connection files. |
| `clankerbox dev stop` | Stops every owned VM through ordinary durable lifecycle operations, then stops the owned host service. Retained disks, checkpoints and journals remain. Sessions end with their VM. |
| `clankerbox dev destroy` | Stops owned VMs, deletes machine/checkpoint dependencies in safe order, removes the owned service and then the validated environment state. |

For a nondefault environment, put its flag on `dev`:

```sh
clankerbox dev --state-dir /absolute/path/to/environment stop
clankerbox dev --state-dir /absolute/path/to/environment destroy
```

First exit the foreground controller. Teardown takes the same ownership lock and
uses its own private temporary controller/token, not a published competing API.
It journals idempotency keys and accepted operation IDs before proceeding.
Interrupted teardown can be repeated; ordinary `dev` startup is fenced until it
finishes. Pending, unresolved, unexpected or uncertain resource state leaves the
environment intact for inspection. Destroy never recursively removes a directory
that lacks the matching ownership manifest, and it does not sweep unrelated VM
stores, projects or the shared verified bundle cache.

Do not remove an environment directory by hand to stop VMs. Do not edit or replace
a retained bundle's files: startup verifies its manifest/content pin and rejects
silent drift.

## Bundle identity and replacement

Each environment belongs to one verified bundle content digest. Ordinary restart
uses that same bundle and preserves live VMs. Changing service, engine or image
contents requires explicit destroy/recreate; dev VM contents are disposable when
changing releases. Finish teardown with the old bundle before selecting the new one:

```sh
clankerbox dev --state-dir /absolute/path/to/environment destroy
clankerbox dev --state-dir /absolute/path/to/environment --bundle /new/bundle.json
```

The bundle path is a locator. If an intact copy of the same bundle moved, supply
its manifest with `--bundle` on startup, stop or destroy:

```sh
clankerbox dev --state-dir /absolute/path/to/environment --bundle /relocated/bundle.json stop
```

Clankerbox verifies the exact content digest and repairs owned configuration and
supervisor paths. A different digest is refused without deleting the environment.
Keep an intact matching bundle available until teardown finishes.

## Qualification

Unit tests verify ownership, bundle extraction, state binding, supervision and
teardown dependencies. The transport gate separately proves actual Node/Go
HTTP/2 duplex behavior, bounded handling, cancellation and exact uint64 values.
The real guest proof covers copied PTY/memory continuity and machine identity
rebinding on its recorded runtime/image combination. These checks do not claim
host-reboot durability, arbitrary CPU compatibility, production-domain routing or
a startup-time guarantee. See [the implementation plan](real-local-development-plan.md)
for acceptance status and [RPC](archive/real-local/real-local-rpc.md),
[proxy](archive/real-local/real-local-proxy.md), and
[guest identity](archive/real-local/real-local-guest.md) proof boundaries.
