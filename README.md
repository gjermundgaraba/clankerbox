# Clankerbox

API-first coding machines with retained workspaces, concurrent Linux RAM forks,
explicit recovery points, and guest-owned terminal sessions. Applications use the
bearer-authenticated session API. Clankerbox does not manage application credentials.

Applications and the CLI use generated `clankerbox.v1` Connect services. Private
host and guest listeners use the same SessionService contract. See
[terminal sessions](docs/terminal-sessions.md) and the
[generated SDK](protocol/README.md) for current consumer contracts. Historical
spike and execution records below retain their original qualification boundaries.

## Using machines

`clankerbox dev` manages a project-scoped environment with the real controller,
persistent host service and Linux VMs. Apple Silicon hosts use the supported
smolvm Linux/arm64 runtime; Linux/amd64 hosts use KVM. The control-plane services
run locally and guest terminals stay inside their VM. See
[local development](docs/local-development.md) for the installed runtime bundle,
project configuration, environment lifecycle and Clankerdesk target.

Create `~/.config/clankerbox/config.json` with your API origin and local files:

```json
{
  "url": "https://YOUR_CONTROLLER",
  "token_file": "token",
  "default_profile": "linux-dev-v3"
}
```

Config file paths resolve relative to the config directory; `~/` expands to your
home. Keep the bearer token file mode 0600. Optional `default_host` and
`default_profile` supply omitted flags; `--host` and `--profile` override them.
Without a host setting, create selects the sole host supporting the profile;
ambiguity requires an explicit `--host`. Explicit or configured hosts go directly
to the controller, which owns admission and returns previously accepted requests
before checking current host/profile eligibility.

```sh
clankerbox profiles
clankerbox create dev
clankerbox stop dev
clankerbox start dev
clankerbox fork dev experiment
clankerbox checkpoint create dev
clankerbox restore CHECKPOINT_ID recovered
clankerbox sessions dev
clankerbox labels dev team=core purpose=review
```

Create/start/stop/delete/fork and checkpoint create/delete/restore wait for their
accepted operation, up to five minutes. `--timeout 10m` changes that positive
bound. Success prints the machine or checkpoint summary; deletes print the
completed operation. Failure, unresolved status, timeout or a lost operation read
returns nonzero with the known operation and resource IDs. A timed-out operation
may continue: inspect it before deciding to retry. Waiting never resubmits a
mutation. Stopped machines require an explicit `start`; connecting never wakes
them. Deletion requires a stopped machine. Runtime rules still apply: Tart macOS guest
forks/captures require a stopped source.

Resource flags can appear before or after positionals, for example
`create dev --profile mac-xcode-v3 --host mac`. Global flags precede the
command. For automation:

```sh
clankerbox --json create batch-dev --async --idempotency-key REQUEST_KEY
clankerbox --json operation OPERATION_ID
clankerbox --json inspect dev
clankerbox --json checkpoint create dev --async
```

`--json` prints structured resources, or the accepted operation with `--async`.
Without `--async`, JSON mutations return machines (create/start/stop/fork/restore),
a checkpoint (capture), or a completed operation (deletes). `operation` remains
available for diagnostics. Use Clankerdesk or another session-API consumer for
terminal interaction; `sessions` lists the retained sessions but is not an
interactive terminal client.

The binaries use urfave/cli for flag parsing
and generated help. `clankerbox` with no arguments shows root help; use
`clankerbox COMMAND --help` or `clankerbox help COMMAND` for command details.
Help never requires configuration or starts services. Names are positional:
`create NAME`, `fork SOURCE CHILD`, and `restore CHECKPOINT CHILD`.
Errors go to stderr as text, including with `--json`; that flag controls resource
output on stdout.

`clankerbox hosts` shows total, used and remaining CPU/RAM per host. Used
capacity means controller reservations, not live CPU utilization or resident
memory. Running, preparing and unknown machines reserve their pinned profile
sizes; stopped machines release capacity unless a start is queued. Deleted
machines are excluded. The command reads the same durable accounting used for
admission without contacting hosts. Remaining capacity can be negative if host
limits were reduced below existing reservations. `clankerbox hosts --json`
includes `used_cpu`, `used_ram_mib`, `remaining_cpu` and `remaining_ram_mib`
alongside configured totals `cpu` and `ram_mib`.

## Service architecture

The controller owns public admission, desired state, and the durable operation
queue. One reconciliation worker per host dispatches native mutations. The host
owns native execution and its journal; per-machine reservations keep conflicting
session calls out while other machines remain accessible. Guest daemons own PTYs,
terminal state and final session records.

MachineService handles public lifecycle operations. HostService handles private
native administration. A single SessionService schema is mounted at controller,
host and guest endpoints, each with its own authorization. Clients and TLS
connections live with the service or verified machine binding that owns them.

Profiles carry portable compatibility fields and image content digests. Hosts
resolve installation paths privately. Capabilities are derived from each profile.
Linux guests use the pinned smolvm/libkrun build for RAM forks and checkpoints;
Tart macOS guests support stopped-disk copies. Unknown or unresolved native state
requires explicit inspection; requests never silently cold-boot a requested RAM
restore or replay uncertain terminal input.

This repository owns services, the generated SDK, image recipes, release inputs
and acceptance tests. Deployment topology, secrets, network rules and operating
procedures belong to the separate personal-cloud repository.

## Build and verification

```sh
make build
make test
make lint
```

`make test` runs Go race tests and Python image/release/harness tests. SDK generation,
build and schema checks are documented in [protocol/README.md](protocol/README.md).
Lint uses golangci-lint v2.13.2 with correctness and security checks; formatting
uses gofmt/goimports. Release builders require explicit pinned engine sources and
dependency notices. See [release packaging](scripts/release/README.md).

The controller owns its database and lock under a private `--state-dir`. See
[module contracts](docs/module-contracts.md) for ownership and file boundaries,
[terminal sessions](docs/terminal-sessions.md) for streaming semantics, and
[local development](docs/local-development.md) for environment lifecycle.

## Historical investigations

The [runtime investigation](docs/concurrent-ram-forks.md),
[recovery results](spikes/recovery/RESULTS.md),
[Tart checks](spikes/tart-checkpoints/RESULTS.md), and
[original real-local implementation record](docs/real-local-development-implementation.md)
preserve their original qualification boundaries. They are historical evidence;
current release inputs live under `scripts/release/inputs/`. Private build trees,
VM payloads and credentials stay outside source control.
