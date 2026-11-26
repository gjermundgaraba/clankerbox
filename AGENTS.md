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

# clankerbox: boundaries and house style

You are the owner and long-term maintainer of this codebase, and its design is up to you.

## Boundaries

One app per program: `clankerbox`, `clankerbox-server` and `clankerbox-host`
publish from `apps/`, at the SDK's version. The CLI imports the SDK; the server
and the host import the SDK and the host contract (`packages/host-contract`),
and the server never imports the host, which it reaches only over the network;
each provider (`packages/rivet-sandbox-agent`, `packages/amp-orbs`) imports the
SDK; the SDK imports none of them. A client never reaches a host's API: it knows
one URL, and hosts only as the operator's views `hosts` and `capacity`. Each
package's `package.json` dependencies hold that boundary, since pnpm resolves
nothing else. Its dev dependencies resolve in `src` as well, so the lint fence
keeps an app's `src` off the apps its tests take. Tests are the one place apps
meet: the server's take the host's `./testing`, the CLI's the server's, and
each provider's the server's and the host's, each as a dev dependency. None of
the `./testing` exports is published.

Code is grouped by domain, not by mechanism. In the server and the host, domain
files sit flat in `src/`, adapters in `platform/` and the entry's assembly in
`composition/`; a domain file never imports `platform/` or `composition/`.
Tests mirror `src/` under each package's `tests/`; suites over a served control
plane (`apps/server/tests`) or the whole CLI span domains on purpose.

Layers are chosen only at an entry: each app's `main.ts`, the SDK's `node.ts`,
the Sandbox Agent provider's `index.ts` and the Amp orb provider's `main.ts`.
Tests pass their own.

## Tests

- Every port a test of any package listens on is in one table, the host's
  `tests/port-slot.ts`, whose global setup the host's, the server's, the CLI's
  and both providers' tests each run to claim a slot for the run.
- Each runtime passes `apps/host/tests/runtime-contract.ts` over its own fake
  provider. agent-sandbox's runs over a real kind cluster instead:
  `vp run test:kind` in `apps/host`, also run in CI, makes the cluster with the
  agent-sandbox controller through `tests/kind/cluster.sh`.
- `vp run test:live` in `apps/host`, with `SMOL_MACHINES_API_KEY` or
  `BOAT_API_KEY`, and `TAILSCALE_AUTHKEY`, set, checks the real accounts. It
  never runs in CI.
- A fake of a provider is written from what we believe of it, so a test against
  it proves only that the code does what we believed. A signal read from a
  provider's undocumented behaviour, such as boat's reboot mark, which its list
  omits and its own record holds, is proven only by driving the real adapter
  against the account and replaying what it read through the real chart.

## Weakenings the auth guards must refuse

`packages/sdk/tests/weakenings.ts` lists every weakening of `callerInConstantTime`, `isTailnetOrLoopback`, `requireToken` and the token store that a review has found, each with the test that must refuse it. CI's `weakenings` job runs it; it is kept out of `vp run ready` because it runs each test file once per weakening. To run it here, from the repository root after `vp install`: `node packages/sdk/tests/weakenings.ts .`. It copies the checkout's working tree, tracked and untracked files alike, to a temporary directory and installs it from the store, so it never writes to the checkout and a commit made beside it can't stage a weakening. In that copy it runs each named test file on the unchanged code first, then plants each weakening in turn and runs its test file. A weakening counts as refused only when that run exits 1 with the test the weakening names failing on an assertion and no file failing to load; a pass, a runner that didn't start, or any other end exits 1. A test that a new weakening passes gets a case that refuses it, and the weakening joins the list with that test's name.

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
  pass `excludeTestServices: true`. Effect is run by hand only where
  `fence/no-manual-run` allows it.
- **Property and model tests** state what is right without calling the code
  under test. A chart, small enough, is checked with every event from every leaf.
- **A chart is pure and runs inside the write.** `applied` runs `transition`
  once inside the transaction of `store.advance`, so no snapshot outlives the
  write. A chart has no `invoke`, no timers and no actors, and what it needs
  from the world rides on its event. Fibers do what takes time, and tell the
  chart what they found as an event. A template's build is no chart: it is an
  Effect sequence in `templates.ts`. A leaf's name is stored, so renaming one is
  a migration.
- **A machine's row is intent and progress; the VM is always read.** The row
  keeps what was asked (`desired`), its chart's leaf (`state`), and the progress
  no runtime can tell again (`prepared`, the host key, the runtime pin its VM
  booted under, the `handle` and the `endpoint`). What the VM is doing is read
  from its host, never stored. A request takes the row out of rest in the write
  that records it, and a client waits by reading.
- **The wire says whether a 503 may have run.** A server site that refuses
  before it records or sends anything fails with effect-actions' built-in
  `Action.Unavailable`, which a generic client retries. One that sent the call
  on to a host and got nothing it could read fails `Unconfirmed`. Choose by what
  the code can promise at that point, never by what sounds safer: a site that
  can't tell takes `Unconfirmed`. The SDK's `Unavailable { readOnly }` is the
  client's reading of both and is declared by no action, as
  effect-actions refuses a second error of that tag.
