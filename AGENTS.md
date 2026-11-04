<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# clankerbox: layout and house style

## Packages

| Path                            | Holds                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| `packages/sdk/`                 | The client contract, its schemas and errors, the client                |
| `packages/host-contract/`       | The host contract, private: shared by the server and the host alone    |
| `apps/server/`                  | The control plane: rows, charts, leases, the loops, placement          |
| `apps/host/`                    | A host: runs operations on the two runtimes, and keeps no database     |
| `apps/cli/`                     | The CLI: its commands, over the SDK                                    |
| `packages/rivet-sandbox-agent/` | The Sandbox Agent provider and its recipes                             |
| `tools/lint-fence/`             | The repository's own lint rules                                        |

One app per program: `clankerbox`, `clankerbox-server` and `clankerbox-host`
publish from `apps/`, at the SDK's version. The CLI imports the SDK; the server
and the host import the SDK and the host contract, and the server never imports
the host, which it reaches only over the network; the provider imports the SDK;
the SDK imports none of them. A client never reaches a host's API: it knows one
URL, and hosts only as the operator's views `hosts` and `capacity`. Each
package's `package.json` dependencies hold that boundary, since pnpm resolves
nothing else. Its dev dependencies resolve in `src` as well, so the lint fence
keeps an app's `src` off the apps its tests take. Tests are the one place apps
meet: the server's take the host's `./testing`, and the CLI's the server's,
each as a dev dependency.

## Layout

Code is grouped by domain, not by mechanism. Tests mirror `src/` under each
package's `tests/`; suites over a served control plane (`apps/server/tests`) or
the whole CLI span domains on purpose.

**Server** (`apps/server/src`). Domain files sit flat in `src/`:

- `chart.ts`: `applied`, one event on one row, which answers the next row and
  the operation it begins or finishes, and what the charts share.
- `machine-chart.ts`, `checkpoint-chart.ts`: the xstate charts. Each leaf's `meta`
  holds its `phase`, its `step` and the `activity` its loop runs there.
- `driver.ts`: `driver`, the loops of one resource, at most one per name, with
  the activity of a row's leaf picking each turn; `untilRest`, a build's wait.
- `machines.ts`, `checkpoints.ts`: the `Machines` and `Checkpoints` services,
  one per resource, each with its `make` and `layer`. `Machines` takes the
  requests, places a create and starts the recheck; `Checkpoints` captures,
  deletes, and keeps a build's copy. Each gives `driver` its reads and its writes.
- `templates.ts`: the `Templates` service, with its `make` and `layer`. A build
  makes a builder, runs its setup, copies it and deletes it, then ends the build
  in its template's row, keeping the last 2 ready builds; a create from a
  template is `Machines`'s. A host with a build store publishes the copy before
  the build ends ready, and a recheck has every other host of the kind fetch each
  ready build it lacks, as a checkpoint row of the build on that host.
- `steps.ts`: what a host is sent for an operation, built afresh from the rows at
  each delivery.
- `copies.ts`: a copy's spec, and why its source refuses it.
- `fleet.ts`: capacity, and what a recheck does beyond each loop: tells a
  restarted host its machines, and ends old failures.
- `machine-view.ts`: what a client reads of a machine, and `waiting`, which a
  read tells.
- `operations.ts`: plain functions of a step on its host. `poll` sends it when
  the host hasn't had it and says when it was lost, and `collect` lets the host
  forget a report once it is stored.
- `hosts.ts`: the members, the one file that calls a host, and the log of a host
  that stops answering.
- `placement.ts`: which hosts can take a create, in order.
- `tailnet.ts`: when a join is due. `settings.ts`: what the server runs on.
- `store.ts`: the `Store` port, the rows, the operations and their leases.

`platform/sqlite.ts` is the `Store`, and loads each chart's `leaves` at runtime to
validate `state`. `composition/`: `config.ts` reads the config file, `routes.ts`
serves the client contract, and `server.ts`, the package's entry, builds the
server over a server Layer it is given. A domain file never imports `platform/`
or `composition/`.

**Host** (`apps/host/src`). Domain files sit flat in `src/`:

