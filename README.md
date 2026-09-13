# Clankerbox

Clankerbox runs long-lived coding machines behind an API. Machines are VMs that
keep their disks until deleted, can be forked while running (Linux RAM forks),
and can be captured as checkpoints and restored into new machines. Terminal
access goes through guest-owned sessions on the same API; guests run no SSH.

A deployment is three services:

- **controller** (`clankerbox-server`): the public API. Owns desired state,
  admission and the durable operation queue.
- **host** (`clankerbox-host`): runs VMs natively on one machine and journals
  every mutation. Linux guests use a pinned smolvm/libkrun build on Apple
  Silicon and on Linux with KVM; macOS guests use Tart.
- **guest daemon** (`clankerbox-guest`): runs inside each VM and owns PTYs,
  terminal state and session records.

All three speak the generated `clankerbox.v1` Connect contract in
[protocol/](protocol/README.md). The `clankerbox` CLI is one client of it.

## Quick start

```sh
make build
```

`clankerbox dev` runs a controller, a host service and Linux VMs on your
workstation (Apple Silicon macOS, or Linux/amd64 with KVM). It needs a runtime
bundle: the engine, guest image, profiles and service binaries. A release
archive ships the bundle next to the CLI, which finds it automatically; a
source build takes the manifest explicitly:

```sh
bin/clankerbox dev --bundle /path/to/bundle.json
```

See [local development](docs/local-development.md) for the environment
lifecycle and [release packaging](scripts/release/README.md) for how bundles
are assembled.

## Using a controller

Create `~/.config/clankerbox/config.json`:

```json
{
  "url": "https://CONTROLLER",
  "token_file": "token",
  "default_profile": "linux-dev-v3"
}
```

Relative paths resolve against the config directory and `~/` expands to your
home. Keep the token file mode 0600. `default_host` and `default_profile` fill
in omitted `--host` and `--profile` flags; without a host, `create` picks the
only host that supports the profile and refuses an ambiguous choice.

```sh
clankerbox profiles
clankerbox hosts
clankerbox create dev
clankerbox stop dev
clankerbox start dev
clankerbox fork dev experiment
clankerbox checkpoint create dev
clankerbox restore CHECKPOINT_ID recovered
clankerbox sessions dev
clankerbox labels dev team=core purpose=review
```

Lifecycle commands wait for their operation to finish, five minutes by default
(`--timeout`). A timed-out operation may still complete: inspect it with
`clankerbox operation ID` before retrying. Stopped machines need an explicit
`start`, and `delete` requires a stopped machine. `clankerbox hosts` shows
configured and reserved CPU and RAM per host; reservations come from the
controller's accounting, not live utilization.

For automation, `--json` prints resources as JSON and `--async` returns the
accepted operation without waiting:

```sh
clankerbox --json create batch-dev --async --idempotency-key REQUEST_KEY
clankerbox --json operation OPERATION_ID
```

`clankerbox COMMAND --help` documents each command. The CLI lists sessions but
is not a terminal client; terminal access is through `SessionService`, see
[terminal sessions](docs/terminal-sessions.md).

## Running the services

`clankerbox-server` takes `--config` (hosts and profiles), `--state-dir`,
`--token-file` and `--listen`. `clankerbox-host` takes `--config`, and
`--init` prepares its state and guest authority once before first use. Both
print their flags with `--help`.

A listener without TLS must be a loopback address or a Unix socket. For a
remote listener, supply `--tls-cert` and `--tls-key`; the controller then
serves HTTP/2 over TLS 1.3 and clients verify the certificate against their
trust roots. An authenticated ingress additionally takes `--tls-client-ca` and
`--tls-client-peer-id`: the CA verifies client certificates, and the peer ID
must match a URI in the ingress certificate, such as
`spiffe://clankerbox/ingress/edge`. Bearer authentication is required in either
mode, and private key files must be owned by the service user with mode 0600.

## Repository layout

| Path | Contents |
| --- | --- |
| `cmd/` | The CLI and the three service binaries. |
| `internal/` | Controller, host, guest, client and shared packages. See [module contracts](docs/module-contracts.md). |
| `protocol/` | Protobuf sources and the TypeScript SDK. Generated Go lives in `gen/`. |
| `images/` | Linux guest image recipes and package locks. |
| `scripts/release/` | Bundle assembly, engine pins and third-party notices. |
| `tests/` | Live acceptance harnesses. |
| `docs/adr/` | Architecture decision records. |

## Development

```sh
make build
make test
make lint
```

`make test` runs the Go tests with the race detector and the Python tests for
image staging and release assembly. `make lint` needs golangci-lint v2.13.2.
Regenerating the RPC code is described in [protocol/README.md](protocol/README.md).

## License

MIT, see [LICENSE](LICENSE). Release bundles redistribute third-party
components under their own licenses; see
[scripts/release/README.md](scripts/release/README.md).
