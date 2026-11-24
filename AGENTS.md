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

You are the owner and long-term maintainer of this codebase, and its design is up to you.

## Packages

| Path                            | Holds                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| `packages/sdk/`                 | The client contract, its schemas and errors, the client                |
| `packages/host-contract/`       | The host contract, the traits, the journal: the server's and host's    |
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
meet: the server's take the host's `./testing`, the CLI's the server's, and
each provider's the server's and the host's, each as a dev dependency.

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
  the activity of a row's leaf picking each turn, and a machine's resting loop
  told its rechecks by the sweep, using a reading only when it began after the
  loop rested; `untilRest`, a build's wait;
  `apart`, which logs a loop or a build as its own, not as the request that
  began it.
- `machines.ts`, `checkpoints.ts`: the `Machines` and `Checkpoints` services,
  one per resource, each with its `make` and `layer`. `Machines` takes the
  requests, places a create and starts the recheck; `Checkpoints` captures,
  deletes, and keeps a build's copy. Each gives `driver` its reads and its writes.
- `templates.ts`: the `Templates` service, with its `make` and `layer`. A build
  makes a builder, placed as a create is, runs its setup, copies it and deletes it, then ends the build
  in its template's row, keeping the last 2 ready builds; a create from a
  template is `Machines`'s. A host with a build store publishes the copy before
  the build ends ready, and a recheck has every other host of the runtime fetch each
  ready build it lacks, as a checkpoint row of the build on that host.
- `steps.ts`: what a host is sent for an operation, built afresh from the rows at
  each delivery.
- `copies.ts`: a copy's spec, and why its source refuses it.
- `fleet.ts`: capacity, and what a recheck does beyond each loop: tells a
  restarted host its machines, again until it finds each, and stores the handle
  and endpoint it answers in each row; ends old failures; and `sweep`, which
  reads each host of the resting machines once, and their VMs in batches, for
  their loops, as a one-machine read lists a whole host on boat and
  agent-sandbox.
- `machine-view.ts`: what a client reads of a machine, and `waiting`, which a
  read tells.
- `operations.ts`: plain functions of a step on its host. `poll` sends it when
  the host hasn't had it and says when it was lost, and `collect` lets the host
  forget a report once it is stored.
- `hosts.ts`: the members, the one file that calls a host, and the log of a host
  that stops answering.
- `placement.ts`: which hosts can take a create, in order.
- `tailnet.ts`: the `Tailnet` port, which mints a join's key, provided only
  when the config names a tailnet; when a join is due and whether it carries a
  key; and `unserved`, which refuses a request for a tailnet the config lacks.
  `settings.ts`: what the server runs on.
- `store.ts`: the `Store` port, the rows, the operations and their leases, and
  `readUntil`, which reads again at each write of a row the store announces.

`platform/tailscale.ts` is the `Tailnet`, over Tailscale's API, minting each
key with the config's OAuth client. `platform/sqlite.ts` is the `Store`, and loads each chart's `leaves` at runtime to
validate `state`. `composition/`: `config.ts` reads the config file, `routes.ts`
serves the client contract, and `server.ts`, the package's entry, builds the
server over a server Layer it is given, through the host contract's `journal`.
Its `controlPlaneServer` is the Node server the control plane listens on, the
entry's and the tests' alike, and closes every connection it still holds as it
closes, which the stop does once each request it cut has answered. A domain file never
imports `platform/` or `composition/`.

**Host** (`apps/host/src`). Domain files sit flat in `src/`:

- `operations.ts`: the `Operations` service. It runs a step to its end, keeps its
  report until collected, fences by sequence, and tells a restart by `boot`, and
  serves the recheck's adopt from `recheck.ts`.
- `recheck.ts`: the recheck's adopt, which gives a restarted host its machines.
  It only reads the steps the host holds.
- `exec.ts`: how a command runs in a guest: the launcher and its mark, its
  output, and the end of a command cut short.
- `guest.ts`: setup, preparation, the tailnet, and the hook a stop or
  delete runs first, each a script `exec.ts` runs in the guest.