- `operations.ts`: the `Operations` service. It runs a step to its end, keeps its
  report until collected, fences by sequence, and tells a restart by `boot`.
- `guest.ts`: setup and preparation, run in the guest.
- `usage.ts`: the machines in use, and the RAM a runtime holds beside them, for the RAM budget and capacity.
- `settings.ts`: what a host runs on.
- `builds.ts`: `publish`, `fetch` and `unpublish` of a checkpoint through the
  `BuildStore` port, objects by key and a manifest per build, written last.
- Ports: `Runtime` (`runtime.ts`), `PortProbe` (`machine-ports.ts`), `Tailnet`
  (`tailnet.ts`), which mints a machine's tailnet key, provided only on a host
  that joins a tailnet, and `BuildStore` (`builds.ts`), provided only on a host
  with a `builds` setting.

Adapters live in `platform/`: `bind-probe.ts` (`PortProbe`), `tailscale.ts`
(`Tailnet`, over Tailscale's API), `s3.ts` (`BuildStore`, over S3, path-style
and signed), the runtimes `smolvm.ts` (`linux`) and `tart/`
(`mac`), and what they share, `process.ts`. A domain file never
imports `platform/` or `composition/`.

`composition/` assembles the host: `config.ts` reads the config file,
`runtimes.ts` picks the kind's runtime Layer, `routes.ts` serves the host
contract, and `host.ts` builds the host over a runtime Layer and a server Layer
it is given, with the config's tailnet and build store, if any.

**Host contract** (`packages/host-contract/src`). `api.ts`: `HostHttp`, the
`Step`s, `Operation`, `Report`, `HostInfo`.

**SDK** (`packages/sdk/src`). A library. Its root modules are the client
contract and the vocabulary everything else imports: `api.ts`, `resources.ts`,
`errors.ts`, `ids.ts`, `release.ts` (with `versionCheck`, for a server of either
contract), `sizes.ts`, `describe.ts`. The rest are `client.ts`, `setup.ts`
and `ssh.ts`. The `.` entry loads no Node; `./node` (`node.ts`) holds what
needs it.

**App** (`apps/cli/src`). One file or folder per command group
(`machines/`, `checkpoints.ts`, `templates.ts`, `hosts.ts`,
`ssh.ts` and `ssh-config.ts`, the SSH config it keeps) over the CLI's shared kit
(`command.ts`), the client config (`config.ts`) and flag units (`units.ts`).
`clankerbox.ts` is the command tree.

**Provider** (`packages/rivet-sandbox-agent/src`). `sandboxes.ts` (the
operations), `tunnel.ts` (the ssh tunnel), `options.ts`, `agent.ts`, and
`provider.ts`, which runs them for the Sandbox Agent's Promise API.

## Where Layers are chosen