- **A step is a whole operation on a host.** The write that enters a leaf with a
  `step` records an operation in the store with its leases, and the loop then
  sends it. The host runs it to its end whether or not the caller stays, and
  keeps its report until it is stored, so a control plane that restarts finds it
  by ID and carries on. A step acts on its row's handle, or on what the runtime
  finds of the row's instance, never on a VM by its name alone.
- **A delete answers for its instance for good.** Once a runtime's `delete`
  has answered for an instance, anything of that instance that appears later is
  deleted, and the control plane never makes that instance again. The rented
  runtimes keep that with a tombstone of each instance in their `stateDir`
  (`platform/tombstones.ts`). Nothing else deletes for want of a claim, so a
  wiped or second store deletes nothing of another store's. The README's
  Leftovers at a provider says what that leaves.
- **Leases are rows.** They are the `operations` table, taken in the write that
  begins the operation, and a lease that refuses leaves that write undone. They
  survive a restart, as the steps they guard do.
- **A cut command is ended in its guest, the same on every runtime.** Each
  guest command carries a fresh mark, `CLANKERBOX_EXEC`, and an exec whose scope
  closes before its command exits runs `endScript` through the runtime's own
  `exec` before the close goes on. A stop or remove step first ends its
  machine's execs in flight. Smolvm's agent ends a cut command too; a Tart
  guest, boat, smol cloud and agent-sandbox leave it running, measured on each,
  and the fake runtime's `cut` models each.
- **Setup scripts stay in memory, on both sides, but for a macOS guest's
  disk.** They may carry secrets, and are never stored or logged. A make that
  hasn't reached its host when the control plane ends can't be sent again, and
  is undone.
- **Nothing ambiguous moves a create.** Only a `Capacity` failure, or a
  `Missing` naming the checkpoint a template's create restores, moves a create
  to the next host.
- **Shell comments.** Lint doesn't read the recipes' shell scripts; a comment
  there states only a platform or upstream fact the script can't show.
- **A lint fence** (`tools/lint-fence`, each rule with its tests; settings in
  `oxlint.config.ts`) holds each package and folder to the imports its boundary
  allows, keeps `Date`, `Math.random` and `crypto` out of the charts
  (`fence/no-impure`), lets `apps/server/src/hosts.ts` alone call a host, and
  keeps hand-run Effect to its entries (`fence/no-manual-run`). Read
  `oxlint.config.ts` for what each folder may import.
- **A removal removes its promises.** Taking out a behaviour includes the
  README, JSDoc and skill lines that describe it: grep for the concept's
  name, such as "resume", before calling the removal done.
  CI's `.github/stale-doc-names.ts` fails a change that removes a name from the
  code while a Markdown line it left alone still cites it in backticks; a fact
  told only in words, with no name, is still yours to find.

Removable packages are not a practice here: the provider package is optional,
but CI publishes it beside the SDK.

## Effect

Before writing or reviewing Effect code, read `node_modules/effect/AGENTS.md` in the package you are changing and the examples it links under `ai-docs/`. They ship with the installed `effect`, so they match the APIs the code compiles against. For exact signatures, read that package's installed source and types in `node_modules/effect` and `node_modules/@effect/*`. For what npm does not ship, such as `MIGRATION.md`, the guides under `packages/effect/` and the tests, read `.agents/repos/effect`, a shallow clone of `Effect-TS/effect` at the installed version's tag. If it is missing, or `git -C .agents/repos/effect tag --points-at HEAD --list 'effect@*'` names another version, delete it and clone again with `git clone --depth 1 --branch effect@<version> https://github.com/Effect-TS/effect .agents/repos/effect`. Do not write Effect APIs from memory or from examples for another version.

## Lint and format

`vp check` formats, lints and type-checks the repository; `vp check --fix` applies the fixes. It reads `oxlint.config.ts` and `oxfmt.config.ts` through `vite.config.ts`. Format is Ultracite's, and skips `AGENTS.md`, whose Vite+ block `vp config` rewrites on every install. `vp install` patches Oxlint with the Effect rules through the root `prepare` script.

Lint comes from `@clanker-stuff/oxlint-config` through `config()` in `oxlint.config.ts`, with this repository's overrides there. Fix the code rather than add a lint exception. There are no inline `oxlint-disable` comments, and `clanker/no-prose-comments` refuses prose comments.

## Dependencies

npm dependencies move by hand through the pnpm catalog in `pnpm-workspace.yaml`; Dependabot keeps only the SHA-pinned actions in `.github/workflows` current. Registry releases wait a day (`minimumReleaseAge`), except what `minimumReleaseAgeExclude` lists (the toolchain, Effect, xstate and our own scopes), so their bumps land the day they publish.

`xstate` is pinned to one alpha, on the server alone, and sits on the write path. For a bump, `.agents/skills/verify-machine-answers/model/Chart.tla` is the golden file of what the model holds of a row: a chart that decides differently there changes it. The table leaves out the join, the pin, a resize and the events the model doesn't send, as the skill's bounds say; `apps/server/tests/machine-chart.test.ts` holds those.
