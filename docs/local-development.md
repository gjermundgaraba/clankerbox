# Local development

`clankerbox dev` runs a controller, a persistent host service and Linux VMs on a
workstation. It starts with an empty inventory; create machines through the CLI
or the API. Terminals, tools, files and process memory live in those VMs.

Supported hosts are Apple Silicon macOS (Hypervisor.framework) and Linux/amd64
with access to `/dev/kvm`. Both run Linux guests with the pinned smolvm runtime.
The Linux engine links against glibc; musl-only distributions are not supported.
Bundles ship a Linux guest image; macOS guests on Tart are a separate host
profile and do not support RAM forks.

## Bundles

An environment runs from one verified bundle: a `bundle.json` manifest plus the
controller, host and guest binaries, the smolvm engine and its libraries, disk
templates, a guest image and profiles.
[Release packaging](../scripts/release/README.md) describes how bundles are
assembled.

Supported bundles use manifest format 3 and include a prepared guest image.
Guest sessions run as root, with no workload-user setting; see the
[guest trust model](terminal-sessions.md). Keep the bundle and machine storage
private to the host operator.
Older disposable environments must be destroyed using their matching old CLI
and bundle before switching; no runtime image upgrade is performed.

A release archive places `clankerbox` beside `bundle.json`. Extract it with
permissions preserved into a directory that other users cannot modify:

```sh
umask 077
mkdir clankerbox-release
tar -xzpf platform-release.tar.gz -C clankerbox-release
```

That CLI finds its adjacent bundle. Any other CLI, including a source build,
takes the manifest explicitly:

```sh
clankerbox dev --bundle /absolute/path/to/bundle.json
```

Without an adjacent or explicit bundle, `dev` fails rather than picking a
runtime on its own.

Every payload is checked against the manifest before starting. On macOS the CLI checks the runtime's
hypervisor entitlement and that a launchd GUI session is logged in. On Linux it
needs `/dev/kvm` and a running systemd user manager. A failing preflight has to
be fixed; `dev` does not fall back to emulation or change host privileges.

The default profile is `linux-dev-v3`: 2 vCPUs and 1024 MiB RAM with the
bundle's storage and overlay sizes.

## Environment state

Run `dev` from the project directory as the user who will own the VMs. State
goes to `<project>/.clankerbox` by default, or to `--state-dir`. Add it to the
project's ignore rules: it holds credentials, controller state and ownership
manifests. The host service gets a short private root under `~/.cb/` so native
socket paths stay within platform limits. Each project has its own services,
credentials, machine store and journals, and a lock keeps two foreground owners
or teardowns from racing.

The controller listens on a free loopback port unless `--listen 127.0.0.1:PORT`
is given; non-loopback addresses are refused. When ready, the CLI writes:

| File | Purpose |
| --- | --- |
| `environment.json` | Ownership, namespace and the bundle digest. |
| `client.json` | CLI config: origin, token file and default host/profile. |
| `connection.json` | Readiness metadata and paths to the files above. |
| `token` | Bearer token, readable only by the owner. |

The port can change when the foreground controller restarts, so reread these
files rather than caching endpoints. In another terminal:

```sh
clankerbox --config .clankerbox/client.json profiles
clankerbox --config .clankerbox/client.json create first
clankerbox --config .clankerbox/client.json inspect first
clankerbox --config .clankerbox/client.json sessions first
clankerbox --config .clankerbox/client.json fork first experiment
clankerbox --config .clankerbox/client.json checkpoint create first
```

## Stop and destroy

| Action | Effect |
| --- | --- |
| Ctrl-C the foreground `dev` | Stops the controller and releases the owner lock. The host service, VMs, guest sessions and state remain. |
| Run `dev` again | Verifies the bundle, reconnects the host service and starts a new controller. Reread the connection files. |
| `clankerbox dev stop` | Stops every owned VM through ordinary operations, then the host service. Disks, checkpoints and journals remain. |
| `clankerbox dev destroy` | Stops VMs, deletes machines and checkpoints in dependency order, removes the service and then the environment state. |

Pass `--state-dir` to `dev` for a non-default environment:

```sh
clankerbox dev --state-dir /path/to/environment stop
clankerbox dev --state-dir /path/to/environment destroy
```

Exit the foreground controller first. Teardown takes the ownership lock and runs
a private temporary controller. It journals its idempotency keys and accepted
operation IDs, so an interrupted teardown can be repeated, and `dev` refuses to
start until it finishes. Pending, unresolved or unexpected resource state leaves
the environment in place for inspection. Destroy only removes directories that
carry a matching ownership manifest and never touches other projects, VM stores
or the shared bundle cache.

Do not delete an environment directory by hand to stop VMs, and do not edit a
bundle in place: startup verifies its digest and refuses drift.

## Changing bundles

An environment is bound to one bundle digest. Restarting reuses it and keeps
live VMs. Changing engine, service or image content means destroying the
environment and creating a new one; local VM contents are disposable:

```sh
clankerbox dev --state-dir /path/to/environment destroy
clankerbox dev --state-dir /path/to/environment --bundle /new/bundle.json
```

If an intact copy of the same bundle has moved, pass its new manifest path with
`--bundle` on start, stop or destroy. The digest is verified and the owned
configuration and supervisor paths are repaired. A different digest is refused
without touching the environment.

## Testing

Unit tests cover ownership, bundle verification, state binding, supervision and
teardown ordering. The guest qualification in `protocol/test` and the live
harnesses in [tests](../tests/README.md) exercise real VMs: root session identity and system-directory writes,
PTY and memory continuity across RAM forks and restores, identity rebinding and
the cold lifecycle.

For phase diagnostics and repeatable timings, see [lifecycle performance](lifecycle-performance.md).
