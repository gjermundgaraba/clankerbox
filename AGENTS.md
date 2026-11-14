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
| `packages/host-contract/`       | The host contract and the journal, private: the server's and host's    |
| `apps/server/`                  | The control plane: rows, charts, leases, the loops, placement          |
| `apps/host/`                    | A host: runs operations on one of the runtimes, and keeps no database  |
| `apps/cli/`                     | The CLI: its commands, over the SDK                                    |
| `packages/rivet-sandbox-agent/` | The Sandbox Agent provider and its recipes                             |
| `packages/amp-orbs/`            | The Amp orb provider: the dispatch program `amp orb provider` runs     |
| `tools/lint-fence/`             | The repository's own lint rules                                        |

One app per program: `clankerbox`, `clankerbox-server` and `clankerbox-host`
publish from `apps/`, at the SDK's version. The CLI imports the SDK; the server
and the host import the SDK and the host contract, and the server never imports
the host, which it reaches only over the network; each provider imports the
SDK; the SDK imports none of them. A client never reaches a host's API: it knows one
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
  the activity of a row's leaf picking each turn; `untilRest`, a build's wait;
  `apart`, which logs a loop or a build as its own, not as the request that
  began it.
- `machines.ts`, `checkpoints.ts`: the `Machines` and `Checkpoints` services,
  one per resource, each with its `make` and `layer`. `Machines` takes the
  requests, places a create and starts the recheck; `Checkpoints` captures,
  deletes, and keeps a build's copy. Each gives `driver` its reads and its writes.
- `templates.ts`: the `Templates` service, with its `make` and `layer`. A build
  makes a builder, runs its setup, copies it and deletes it, then ends the build
  in its template's row, keeping the last 2 ready builds; a create from a
  template is `Machines`'s. A host with a build store publishes the copy before
  the build ends ready, and a recheck has every other host of the runtime fetch each
  ready build it lacks, as a checkpoint row of the build on that host.
- `steps.ts`: what a host is sent for an operation, built afresh from the rows at
  each delivery.
- `copies.ts`: a copy's spec, and why its source refuses it.
- `fleet.ts`: capacity, and what a recheck does beyond each loop: tells a
  restarted host its machines, again until it finds each, and stores the handle
  and endpoint it answers in each row; asks each host for the handle of each
  ready checkpoint row that has none, until it is found or its runtime keeps
  nothing of its own for it; then sends each host that answers the
  instances the store retired there, for its sweep, noting when a sweep first
  found each gone and keeping each it answers it left; and ends old failures and
  forgets retired instances a day after.
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
server over a server Layer it is given, through the host contract's `journal`. A
domain file never imports `platform/` or `composition/`.

**Host** (`apps/host/src`). Domain files sit flat in `src/`:

- `operations.ts`: the `Operations` service. It runs a step to its end, keeps its
  report until collected, fences by sequence, and tells a restart by `boot`. Its
  `sweep` deletes what the runtime's `owned` facet lists whose instance the
  control plane retired and no step it holds names, and answers what it left.
  Its `find` answers the
  handle of each checkpoint a row holds without one, in the time a read takes.
- `guest.ts`: setup, preparation, and the hook a stop, pause or delete
  runs first, all run in the guest.
- `usage.ts`: the machines in use, and the RAM a runtime holds beside them, for the RAM budget and capacity.
- `settings.ts`: what a host runs on.
- `builds.ts`: `publish`, `fetch` and `unpublish` of a checkpoint through the
  `BuildStore` port, objects by key and a manifest per build, written last.
- `reach.ts`: the `Reaches` service. It picks a make's port, answers the
  endpoint a client reaches it at, has a `published` runtime bind it, and opens,
  closes and on adopt reopens the relays of a `relayed` runtime.
