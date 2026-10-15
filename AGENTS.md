# clankerbox: layout and house style

## Packages

| Path                            | Holds                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| `packages/sdk/`                 | The contract, its schemas and errors, the client, profiles, prebuilds  |
| `packages/host/`                | The host: state, claims, actions, guest scripts and the three runtimes |
| `packages/rivet-sandbox-agent/` | The Sandbox Agent provider and its recipes                             |
| `apps/clankerbox/`              | The binary: the CLI's commands and the `host` role                     |
| `tools/lint-fence/`             | The repository's own lint rules                                        |
| `tools/oxlint/anti-slop/`       | Vendored lint plugin                                                   |
| `tools/release/`                | The single-executable build and its smoke test                         |

The app imports the SDK and the host; the host and the provider import the SDK;
the SDK imports neither. Each package's `package.json` dependencies are that
boundary, since pnpm resolves nothing else.

## Layout

Code is grouped by domain, not by mechanism. Tests mirror `src/` under each
package's `tests/`; suites over a served host (`tests/composition/`) or the
whole CLI span domains on purpose.

**Host** (`packages/host/src`). Domain files sit flat in `src/`:

- `machines.ts`, `checkpoints.ts`: the `Machines` and `Checkpoints` services,
  one per resource, each with its `make` and `layer`.
- `claims.ts`: the order every action runs in: claim, check, work, record.
- `guest.ts`: setup and preparation, run in the guest.
- `usage.ts`: the machines in use, for the RAM budget and capacity.
- `startup.ts`: recovery before the host serves, and `CannotStart`.
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
`ssh.ts`, and `host.ts` for the host role) over the CLI's shared kit
(`command.ts`), the client config (`config.ts`) and flag units (`units.ts`).
`clankerbox.ts` is the command tree.

**Provider** (`packages/rivet-sandbox-agent/src`). `sandboxes.ts` (the
operations), `tunnel.ts` (the ssh tunnel), `options.ts`, `agent.ts`, and
`provider.ts`, which runs them for the Sandbox Agent's Promise API.

## Where Layers are chosen

Only at an entry: the CLI's `main.ts` (Node's services and HTTP client), the
app's `host.ts` (the config's runtime and Node's HTTP server, given to
`hostLayer`), the SDK's `node.ts` (the client over Node's HTTP), and the
provider's `index.ts` (the client over its hosts, given to `provider`). Tests
pass their own: the host's `./testing` export builds a host over a fake
runtime, and the SDK's serves stub hosts over an in-memory transport. Neither
`./testing` export is published.

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
  packing and the store's claims, as a model checked against SQLite. Each
  states what is right without calling the code under test.
- **Lifecycles are not state machines.** An action's claim is a SQLite
  transaction, and its states are the `ActionRecord` its row keeps.
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
  `effect/encoding` and the SDK; an adapter imports domain files, its own
  folder and `platform/`'s `process.ts` and `address.ts`; the SDK's `.` entry
  imports no Node and uses no `Buffer` or `process`; `fence/no-manual-run`
  keeps hand-run Effect to the files above; and `fence/no-prose-comments`
  allows only the comments above.

Removable packages are not a practice here: the provider package is optional,
but CI publishes it beside the SDK.