- `usage.ts`: the machines in use, and the RAM a runtime holds beside them, for the RAM budget and capacity.
- `settings.ts`: what a host runs on, and the port ranges it keeps.
- `reach.ts`: the `Reaches` service. It claims a make's port, answers the
  endpoint a client reaches it at, and has a `published` runtime bind it, after
  a probe finds it free. A `relayed` runtime's port it binds as it claims it, so
  no other program takes it while the VM boots, and holds it for the machine
  until a remove or a failed make lets it go; it relays it once the make has
  made the VM, and on a start or an adopt binds it again, or another port, none
  of the host's other machines', where another program took that one while the
  host was down, answering where.
- Ports: `Runtime` (`runtime.ts`), with its `traits`, its `guest` (`debian` or
  `macos`, which picks the base `guest.ts` prepares), its `reach` (`published` or `relayed`)
  its `prepares` (`always` where its images lack the login user, else
  `with-setup`), its `kernel` (`own`, or `shared` where its guests are
  containers on their node's kernel, which `guest.ts` reseeds no CRNG of), its
  `builds`, how it shares template builds with the other hosts
  of its runtime, which it keeps itself, as `unshared` where it shares none, and
  the facet `admission`, present or absent as a whole,
  `PortProbe` (`machine-ports.ts`), for a `published` runtime's port, at a make's
  claim and at each boot its admission admits (`checkPort`), `Box` (`box.ts`), what the box tells a host
  beside its config: its uid, whether a process has ended, and its ephemeral
  ports and `Relays` (`reach.ts`). Each `Runtime` method that acts on a machine or
  checkpoint already made takes a `Target`, the runtime's own opaque `Handle`
  beside the name and instance. `find` answers the handle for a machine's
  instance while the runtime keeps anything of it, also of one a delete removed
  only part way. `make`, the one create, restore or fork, answers the handle it
  made, and `capture` and `install` the handle of the checkpoint they make,
  which `checkpointHandle` derives from its identity on every runtime but one
  whose provider mints it. `Operations` resolves each target from its row's
  handle, else a machine's by `find` and a checkpoint's by `checkpointHandle`,
  with no search. `runtime.ts`
  states the two rules every adapter keeps, and `tests/runtime-contract.ts` is
  the suite each runtime passes over its own fake provider: the fake runtime's
  three presets, `smolvm`, `tart` and `fixed`, which is neither and has size
  classes, machines that stop on their own and the
  tombstones a rented runtime keeps, the four adapters over `tests/smolvm-model.ts`,
  `tests/scripted-mac.ts`, `tests/fake-smol-cloud.ts` and `tests/fake-boat.ts`,
  and agent-sandbox's over a real kind cluster, in `tests/kind/`.

Adapters live in `platform/`: `bind-probe.ts` (`PortProbe`), `box.ts` (`Box`,
which reads Linux's `ip_local_port_range`), `relay.ts`
(`Relays`, a TCP listener bound at the claim, which closes each connection until
it carries them through the machine's dial), `bucket/`, the `builds`
smolvm and Tart share through a bucket their runtime's settings name (`publish`,
`fetch` and `unpublish` of a checkpoint's files in `builds.ts`, objects by key
and a manifest per build, written last, and its `Store` over S3, path-style and
signed, in `s3.ts`), the runtimes `smolvm/` (the lock that keeps
a box to one smolvm host in `one-per-box.ts`), `tart/` (the Tart home's VM
directories in `home.ts`, a VM's lock read through macOS's Perl in `locks.ts`,
`launchctl print` read in `launchd.ts`, the `tart run` processes `ps` shows in
`runs.ts`), `smol-cloud/` (smol cloud's API in `api.ts`, the SSH tunnel in `tunnel.ts`) and
`boat/` (boat's REST API with its retries and headers in `api.ts`, the
adapter in `boat.ts`, whose make and start end once boat reads the sandbox
`hydrated`, the guest channel in `ssh.ts`, OpenSSH from the host pinned to the host key boat answers),
`agent-sandbox/` (the Kubernetes API's routes in `api.ts`, `pods/exec` and
`pods/portforward` over WebSocket in `channels.ts`, and the adapter in
`agent-sandbox.ts`: a Sandbox whose pod mounts a disk claim the adapter makes,
seeded from the base's image and copied for a fork or checkpoint by a pod of its own),
each with its `RuntimeTraits` in its `traits.ts`, and what they share:
`process.ts`, a child process's run, and `provider-http.ts`, what the smol
cloud, boat and agent-sandbox clients keep with their provider's API: the URL it is sent to
(`KeyedApiUrl`), how its refusals are read (`sender`), the key, read from its
file, which a host that can't read refuses to start, each request sent with it
as read afresh, which agent-sandbox's rotating token needs,
each request's bound by
what it asks, a gateway's 5xx and an unanswered request as a lost answer, a
refusal that asks to be waited out waited as `Retry-After` says, in seconds or
to a date, within 1 and 30 seconds and outside the request's bound, or the
backoff if longer, and sent again, six sends in all, a lost answer to a read, or to a change that does no
more sent twice, as boat's stop, delete, unsave and SSH key, asked again the
same way, any other change whose answer was lost read
until its resource rests and sent again only when that doesn't hold it, three
sends in all, and a list read one record at a time, which one of the host's
own that it can't read fails. `tests/fake-smol-cloud.ts` and `tests/fake-boat.ts` serve each
provider's API over loopback, for its adapter's tests and for the verify skill,
and `tests/live/smol-cloud.test.ts` and `tests/live/boat.test.ts`, run by
`vp run test:live` in `apps/host` with `SMOL_MACHINES_API_KEY` or
`BOAT_API_KEY`, and `TAILSCALE_AUTHKEY`, set and never in CI, check the real
accounts. A fake of a provider is written from what we believe of it, so a
test against it proves only that the code does what we believed. A signal read
from a provider's undocumented behaviour, such as boat's reboot mark, which its
list omits and its own record holds, is proven only by driving the real adapter
against the account and replaying what it read through the real chart: that is
how a boat machine's first reboot in place was found uncounted, which every fake
test had passed. `tests/kind/`, run by `vp run test:kind` in `apps/host` and in CI,
makes a kind cluster with the agent-sandbox controller through `cluster.sh`,
and runs the runtime contract and a guest's SSH there, with the faults a fake
provider would give injected at the adapter's HTTP client. Its
`teardown-error.md` holds the hunt for an uncaught `ClientDestroyedError` that
once ended a passing run with exit 1, and what to try if it returns. A domain
file never imports `platform/` or `composition/`.

`composition/` assembles the host: `config.ts` reads the config file,
`runtimes.ts` is the registry of runtimes, one entry each under the name a host
config's `runtime` gives it, with its settings and its Layer, `routes.ts` serves the host contract, and `host.ts` builds the
host over a runtime Layer and a server Layer it is given. Its `hostServer` is the Node server a host
listens on, the entry's and the tests' alike, and answers 503 at once, with no
body and Connection: close, to a request no route takes, as one that comes while
the host stops: one that finds no more request listeners than the server had
when it began listening, ours and the one `@effect/platform-node` keeps for
itself. Connection: close keeps a kept-alive client from meeting the final close
mid-request, which would read a mutation as maybe run. It closes every
connection it still holds as it closes, which the stop does once each request it
cut has answered.

**Host contract** (`packages/host-contract/src`). `api.ts`: `HostHttp`, the
`Step`s, `Operation`, `Report`, `HostInfo`. `traits.ts`, its `./traits` export:
a runtime's `RuntimeTraits`, which `HostInfo` carries and each adapter states,
and the pure rules each decision about a machine goes through, which the server
calls before it writes a row and the host before it runs a step, beside `newId`,
which mints an instance, and `isId`, which an adapter tells its own by; a client
sees only a runtime's name. `journal.ts`: `journal`, what the
control plane's log and a host's hold of the requests each serves, one
middleware for both, as both must log no secret a request carries: a request
that answers `Internal` or fails as no action declares logs at error, with its
method and path, one its caller or the stop cuts logs nothing, and every other
logs at debug.

**SDK** (`packages/sdk/src`). A library. Its root modules are the client
contract and the vocabulary everything else imports: `api.ts`, `resources.ts`,
`errors.ts`, `ids.ts` (with `RuntimeName`), `release.ts` (with `versionCheck`, for a server of either
contract), `sizes.ts` (with `Sizes`), `describe.ts`. The rest are `client.ts`, `setup.ts`
and `ssh.ts`. The `.` entry loads no Node; `./node` (`node.ts`) holds what
needs it.

**App** (`apps/cli/src`). One file or folder per command group
(`machines/`, `checkpoints.ts`, `templates.ts` and `template-file.ts`, the
YAML file a build reads, `hosts.ts`,
`ssh.ts` and `ssh-config.ts`, the SSH config it keeps) over the CLI's shared kit
(`command.ts`), the client config (`config.ts`) and flag units (`units.ts`).
`clankerbox.ts` is the command tree.

**Provider** (`packages/rivet-sandbox-agent/src`). `sandboxes.ts` (the
operations), `tunnel.ts` (the ssh tunnel), `relay.ts` (a sandbox's loopback
port, which the provider holds and relays to its tunnel), `fetch.ts` (the SDK's
fetch through it), `options.ts`, `agent.ts`, and
`provider.ts`, which runs them for the Sandbox Agent's Promise API.

**Amp orbs** (`packages/amp-orbs/src`). `dispatch.ts` (a job's spawn, pause or
delete, over the client), `job.ts` (the job, from the environment Amp gives),
`settings.ts` (the sizes of each orb type, the user, the snapshot expiry),
`names.ts` (a clankerbox name for an Amp ID), and `provider.ts`, the command.

## Weakenings the auth guards must refuse

`packages/sdk/tests/weakenings.ts` lists every weakening of `callerInConstantTime`, `isTailnetOrLoopback`, `requireToken` and the token store that a review has found, each with the test that must refuse it. CI's `weakenings` job runs it on a fresh checkout; it is kept out of `vp run ready` because it edits source files. To run it here, from the repository root with those files clean: `node packages/sdk/tests/weakenings.ts .`. It runs each named test file on the unchanged code first, then plants each weakening in turn, runs its test file, and puts the source back, on Ctrl-C too. A weakening counts as refused only when that run exits 1 with the test the weakening names failing on an assertion and no file failing to load; a pass, a runner that didn't start, or any other end exits 1. A test that a new weakening passes gets a case that refuses it, and the weakening joins the list with that test's name.

A trial of Stryker 10.1.1 over these guards (November 2026, PR #72) is the starting point for adopting a mutation tester, which isn't wired in. Over the SDK's auth code, 338 mutants in 130 s, it found 17 the address table let through. Two were fail-opens that four reviews and this list had missed: without `a === 100`, `isTailnetOrLoopback` took `10.64.0.1`; without its fd7a or 115c check, it took `2001:db8:a1e0::5`. The rest took malformed text, such as `0::1g` or `127.0.0.256`, as private. Rows now kill all 146 of `reach.ts`'s mutants. The server's `tokens.ts`, `token.ts` and listen check ran 150 mutants in 60 s; its survivors are all in the `token` command layer. Only about 6 of this list's weakenings are mutants Stryker makes by default, so it adds to the list rather than replacing it. It needed two workarounds: `tsconfigFile` naming no file, as TypeScript 7 has no JS API for Stryker to read a tsconfig with, and `inPlace: true`, as its sandbox copy breaks each package's relative `extends` of the base tsconfig. Running in place edits the checkout, so run it in a scratch worktree. About 30 SDK mutants, in `readToken` and the caller-name and prefix rules, have no coverage in the SDK's own suite, as their tests are in `apps/cli` and `apps/server`: the SDK's coverage understates what is tested, and moving those tests into the SDK is a candidate.

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
`./testing/boat` serve a provider's fake API and give its traits, its `./testing/rented` a host
over a rented runtime's adapter and that fake API, the server's `./testing` a control
plane over such hosts with real HTTP between them, and the SDK's
`./testing/stub-server` serves a stub control plane over an in-memory transport,
beside `./testing/clock`, `./testing/files` and `./testing/keys`, and
`./testing/equality`, which every app's and package's tests load as a setup
file, so two tagged errors compare equal only with the same message; the lint
fence's tests, which compare no tagged errors, load none. None of the
`./testing` exports is published. Every port a test of any package listens on
is in one table, the host's `tests/port-slot.ts`, whose global setup the host's,
the server's, the CLI's and both providers' tests each run to claim a slot for
the run.

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
  under), with the runtime's `handle` for its VM and the `endpoint` its host gave
  it, which a client's `ssh` reads. A delete is the `deleting` region, so the wire's `desired` of `deleted`
  comes from the leaf. What the VM is doing is read from its host, never stored,
  and so is `waiting`, which a read that finds the VM unknown shows. One loop per
  machine moves it toward what was asked a whole step at a time, and a later
  request cuts a step short, on boat and smol cloud only once the provider call
  in flight, which is billed and runs whole, has ended, ten minutes at most.
  A request takes the row out of rest in the write
  that records it, so a resting `phase` read after it has seen it. A client waits
  by reading, and works out `Superseded` from what it reads. A wait follows the
  machine it asked by `createdAt`, reads on through `waiting` as through an
  outage of the control plane, and ends `Unavailable`, the request saved, once
  two minutes pass with no read that tells it anything.
- **The wire says whether a 503 may have run.** A server site that refuses
  before it records or sends anything fails with effect-actions' built-in
  `Action.Unavailable`, which a generic client retries. One that sent the call
  on to a host and got nothing it could read fails `Unconfirmed`. Choose by what
  the code can promise at that point, never by what sounds safer: a site that
  can't tell takes `Unconfirmed`. The SDK's `Unavailable { readOnly }` is the
  client's reading of both and is declared by no action, as 0.34 of
  effect-actions refuses a second error of that tag.
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
  search fails fails. A runtime's stop masks
  interruption from the command that halts a running VM until it has, so a step
  cut short reports `cancelled` only once the VM is where that command takes it.
- **A delete answers for its instance for good.** Once a runtime's `delete`
  has answered for an instance, anything of that instance that appears later is
  deleted, and the control plane never makes that instance again. A `remove`
  calls it even when its search found nothing. smolvm and Tart keep that with
  nothing more; smol cloud, boat and agent-sandbox keep a tombstone of each instance in their
  `stateDir` (`platform/tombstones.ts`), sweep what lands of it in their own
  scope, keeping every checkpoint it holds, and refuse a make of it. A
  checkpoint's instance gets no tombstone: a `start` and a `remove` carry
  `keep`, and the runtime prunes the machine's checkpoints no row keeps.
  Nothing else deletes for want of a claim, so a wiped or second store deletes
  nothing of another store's. `docs/design/control-plane.md`, How an operation
  works, holds the rest: how long a tombstone lasts, and what it leaves.
- **Leases are rows.** They are the `operations` table: what changes a resource
  owns it, what copies or reads it shares it, taken in the write that begins the
  operation, and a lease that refuses leaves that write undone. They survive a
  restart, as the steps they guard do. The build store is one lease too,
  `builds/`: a publish shares it, and the delete that unpublishes owns it, so its
  sweep of unreferenced objects never meets a publish that skipped one.
- **A cut command is ended in its guest, the same on every runtime.** Each
  guest command carries a fresh mark, `CLANKERBOX_EXEC`, in the launcher's
  arguments and every process's environment. An exec whose scope closes before
  its command exits and its output closes, by its limit, its request ending or
  the host's stop, runs `endScript` through the runtime's own `exec` before the
  scope's close goes on, bounded by the SDK's `endTimeout`, which the control
  plane's and the client's waits on a timed exec add: TERM, then STOP and KILL,
  to each process whose own arguments or environment hold the mark, the exec's
  or another's, and what descends from one, each listing one `awk` pass, until
  the deadline the host gives it. A timed-out exec whose end isn't confirmed
  answers 124 with its output and `mayStillRun`. The launcher waits for its
  command, so a process holding the mark in its arguments stands above the
  command for its whole life, unless the command kills it. A stop or
  remove step first ends its
  machine's execs in flight so, before its hook and its runtime call:
  `Operations` admits an exec only while no step runs in its machine's scope,
  under the semaphore that accepts steps, so a capture of the machine and a
  fork from it, scoped to the checkpoint and the new machine, run beside one, and the step's cut answers it `WrongState`.
  README's `exec` bullet states the rest. Smolvm's agent
  ends a cut command too; a Tart guest, boat, smol cloud and agent-sandbox leave it running,
  measured on each, and the fake runtime's `cut` models each.
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
  next host instead, for a template's the next that holds its build, and for a build's builder the next that offers its base, once its VM is gone, while the control plane that took the create runs; after a restart it rests `undone`. So does a `Missing` that names the checkpoint a template's create restores, as each later host holds a copy of its own. Nothing ambiguous ever moves one.
- **A checkpoint a make finds gone fails.** A runtime answers a make from a
  checkpoint it no longer holds `Missing`, naming the checkpoint, with nothing
  made, and the control plane then fails that checkpoint's row, if it is ready
  on that host, with the same error: a build's copy so failed is cleared and
  fetched again where a build store has it, and a user's checkpoint reads
  `failed`, saying to delete it.
- **A start starts the machine, also when it runs already, and prepares it.** A
  capture or fork of a running machine copies only a VM booted
  under the host's pin, and a restore restores only under the pin its checkpoint
  was saved under, as smolvm copies a running machine through its RAM; the step
  carries the pin and the host compares. A resize is a step
  too, and the row keeps the sizes the runtime reads after it, also after one
  that failed part way. A checkpoint is usable only `ready`, and never changes
  but to fail when its host no longer holds it; a
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
  host package; the server's adapters are the `Store` and, over `effect/http` alone, the
  `Tailnet`, and a host's adapters
  can't import `node:sqlite`; a host adapter imports domain files, its own
  folder, `platform/`'s `process.ts` and the host contract's `./traits`, never
  its API, the boat, smol cloud and agent-sandbox clients
  `provider-http.ts` too, and smolvm and Tart `bucket/`; the host contract
  imports `effect`, the SDK and effect-actions, but for `journal.ts`, which
  imports `effect` and its `http` alone, and the server's `composition/` takes
  only its journal; an app command imports only
  `effect` (with its `cli`, `encoding`, `http`, `process` and `socket`), the SDK
  and its siblings, so a client can't reach the host contract; the provider takes
  Node and `@effect/platform-node` only in `index.ts`, `tunnel.ts`, `relay.ts`
  and `fetch.ts`, and the
  Amp orb provider only in `main.ts`, but for `node:crypto`'s hash, and those
  files take nothing more, so no provider's `src` reaches the server or the
  host its tests take; the SDK's
  `.` entry imports no Node and uses no `Buffer` or `process`; and
  `fence/no-manual-run` keeps hand-run Effect to the files above.
- **A removal removes its promises.** Taking out a behaviour includes the
  README, JSDoc and `docs/` lines that describe it: grep for the concept's
  name, such as "resume", before calling the removal done. Twice the code went
  cleanly and the prose kept promising what was gone, until a reviewer found it.

Removable packages are not a practice here: the provider package is optional,
but CI publishes it beside the SDK.

## Effect

Before writing or reviewing Effect code, read `node_modules/effect/AGENTS.md` in the package you are changing and the examples it links under `ai-docs/`. They ship with the installed `effect`, so they match the APIs the code compiles against. For exact signatures, read that package's installed source and types in `node_modules/effect` and `node_modules/@effect/*`. For what npm does not ship, such as `MIGRATION.md`, the guides under `packages/effect/` and the tests, read `.agents/repos/effect`, a shallow clone of `Effect-TS/effect` at the installed version's tag. If it is missing, or `git -C .agents/repos/effect tag --points-at HEAD --list 'effect@*'` names another version, delete it and clone again with `git clone --depth 1 --branch effect@<version> https://github.com/Effect-TS/effect .agents/repos/effect`. Do not write Effect APIs from memory or from examples for another version.

## Lint and format

`vp check` formats, lints and type-checks the repository; `vp check --fix` applies the fixes. It reads `oxlint.config.ts` and `oxfmt.config.ts` through `vite.config.ts`. Format is Ultracite's, and skips `AGENTS.md`, whose Vite+ block `vp config` rewrites on every install. `vp install` patches Oxlint with the Effect rules through the root `prepare` script.

Lint comes from `@clanker-stuff/oxlint-config` through `config()` in `oxlint.config.ts`, with this repository's overrides there. Fix the code rather than add a lint exception. There are no inline `oxlint-disable` comments.

## Dependencies

npm dependencies move by hand through the pnpm catalog in `pnpm-workspace.yaml`; Dependabot keeps only the SHA-pinned actions in `.github/workflows` current. Registry releases wait a day (`minimumReleaseAge`), except what `minimumReleaseAgeExclude` lists (the toolchain, Effect, xstate and our own scopes), so their bumps land the day they publish.

`xstate` is pinned to one alpha, on the server alone, and sits on the write path. For a bump, `.agents/skills/verify-machine-answers/model/Chart.tla` is the golden file of what the model holds of a row: a chart that decides differently there changes it. The table leaves out the join, the pin, a resize and the events the model doesn't send, as the skill's bounds say; `apps/server/tests/machine-chart.test.ts` holds those.