- Ports: `Runtime` (`runtime.ts`), with its `traits`, its `guest` (`debian` or
  `macos`, which picks the base `guest.ts` prepares), its `reach` (`published` or `relayed`)
  its `prepares` (`always` where its images lack the login user, else
  `with-setup`), and the facets `admission`, `files` and `owned`, each present or
  absent as a whole,
  `PortProbe` (`machine-ports.ts`), `Box` (`box.ts`), what the box tells a host
  beside its config: its uid, whether a process has ended, and its ephemeral
  ports, `Relays` (`reach.ts`), `Tailnet`
  (`tailnet.ts`), which mints a machine's tailnet key, provided only on a host
  that joins a tailnet, and `BuildStore` (`builds.ts`), provided only on a host
  with a `builds` setting. Each `Runtime` method that acts on a machine or
  checkpoint already made takes a `Target`, the runtime's own opaque `Handle`
  beside the name and instance. `find` answers the handle for an instance while
  the runtime keeps anything of it, also of one a delete removed only part way.
  `make`, the one create, restore or fork, answers the handle it made, and
  `capture` and `install` the handle of the checkpoint they make. `Operations`
  resolves each target from its row's handle, else by `find`. `runtime.ts`
  states the two rules every adapter keeps, and `tests/runtime-contract.ts` is
  the suite each runtime passes over its own fake provider: the fake runtime's
  three presets, `smolvm`, `tart` and `fixed`, which is neither and has size
  classes, a pause that stops, machines that stop on their own and the `owned`
  facet, and the four adapters over `tests/smolvm-model.ts`,
  `tests/scripted-mac.ts`, `tests/fake-smol-cloud.ts` and `tests/fake-boat.ts`.

Adapters live in `platform/`: `bind-probe.ts` (`PortProbe`), `box.ts` (`Box`,
which reads Linux's `ip_local_port_range`), `relay.ts`
(`Relays`, a TCP listener that carries each connection through a runtime's
dial), `tailscale.ts` (`Tailnet`, over Tailscale's API), `s3.ts` (`BuildStore`,
over S3, path-style and signed), the runtimes `smolvm/` (the lock that keeps
a box to one smolvm host in `one-per-box.ts`), `tart/`,
`smol-cloud/` (smol cloud's API in `api.ts`, the SSH tunnel in `tunnel.ts`) and
`boat/` (boat's REST API with its retries and headers in `api.ts`, the guest
channel in `ssh.ts`, OpenSSH from the host pinned to the host key boat answers),
each with its `RuntimeTraits` in its `traits.ts`, and what they share,
`process.ts`. `tests/fake-smol-cloud.ts` and `tests/fake-boat.ts` serve each
provider's API over loopback, for its adapter's tests and for the verify skill,
and `tests/live/smol-cloud.test.ts` and `tests/live/boat.test.ts`, run by
`vp run test:live` in `apps/host` with `SMOL_MACHINES_API_KEY` or
`BOAT_API_KEY`, and `TAILSCALE_AUTHKEY`, set and never in CI, check the real
accounts. A domain file never imports `platform/` or `composition/`.

`composition/` assembles the host: `config.ts` reads the config file,
`runtimes.ts` is the registry of runtimes, one entry each under the name a host
config's `runtime` gives it, with its settings and its Layer, `routes.ts` serves the host contract, and `host.ts` builds the
host over a runtime Layer and a server Layer it is given, with the config's
tailnet and build store, if any.

**Host contract** (`packages/host-contract/src`). `api.ts`: `HostHttp`, the
`Step`s, `Operation`, `Report`, `HostInfo`. `journal.ts`: `journal`, what the
control plane's log and a host's hold of the requests each serves, one
middleware for both, as both must log no secret a request carries: a request
that answers `Internal` or fails as no action declares logs at error, with its
method and path, one its caller or the stop cuts logs nothing, and every other
logs at debug.

**SDK** (`packages/sdk/src`). A library. Its root modules are the client
contract and the vocabulary everything else imports: `api.ts`, `resources.ts`,
`traits.ts` (a runtime's `RuntimeTraits`, and the pure rules each decision about
a machine goes through), `errors.ts`, `ids.ts`, `release.ts` (with `versionCheck`, for a server of either
contract), `sizes.ts`, `describe.ts`. The rest are `client.ts`, `setup.ts`
and `ssh.ts`. The `.` entry loads no Node; `./node` (`node.ts`) holds what
needs it.

**App** (`apps/cli/src`). One file or folder per command group
(`machines/`, `checkpoints.ts`, `templates.ts` and `template-file.ts`, the
YAML file a build reads, `hosts.ts`,
`ssh.ts` and `ssh-config.ts`, the SSH config it keeps) over the CLI's shared kit
(`command.ts`), the client config (`config.ts`) and flag units (`units.ts`).
`clankerbox.ts` is the command tree.

**Provider** (`packages/rivet-sandbox-agent/src`). `sandboxes.ts` (the
operations), `tunnel.ts` (the ssh tunnel), `options.ts`, `agent.ts`, and
`provider.ts`, which runs them for the Sandbox Agent's Promise API.

**Amp orbs** (`packages/amp-orbs/src`). `dispatch.ts` (a job's spawn, pause or
delete, over the client), `job.ts` (the job, from the environment Amp gives),
`settings.ts` (the sizes of each orb type, the user, the snapshot expiry),
`names.ts` (a clankerbox name for an Amp ID), and `provider.ts`, the command.

## Where Layers are chosen

Only at an entry: each app's `main.ts` (the CLI's: Node's services, HTTP client,
TCP dial and `Environment`, the environment `exec --env NAME` reads, an empty
value kept, and the path that runs it; the server's: the config's server Layer
and Node's HTTP client, given to `serverLayer`; the host's: the box's facts,
the config's runtime, from the registry, and Node's HTTP server, given to
`hostLayer`), the SDK's `node.ts` (the
client over Node's HTTP), the provider's `index.ts` (the client over its
server URL, given to `provider`), and the Amp orb provider's `main.ts` (Node's
services and HTTP client, given to its command). Tests pass their own: the host's `./testing`
export builds a host over a fake runtime, its `./testing/smol-cloud` and
`./testing/boat` serve a provider's fake API and give its traits, the server's `./testing` a control
plane over such hosts with real HTTP between them, and the SDK's
`./testing/stub-server` serves a stub control plane over an in-memory transport,
beside `./testing/clock`, `./testing/files` and `./testing/keys`, and
`./testing/equality`, which every app's and package's tests load as a setup
file, so two tagged errors compare equal only with the same message; the lint
fence's tests, which compare no tagged errors, load none. None of the
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
  is about, and `made` the resource a create, fork, restore or capture made or
  may have made, never set on a refusal. A file is `Invalid` with its `file`.
