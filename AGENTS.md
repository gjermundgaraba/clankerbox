# clankerbox: layout and house style

## Packages

| Path                            | Holds                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- |
| `packages/sdk/`                 | The contract, its schemas and errors, the client, profiles, prebuilds     |
| `packages/host/`                | The host: state, lifecycles, leases, guest scripts and the three runtimes |
| `packages/rivet-sandbox-agent/` | The Sandbox Agent provider and its recipes                                |
| `apps/clankerbox/`              | The CLI package: its commands and the `host` role                         |
| `tools/lint-fence/`             | The repository's own lint rules                                           |
| `tools/oxlint/anti-slop/`       | Vendored lint plugin                                                      |

The app imports the SDK and the host; the host and the provider import the SDK;
the SDK imports neither. Each package's `package.json` dependencies are that
boundary, since pnpm resolves nothing else.

## Layout

Code is grouped by domain, not by mechanism. Tests mirror `src/` under each
package's `tests/`; suites over a served host (`tests/composition/`) or the
whole CLI span domains on purpose.

**Host** (`packages/host/src`). Domain files sit flat in `src/`:

- `machines.ts`, `checkpoints.ts`: the `Machines` and `Checkpoints` services,
  one per resource, each with its `make` and `layer`. `Machines` runs an actor
  per machine and the runtime steps it invokes; `Checkpoints` captures
  and deletes.
- `lifecycle.ts`: a machine's statechart, the one domain file on xstate.
- `reconcile.ts`: `next`, what a machine does next from what was asked, its
  progress and what the runtime reports.