Only at an entry: each app's `main.ts` (the CLI's: Node's services, HTTP client
and TCP dial, and the path that runs it; the server's: the config's server Layer
and Node's HTTP client, given to `serverLayer`; the host's: the config kind's
runtime and Node's HTTP server, given to `hostLayer`), the SDK's `node.ts` (the
client over Node's HTTP), and the provider's `index.ts` (the client over its
server URL, given to `provider`). Tests pass their own: the host's `./testing`
export builds a host over a fake runtime, the server's `./testing` a control
plane over such hosts with real HTTP between them, and the SDK's
`./testing/stub-server` serves a stub control plane over an in-memory transport,
beside `./testing/clock`, `./testing/files` and `./testing/keys`. None of the
`./testing` exports is published.

## House style

- **Service and Layer in one file.** A service's `make` and `layer` live in
  its file. An adapter's live in the adapter, and the SDK's Node Layer is in
  `node.ts` so `.` loads no Node.
- **Operations are contracts.** The client API is one effect-actions contract,
  `packages/sdk/src/api.ts`, and the host API another,
  `packages/host-contract/src/api.ts`. The server's routes, the client's methods
  and the CLI's commands are derived from the first; `actionCommands` in
  `apps/cli/src/clankerbox.ts` fails to type-check when an action has
  no command, and each service method's errors are the contract's
  `Declared<action>`.
- **Errors carry context.** Each failure a caller can act on is its own tagged
  error with fields. The client sets `action`; `id` is the resource the error
  is about, and `made` the resource a create, fork, restore or capture makes. A
  file is `Invalid` with its `file`.
- **Tests are Effects** under `@effect/vitest`, on the test clock, except the
  suites that serve a host or a control plane or run scripts in real time, which
  pass `excludeTestServices: true`. Effect is run by hand only in each app's
  `main.ts` and the provider's `provider.ts`, in the provider's tests that
  drive its Promise API or a child program, and in `tests/serve.ts` of the server
  and the host, the programs that serve them over the fake runtime for the
  `verify-clankerbox` skill.
- **Property and model tests** cover IDs, units, the RAM budget, recipe
  packing, and the store's `advance` and leases, as models checked against
  SQLite; a chart, small enough, is checked with every event from every leaf.
  Each states what is right without calling the code under test.
- **A chart is pure and runs inside the write.** `applied` rebuilds a snapshot
  from the row, runs `transition` once inside the transaction of `store.advance`,
  and drops it, so no snapshot outlives the write. A chart has no `invoke`, no
  timers and no actors, and what it needs from the world rides on its event.
  Fibers do what takes time: a `driver` loop reads a host, sends a step and polls
  it, and tells the chart what it found as an event. A template's build is no
  chart: it is an Effect sequence in `templates.ts` over a machine and a
  checkpoint, and its row says only that it runs or how it ended. A leaf's name
  is stored, so renaming one is a migration.
- **A machine's row is intent and progress; the VM is always read.** The row, on
  the control plane, keeps what was asked (`desired`), its chart's leaf (`state`),
  which holds how far it is and the `phase` a client waits on, and the progress no
  runtime can tell again (`prepared`, the host key, the runtime pin its VM booted
  under). A delete is the `deleting` region, so the wire's `desired` of `deleted`
  comes from the leaf. What the VM is doing is read from its host, never stored,
  and so is `waiting`, which a read that finds the VM unknown shows. One loop per
  machine moves it toward what was asked a whole step at a time, and a later
  request cuts a step short. A request takes the row out of rest in the write
  that records it, so a resting `phase` read after it has seen it. A client waits
  by reading, and works out `Superseded` from what it reads. A wait follows the
  machine it asked by `createdAt`, reads on through `waiting` as through an
  outage of the control plane, and ends `Unavailable`, the request saved, once
  two minutes pass with no read that tells it anything.
- **A step is a whole operation on a host.** The write that enters a leaf with a
  `step` records an operation in the store with its leases, and the loop then
  sends it. The host runs it to its end whether or not the caller stays, and
  keeps its report until it is collected or it accepts the scope's next step,
  which the loop sends only once the report is stored, so a control plane that
  restarts finds it by ID and carries on. Delivering an ID
  again returns that operation; a sequence not above the scope's is refused and a
  higher one cuts short what still runs there. `boot`, new with each host
  process and carried by the step, tells a restart from a delivery that hasn't
  come: a step its host no
  longer holds is decided afresh, and a make is undone. A step's report is stored
  before its host forgets it. A runtime's stop, and Tart's pause, mask
  interruption from the command that halts a running VM until it has, so a step
  cut short reports `cancelled` only once the VM is where that command takes it.
- **Leases are rows.** They are the `operations` table: what changes a resource
  owns it, what copies or reads it shares it, taken in the write that begins the
  operation, and a lease that refuses leaves that write undone. They survive a
  restart, as the steps they guard do. The build store is one lease too,
  `builds/`: a publish shares it, and the delete that unpublishes owns it, so its
  sweep of unreferenced objects never meets a publish that skipped one.
- **Setup scripts stay in memory, on both sides.** They may carry secrets, and
  are never stored or logged. A make that hasn't reached its host when the
  control plane ends can't be sent again, and is undone.
- **A failed create keeps its row.** A make that fails, whatever the step, goes
  `undoing`, deletes the VM, again at each recheck while that fails, and rests
  `undone` with its error for `failedRowsLast`. A delete clears it at once and a
  create of the name replaces it. A `Capacity` failure moves the create to the
  next host instead, for a template's the next that holds its build, once its VM is gone, while the control plane that took the create runs; after a restart it rests `undone`. Nothing ambiguous ever moves one.
- **A start starts the machine, also when it runs already, or resumes it when it
  is paused, and prepares it.** A pause saves a running machine and stops its
  VM, leaving a stopped one stopped, and stops one the runtime can't save: a VM
  booted under another pin, or one Tart can't suspend. A paused machine resumes
  only under the pin it booted under, for a start, and for a stop on a runtime
  whose stop resumes it, and a capture or fork copies only a VM booted under the
  host's pin; the step carries the pin and the host compares. A resize is a step
  too, and the row keeps the sizes the runtime reads after it, also after one
  that failed part way. A checkpoint is usable only `ready`, and never changes; a
  template's current build moves to a build only once its setup has run and its
  copy is ready, and a control plane that restarts ends a build that ran failed
  and deletes its builder, which is ephemeral.
- **Shell comments.** Lint doesn't read the recipes' shell scripts; a comment
  there states only a platform or upstream fact the script can't show.
- **A lint fence** (`tools/lint-fence`, each rule with its tests; settings in
  `oxlint.config.ts`): a server or host domain file imports only its siblings,
  `effect`, `effect/encoding`, the SDK and the host contract; `chart.ts` and
  `*-chart.ts` import only `xstate`, each other and the store's and `hosts.ts`'s
  types, and
  `fence/no-impure` keeps `Date`, `Math.random` and `crypto` out of
  them; `apps/server/src/hosts.ts` alone calls a host; the server's `composition/` and `main.ts` never load the
  host package; the server's only adapter is the `Store`, and a host's adapters
  can't import `node:sqlite`; a host adapter imports domain files, its own
  folder and `platform/`'s `process.ts`; the host contract
  imports `effect`, the SDK and effect-actions; an app command imports only
  `effect` (with its `cli`, `encoding`, `http`, `process` and `socket`), the SDK
  and its siblings, so a client can't reach the host contract; the provider takes
  Node and `@effect/platform-node` only in `index.ts` and `tunnel.ts`; the SDK's
  `.` entry imports no Node and uses no `Buffer` or `process`; and
  `fence/no-manual-run` keeps hand-run Effect to the files above.

Removable packages are not a practice here: the provider package is optional,
but CI publishes it beside the SDK.

## Effect

Before writing or reviewing Effect code, read `node_modules/effect/AGENTS.md` in the package you are changing and the examples it links under `ai-docs/`. They ship with the installed `effect`, so they match the APIs the code compiles against. For exact signatures, read that package's installed source and types in `node_modules/effect` and `node_modules/@effect/*`. Do not write Effect APIs from memory or from examples for another version.

## Lint and format

`vp check` formats, lints and type-checks the repository; `vp check --fix` applies the fixes. It reads `oxlint.config.ts` and `oxfmt.config.ts` through `vite.config.ts`. Format is Ultracite's, and skips `AGENTS.md`, whose Vite+ block `vp config` rewrites on every install. `vp install` patches Oxlint with the Effect rules through the root `prepare` script.

Lint comes from `@clanker-stuff/oxlint-config` through `config()` in `oxlint.config.ts`, with this repository's overrides there. Fix the code rather than add a lint exception. There are no inline `oxlint-disable` comments.

## Dependencies

npm dependencies move by hand through the pnpm catalog in `pnpm-workspace.yaml`; Dependabot keeps only the SHA-pinned actions in `.github/workflows` current. Registry releases wait a day (`minimumReleaseAge`), except what `minimumReleaseAgeExclude` lists (the toolchain, Effect, xstate and our own scopes), so their bumps land the day they publish.

`xstate` is pinned to one alpha, on the server alone, and sits on the write path. For a bump, `.agents/skills/verify-machine-answers/model/Chart.tla` is the golden file of what the model holds of a row: a chart that decides differently there changes it. The table leaves out the join, the pin, a resize and the events the model doesn't send, as the skill's bounds say; `apps/server/tests/machine-chart.test.ts` holds those.