- **Tests are Effects** under `@effect/vitest`, on the test clock, except the
  suites that serve a host or a control plane or run scripts in real time, which
  pass `excludeTestServices: true`. Effect is run by hand only in each app's
  `main.ts` and the provider's `provider.ts`, in the provider's tests that
  drive its Promise API or a child program, in the Amp orb provider's `main.ts`,
  and in the server's `tests/serve.ts` and the host's `tests/serving.ts`, which
  the host's `tests/serve.ts` and each `tests/<runtime>/serve.ts` run: the
  programs that serve a control plane, and a host over the fake runtime or over
  a provider's fake API with the faults `fault.sh` asks, for the
  `verify-clankerbox` skill.
- **Property and model tests** cover IDs, units, the RAM budget, recipe
  packing, the rules of runtime traits, and the store's `advance` and leases, as models checked against
  SQLite; a chart, small enough, is checked with every event from every leaf.
  Each states what is right without calling the code under test. The runtime
  traits' JSON Schema is pinned per release in `packages/sdk/tests/runtime-traits/`:
  a changed field or value takes a new file for the next minor, never an edit of
  a pinned one, and `npm.yml` publishes a tag only for the release the newest
  pins.
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
  under), with the runtime's `handle` for its VM and the `endpoint` its host gave
  it, which a client's `ssh` reads. A delete is the `deleting` region, so the wire's `desired` of `deleted`
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
  before its host forgets it. A step acts on its row's handle, or on what the
  runtime finds of the row's instance, never on a VM by its name alone, and a
  remove or a delete of a checkpoint that finds nothing is done, while one whose
  search fails fails. A runtime's stop, and smolvm's and Tart's pause, mask
  interruption from the command that halts a running VM until it has, so a step
  cut short reports `cancelled` only once the VM is where that command takes it.
  A smolvm host that starts resumes a machine a killed pause left `pausing`, so
  no step runs a hook in a frozen guest.
