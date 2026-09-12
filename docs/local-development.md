# Local development

`clankerbox dev` provides a local Clankerbox endpoint for running applications
such as Clankerdesk. It runs the production HTTP controller, SQLite operation
queue, SSH session transport and `clankerbox-guest` daemon. Terminals use the real
guest protocol, PTYs, Ghostty snapshots, input, resize and reconnection behavior.
No VM host, remote account, system SSH server or separately installed guest binary
is required. The supported platforms are macOS and Linux on arm64 or amd64.

Build and start from this repository:

```sh
make build
./bin/clankerbox dev
```

The command waits for the guest to be ready, then prints the controller URL and
an `export CLANKERDESK_CLANKERBOX='...'` command. Run that export in the terminal
where you launch Clankerdesk's server, then start Clankerdesk normally. In its
machine picker, select the existing `local` machine and choose **Use for
terminals**. New terminals then run on this computer.

The printed configuration uses Clankerdesk's existing `url` and `tokenPath`
fields. No changes to Clankerdesk's transport are needed. It deliberately omits
machine creation defaults: this environment already supplies its one machine.
Additional creates are rejected during admission, before any machine record or
capacity reservation is committed, including while the local machine is stopped.
Other consumers use the same bearer-authenticated `/v1` API and
`GET /v1/machines/{id}/sessions/stream` HTTP upgrade as a deployed controller.

## Workspace and state

By default the environment lives in `~/.local/state/clankerbox-dev`, and new
shells start in its `workspace` directory. Choose a repository on the first run:

```sh
./bin/clankerbox dev --workspace /absolute/path/to/your/repository
```

That workspace is retained for subsequent runs. An explicit `cwd` requested by a
consumer still takes precedence. Shells run as your user and use your installed
shell, tools, environment and home configuration. This is local execution with
your filesystem permissions; the workspace directory is not a sandbox. Agents
use their ordinary locally configured credentials.

The dev controller defaults to `127.0.0.1:4780`. Use a separate state directory
and port for another environment:

```sh
./bin/clankerbox dev --state-dir /tmp/my-clankerbox-dev --listen 127.0.0.1:4781
```

The state directory must be private (0700) and its path short enough for Unix
sockets. Only numeric loopback listen addresses are accepted. State includes a
generated private token, stable machine and SSH identities, controller database,
guest session records, and these generated connection files:

- `clankerdesk.json`: the host-only Clankerdesk configuration.
- `client.json`: configuration for Clankerbox's machine and session API commands.
- `connection.json`: URL, machine ID, workspace and configuration paths.

For example:

```sh
./bin/clankerbox --config ~/.local/state/clankerbox-dev/client.json machines
./bin/clankerbox --config ~/.local/state/clankerbox-dev/client.json sessions local
```

`clankerbox --json dev` prints one connection object when ready. Use
`--listen 127.0.0.1:0` if a dynamically assigned port is useful. Keep the command
running while the application needs the controller. Restarting on the default or
another fixed port lets the consumer reconnect without changing its configuration.

## Lifetimes and shutdown

Ctrl-C stops the dev controller and its connections. The detached guest keeps
terminal processes running. Starting `clankerbox dev` again with the same state
directory reconnects to the same daemon, machine and sessions. Restarting
Clankerdesk likewise leaves the guest processes intact.

Startup allows pending or unresolved lifecycle operations to reconcile before a
new start is accepted. A transient guest launch failure can therefore recover on
restart. Recovery remains bounded by the 30-second startup deadline; an operation
may still be unresolved if its cause persists.

Guest launch cancellation or readiness failure terminates and reaps the new
helper before another lifecycle operation can proceed.

To end the retained guest and its shells, first stop the foreground controller,
then run:

```sh
./bin/clankerbox dev stop
# With custom state:
./bin/clankerbox dev --state-dir /tmp/my-clankerbox-dev stop
```

The workspace and machine identity remain. The next dev run starts a fresh guest;
sessions whose daemon ended become lost records, rather than continuing processes.
API machine stop/start has the same cold-restart boundary. Deleting a stopped
local machine retains workspace files but retires that environment's machine;
use a new state directory for a new environment. Stop the environment before
removing its state directory.

## Scope

The `local` profile supports the existing machine's start/stop/delete lifecycle,
labels and guest sessions. Its CPU/RAM values are admission bookkeeping
for one local machine, not resource limits. Forks and checkpoints are explicitly
unsupported. There is no VM isolation, Linux emulation, disk branching or RAM
continuation across daemon shutdown.

The internal SSH transport accepts only the controller's terminal key and fixed
guest proxy command. Direct SSH, exec, SCP, VNC and automatic TCP
forwarding are not provided by this mode. Applications interact through the guest
session API; local services they start can be reached directly on localhost.

Clankerdesk requires the same guest protocol revision and Ghostty WASM build as
Clankerbox. Keep their pinned artifacts in sync. After an incompatible guest
upgrade, stop the retained dev guest and restart it to use the new binary. Dev
startup checks the engine digest even when reconnecting to a retained running
guest and reports an error if it differs; the guest and its sessions stay alive.

Verification includes an executable integration test with real HTTP upgrades,
guest sessions, controller restart, explicit guest shutdown and API stop/start.
On 2026-09-09, Clankerdesk's actual terminal service also passed a local connection,
workspace shell, consumer restart/resume, input/output and resize check against
this dev server. The product race-test suite and lint checks passed. This checks
local terminal integration, not VM or browser UI qualification.