- `leases.ts`: the in-memory leases a step holds on what it changes or copies.
- `refs.ts`: the refs a runtime call takes, and whether a machine is made.
- `guest.ts`: setup and preparation, run in the guest.
- `usage.ts`: the machines in use, for the RAM budget and capacity.
- `startup.ts`: what runs before the actors start (clearing the captures the
  last host's end left), and `CannotStart`.
- `ids.ts`, `settings.ts`: IDs on this host, and the settings every runtime
  shares.
- Ports: `Store` and `NativeIds` (`store.ts`), `Runtime` (`runtime.ts`),
  `PortProbe` (`machine-ports.ts`).

Adapters live in `platform/`: `sqlite.ts` (the `Store`), `bind-probe.ts`
(`PortProbe`), the runtimes `smolvm.ts`, `tart/` and `boat/`, and what
they share, `process.ts` and `address.ts`. A domain file never imports
`platform/` or `composition/`.

`composition/` assembles the host: `config.ts` reads the config file,
`runtimes.ts` picks the runtime's Layer, `routes.ts` serves the contract, and
`host.ts`, the package's entry, builds the host over a runtime Layer and a
server Layer it is given.

**SDK** (`packages/sdk/src`). A library. Its root modules are the contract and
the vocabulary everything else imports: `api.ts`, `resources.ts`,
`errors.ts`, `ids.ts`, `release.ts`, `sizes.ts`, `describe.ts`. The rest are
`client.ts`, `profile.ts`, `setup.ts`, `prebuild.ts` and `ssh.ts`. The `.`
entry loads no Node; `./node` (`node.ts`) holds what needs it.

**App** (`apps/clankerbox/src`). One file or folder per command group
(`machines/`, `checkpoints.ts`, `hosts.ts`, `profiles.ts`, `prebuilds.ts`,
`ssh.ts` and `ssh-config.ts`, the SSH config it keeps, and `host.ts` for the
host role) over the CLI's shared kit (`command.ts`), the client config
(`config.ts`) and flag units (`units.ts`).
`clankerbox.ts` is the command tree.

**Provider** (`packages/rivet-sandbox-agent/src`). `sandboxes.ts` (the
operations), `tunnel.ts` (the ssh tunnel), `options.ts`, `agent.ts`, and
`provider.ts`, which runs them for the Sandbox Agent's Promise API.

## Where Layers are chosen

Only at an entry: the CLI's `main.ts` (Node's services, HTTP client and TCP
dial, and the path that runs it), the app's `host.ts` (the config's runtime and
Node's HTTP server, given to `hostLayer`), the SDK's `node.ts` (the client over
Node's HTTP), and the provider's `index.ts` (the client over its hosts, given
to `provider`). Tests pass their own: the host's `./testing` export builds a
host over a fake runtime, and the SDK's serves stub hosts over an in-memory
transport. Neither `./testing` export is published.

## House style

- **Service and Layer in one file.** A service's `make` and `layer` live in
  its file. An adapter's live in the adapter, and the SDK's Node Layer is in
  `node.ts` so `.` loads no Node.
- **Operations are contracts.** The host API is one effect-actions contract,
  `packages/sdk/src/api.ts`. The host's routes, the client's methods and the
  CLI's commands are derived from it; `actionCommands` in
  `apps/clankerbox/src/clankerbox.ts` fails to type-check when an action has
  no command, and each service method's errors are the contract's
  `Declared<action>`.
- **Errors carry context.** Each failure a caller can act on is its own tagged
  error with fields. The client sets `host` and `action`; `id` is the resource
  the error is about, and `made` the resource a create, fork, restore or
  capture makes. A file is `Invalid` with its `file`.
- **Tests are Effects** under `@effect/vitest`, on the test clock, except the
  suites that serve a host or run scripts in real time, which pass
  `excludeTestServices: true`. Effect is run by hand only in the CLI's
  `main.ts` and the provider's `provider.ts`, and in the provider's tests that
  drive its Promise API or a child program.
- **Property and model tests** cover IDs, units, the RAM budget, recipe
  packing, and the store's `desire`, as a model checked against SQLite;
  `next`, small enough, is checked over every state it decides from. Each
  states what is right without calling the code under test.
- **A machine's row is intent; its lifecycle is a statechart.** The row keeps
  what was asked (`desired`, numbered by the store's `generation` in the
  write that records it) and the progress no runtime can tell again (`made`,
  the host key). What the VM is doing is always read from the runtime, never
  stored, and the host reads every machine at once when it starts and every
  resting one at each recheck, one it couldn't read included. One actor per
  machine (`lifecycle.ts`, xstate under `@xstate/effect`) moves it toward what
  was asked a step at a time; a later request cuts a step short. A request
  answers from where the machine rests once the store has it: `Superseded`
  when a later request asked for something else by then. Steps hold leases
  instead of claims: what changes a resource owns it, what copies or reads it
  shares it, in memory only, so a host's end drops them with the work. A
  checkpoint exists only from a capture that succeeded until its delete
  begins, and never changes; the next delete of its name clears what a failed
  one left. A start starts the machine, also when it runs already, and
  prepares it. A machine is made by one step in the request that creates it,
  from what only that request holds: a copy or setup that fails deletes it,
  so a failure the host answers leaves no machine unmade, and a host that
  starts deletes every machine the last one's end left unmade, clears its
  failed captures and deletes and lets the actors finish the rest.
- **No prose comments.** A reason goes where something can check or show it:
  a type, a test's name, or the commit message. What stays: a one-line
  `// SAFETY:` above a type assertion, a one-line `// Source:` citing the
  upstream file a value comes from when a bump must re-check it, a tool
  directive with its reason after `--`, and a doc block on a type, an
  interface or one of their members, which is how a port states its contract.
  The SDK's and the provider's `src/` also keep a doc block on each export,
  since it ships to consumers.
- **A lint fence** (`tools/lint-fence`, each rule with its tests; settings in
  `vite.config.ts`): a host domain file imports only its siblings, `effect`,
  `effect/encoding` and the SDK, and `lifecycle.ts` alone also `xstate` and
  `@xstate/effect`; an adapter imports domain files, its own
  folder and `platform/`'s `process.ts` and `address.ts`; an app command
  imports only `effect` (with its `cli`, `http`, `process` and `socket`), the
  SDK and its siblings, leaving Node, `@effect/platform-node` and the host
  package to `main.ts` and `host.ts`;
  the provider takes Node and `@effect/platform-node` only in `index.ts` and
  `tunnel.ts`; the SDK's `.` entry
  imports no Node and uses no `Buffer` or `process`; `fence/no-manual-run`
  keeps hand-run Effect to the files above; and `fence/no-prose-comments`
  allows only the comments above.

Removable packages are not a practice here: the provider package is optional,
but CI publishes it beside the SDK.