- **A sweep deletes only what its store retired.** A runtime with the `owned`
  facet lists what carries the host's mark at its provider, and nothing else. A
  store retires an instance on a host in the write that ends its row's hold on
  it there: the row goes, moves to another host under a new instance, or rests
  undone or failed. The record outlives the row, and lasts a day of the control
  plane's clock from the first sweep that reached its host and left nothing of
  it, while one no sweep has reached, or the last sweep left, stays; no row takes
  the instance again. Each recheck, after the adopts, sends each host the
  instances retired there, and the host deletes those it lists that no step it
  holds names, a machine alone, leaving every checkpoint it holds, and answers
  each it left: one a step names, one whose delete failed, and one its provider
  refuses with `Conflict` while something depends on it. The sweep deletes
  nothing for want of a claim, so a wiped or second store sweeps nothing of
  another store's, and a make that lands a day after a sweep first found it
  gone is left at its provider. A checkpoint a provider holds through its
  machine has no mark: a `start` and a `remove` carry `keep`, every checkpoint
  handle the rows hold on the host, as a checkpoint row names its source by name
  alone, and the runtime deletes the machine's others, once a start runs it or
  with the machine. That prune does delete for want of a claim, on one machine
  the store claims, so a store restored from a backup prunes that machine's
  checkpoints captured after the backup.
- **Leases are rows.** They are the `operations` table: what changes a resource
  owns it, what copies or reads it shares it, taken in the write that begins the
  operation, and a lease that refuses leaves that write undone. They survive a
  restart, as the steps they guard do. The build store is one lease too,
  `builds/`: a publish shares it, and the delete that unpublishes owns it, so its
  sweep of unreferenced objects never meets a publish that skipped one.
- **Setup scripts stay in memory, on both sides, but for a macOS guest's
  disk.** They may carry secrets, and are never stored or logged. A make that
  hasn't reached its host when the control plane ends can't be sent again, and
  is undone. The guest holds a script in a file its `#!` line can name while it
  runs, on Linux in `/dev/shm`, in memory, and on macOS in `/var/tmp`, on disk,
  as macOS has no memory-backed directory but one root mounts. The guest's shell
  removes it as it exits, and the host removes it again when the setup fails, is
  cut short or runs past its timeout, which may have killed that shell.
- **A failed create keeps its row.** A make that fails, whatever the step, goes
  `undoing`, deletes the VM, again at each recheck while that fails, and rests
  `undone` with its error for `failedRowsLast`. A delete clears it at once and a
  create of the name replaces it. A `Capacity` failure moves the create to the
  next host instead, for a template's the next that holds its build, once its VM is gone, while the control plane that took the create runs; after a restart it rests `undone`. Nothing ambiguous ever moves one.
- **A start starts the machine, also when it runs already, or resumes it when it
  is paused, and prepares it.** A pause leaves a stopped machine stopped. On a
  runtime whose `pause` trait `saves`, it saves a running machine and stops its
  VM, and stops one it can't save: a VM booted under another pin, or one Tart
  can't suspend. On one whose `pause` `stops`, as boat's, it stops the machine
  and saves nothing. A paused machine resumes
  only under the pin it booted under, for a start, and for a stop on a runtime
  whose `stop` trait `resumes` it, and a capture or fork copies only a VM booted under the
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
  imports `effect`, the SDK and effect-actions, but for `journal.ts`, which
  imports `effect` and its `http` alone, and the server's `composition/` takes
  only its journal; an app command imports only
  `effect` (with its `cli`, `encoding`, `http`, `process` and `socket`), the SDK
  and its siblings, so a client can't reach the host contract; the provider takes
  Node and `@effect/platform-node` only in `index.ts` and `tunnel.ts`, and the
  Amp orb provider only in `main.ts`, but for `node:crypto`'s hash; the SDK's
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
