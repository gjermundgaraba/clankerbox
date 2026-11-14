# Control plane design note

Status: implemented. Every `file:line` is at commit `adcacee`, the code before this work. Paths in `apps/server`, `apps/host` and `packages/host-contract` name the code as it is now.

The goal is that a client talks to one server, IDs carry no host, and adding a host adds capacity. This note says what was decided, how it works, which home each duty moved to, and what happens in each failure. Section 5 keeps the options that were weighed. `control-plane-decisions.tsv` is the trail of choices made while building it.

## Decisions made

1. **Actors run on the control plane.** This is the direction, and the redesign may change current rules where a careful design needs it.
2. **A host runs whole steps, as operations.** "Make `dev`" is the copy and the setup. A copy's make also prepares it, and a base create prepares in its `start`. The control plane decides what happens and when.
3. **Mutations are asynchronous on the server, and waiting is a client concern.** The server records what was asked and answers at once. One loop per resource does the work.
4. **A failed create keeps its row.** The VM goes, and the row stays, marked failed, until it expires or a new `create` replaces it.
5. **SSH by name is `ssh dev.cbx`, plus `clankerbox ssh dev`.** The SSH config needs one block, which never changes when a host is added.
6. **New SSH by name fails while the control plane is down.** Clients keep no cache of endpoints or host keys.
7. **Start fresh.** Existing machines, checkpoints and prebuilds are not imported, so there is no import tool and names can't clash.
8. **Cross-host forks and moves stay out of stage 2.** The design leaves room for them. Nothing in the client contract promises that a fork stays on its source's host. The two-host smolvm restore test runs before that work starts.

9. **Amp orbs are removed, and `exec` came back in 0.35 as a pass-through.** `clankerbox amp-orb` went with the redesign, and `execMachine` and `clankerbox exec` went with it, as `clankerbox ssh dev -- <command>` covers a command run by hand. 0.35 brings `execMachine` back for callers without SSH into the machine, such as an image with no sshd: the control plane finds the machine's host, waits for a step in flight on it to end, and passes the request on; the host waits for a step in its scope too, checks the machine runs, runs the command and answers its exit code and output. No row, operation or log line holds the command, so a secret may go on its stdin. A stop, pause or delete asked meanwhile ends it, as it takes the machine. `Runtime.exec` stays as it was, because setup and preparation run through it. Image-reference bases stay.
10. **One app per program.** See "Where the code lives".
11. **The remaining defaults stand.**
    - The control plane calls hosts (D2).
    - Adding a host is one line in the control plane's config and a restart (D3).
    - There are two contracts, one for clients and one for hosts. Clients can't reach hosts directly, `error.host` goes, and `hosts` and `capacity` stay as operator views on the client contract (D4).
    - SSH stays direct (D6).
    - The tailnet stays the only gate, and secrets stay where they are (D7).
    - One instance with SQLite, and backups are required (D8).
    - Everything upgrades together (D4).
    - Placement takes the first host that fits, then the next on `Capacity`, and a create from a template takes only a host that holds its build's copy (D9, decision 16).
    - A build's copy lives on the host that built it, under a name that means nothing to a client, and a client names the build, `web@2` (D9, decision 16).
    - Tailnet nodes are named with a fixed prefix, `cbx-dev`, so they can't clash with other nodes (D5).
12. **Labels are set when a resource is made, and lists filter by them.** (0.35) `create`, `fork`, `restore` and `captureCheckpoint` take `labels`, kept on the row as JSON, and a copy takes only the labels its own request gives. `listMachines` and `listCheckpoints` take a filter that every pair must match. Nothing changes a label later, so a label is a fact about how the resource was made, and no write can race another over it.
13. **A pause may capture first, and the capture's lease orders them.** (0.35) `pauseMachine` takes a `capture`. The control plane records the capture, waits for its operation to begin, then records the pause with `after` naming the checkpoint. The pause's step owns the machine and the capture's shares it, so the pause's begin finds the lease taken and waits for the capture to end, across a restart too, as leases are rows. A read that finds the capture recorded but not begun, as a restart between the two can leave it, holds the pause until the next recheck, so the checkpoint always holds the machine as it ran. (0.41) That order is for a runtime whose traits' `captureFrom` is `running`, as `pauseCapture` in `packages/sdk/src/traits.ts` decides of the host's traits as it answers at the request (decision 17). Where it is `stopped` and the `pause` `stops`, the control plane records the capture, then the pause, then drives the capture, and a capture's read holds it while its machine is out of rest, unless that is a pause waiting for this capture; a fiber drives it again once the machine rests, and after a restart the next recheck does. Where it is `stopped` and the `pause` `saves`, no state a pause leaves takes a capture, so the request is refused before anything is recorded. Either order is two `store.advance` writes, one of each row, as a write is one resource's row decided by its own chart; a write over both would be a store primitive this one request alone would use. The end of a request, a client's abort or the control plane's stop, can't split them: the control plane makes both writes once it has made the first, and where the capture comes first an end cuts only the wait for it to begin. A pause refused once the capture is recorded, as when the machine is deleted while its capture waits to begin, discards the capture in either order, so a refused request leaves no checkpoint. It discards the row of the instance it recorded, compared in the delete's write, so a capture of the same name another request recorded once this one's was deleted stays. A kill of the control plane can split them, and leaves a capture with no pause, which the next start drives: a host whose capture takes a stopped machine refuses it, and the checkpoint rests failed saying why, and one whose capture takes a running machine captures it, leaving the machine running. The client whose request the kill cut reads `Unavailable`, saying it may have run, and reads both rows to see what did. A retry of the same request replaces a failed capture of the name and pauses; where the capture is ready, the name is taken and the retry is `Conflict`, and a pause without a capture pauses.
14. **A checkpoint may expire.** (0.35) `captureCheckpoint` takes `expiresAt`. A sweep at each recheck deletes every ready checkpoint past it, through the same delete a client asks for. A build's copy never carries one: it goes once it falls out of the last 2 ready builds or its template is deleted, once the creates cloning it are done.

15. **Amp orbs come back as a package beside the control plane, not in it.** `packages/amp-orbs` is the dispatch program `amp orb provider` runs once per job. It is a client of the contract: `ensure` for a spawn, `pauseMachine` with `capture` for a pause that saves the project snapshot, `deleteMachine` for a delete, and `execMachine` to start `amp orb bootstrap` in the orb, as Amp's image ships no sshd. The control plane knows nothing of Amp: the orb's ID and type and the snapshot's ID ride on labels. The script that starts bootstrap goes to the shell on stdin, so the `pkill` ending the previous bootstrap finds no command line holding its own pattern.
16. **Templates replace profiles and prebuilds.** (after 0.35) A template lives on the control plane as its builds, in the `templates` and `builds` tables. Each build keeps the base, sizes and setup timeout it was built from, so a rebuild onto another base leaves an older build its own. A client reads them on each build, and a template has none of its own. `buildTemplate` takes the setup, which the control plane holds in memory for that build and never stores. The build makes an ephemeral builder, runs the setup, captures a copy of it as a checkpoint row with a `build` column, hidden from every client read, and deletes the builder. Its end is written to the template's row: the current build is the newest ready one, so it moves only once a build has succeeded, and the last 2 ready builds are kept. A create names `template` or `template@N` and clones that build on a host holding its copy, with no setup and no client-side check; a smaller size than the build's is `Unsizable`, and no ready build is `NotBuilt`. A restart ends a running build failed and deletes its builder. Placement by digest and `--fresh` go. A build number never names two builds: the next is one above the highest the template's name has had, past a delete too, so `web@1` after a delete and rebuild is `NotBuilt`, not a different setup. Profiles go entirely, since a template on the server covers what a client file did, and one place to build it from keeps every client's creates the same.

17. **A row's traits are a stamp of how it was made; what a host will do is read from the host.** (0.41) A machine's row is stamped with its host's traits at its create, a checkpoint's with its machine's at its capture, and a migration restamps both when a release changes a runtime's traits. The stamp is read where it states how the resource was made: a checkpoint's `kind`, a build copy's runtime for a fetch, a builder's `captureFrom` moments after its create, and `Machine.traits`, documented as at make. A decision about what a host will do reads its traits as it answers, since a host's runtime may give other sizes since, as boat does when an account's types change: placement, the sizes of a fork or restore (`p4`'s `m7`), the check of a copy recorded but not yet sent, which reads its host before it decides, and the order of a pause with a capture, which a host that can't be read answers `Unavailable`. The host itself acts only on its own traits.

Everything below this section follows from these.

### Where the code lives

| Path | Holds | Runs on |
| --- | --- | --- |
| `apps/cli` | Commands and the SSH config. Still publishes `clankerbox`. | Client machines |
| `apps/server` | Rows, the charts, the loops, placement, the store, the client routes | The control plane |
| `apps/host` | Runtimes, the operation runner, guest scripts, the host routes | Each host |
| `packages/sdk` | The client contract and the client. Published. | Imported by the CLI, the provider and the server |
| `packages/host-contract` | The host contract. Private. | Imported by the server and the host |
| `packages/rivet-sandbox-agent` | The provider | Imported by its users |
| `packages/amp-orbs` | The dispatch program for Amp's self-hosted orbs. Published, a bin. | `amp orb provider`, beside the control plane |

`packages/host` goes away, and each app's `package.json` is its boundary. The three apps publish as separate packages at one version. The CLI's end-to-end tests reach the other two through their `./testing` exports, which stay unpublished.

### What lives where

| Control plane | Host |
| --- | --- |
| Machine rows and checkpoint records, including `desired`, the chart's leaf in `state`, `prepared`, sizes, host key and pin | VMs, disks, saved RAM and checkpoint files |
| The charts, one loop per machine and checkpoint, the recheck | The runtimes, `smolvm` and `tart` |
| Operations and their leases, as rows | The operation runner, in memory |
| Placement, name uniqueness | Admission, from the machines the control plane lists; port choice; guest scripts: setup, preparation and the tailnet check |
| The client contract and the host contract's caller | The host contract, the tailnet secret |

A host keeps no database. Each operation carries the refs it needs, and a host's disk holds only what the runtime holds. Its ID stays in its config, because Tart's native names use it.

### How an operation works

An operation has an ID, a sequence number and a step, and is recorded with its leases in one transaction before it is sent (`store.advance`). The steps are `make`, `start`, `stop`, `pause`, `remove`, `resize`, `capture`, `deleteCheckpoint` and `join`. A create, a fork and a restore are all `make`, from a different source. Reads are plain calls, not operations.

- A host runs an operation to its end, whether or not its caller stays.
- A host keeps an operation's report until the control plane collects it. The control plane stores the report first (`store.advance`, then `apps/server/src/operations.ts` `collect`).
- The same ID sent twice returns the same operation. An operation carries the `boot` it was meant for, and another process refuses it. The sequence comes from one durable counter. A host keeps the latest for each scope in memory, refuses a lower or equal one with `Conflict`, and lets a higher one cut short what runs there.
- `boot` is random per host process. An ID the host doesn't hold is lost when `boot` differs. When `boot` matches the delivery hasn't come, so it is sent again if it can be built, and otherwise it is lost. A lost `make` goes `undoing`.
- A restarted host answers `adopt`: the control plane gives it the machines it holds, once per new `boot`, and the host takes each machine's handle from its row, or finds it by instance for a row that has none, reopens its relay, and answers the handle and the endpoint, which the control plane keeps in each row of that instance. The host names each machine whose search failed, the control plane fills every other row at once, and the boot stays unrecorded until an adopt finds them all, so only those wait for a later recheck.
- Each recheck also asks each host that answers, apart from its adopt, for the handle of each `ready` checkpoint row it holds with none, as a store migrated from 0.40 leaves every row (`findCheckpoints`). The host searches one at a time within a read's time and answers each it found, none where its runtime keeps nothing of its own for one, and the rest unresolved. The control plane stores each handle through the checkpoint chart's `found` event, which fills only a row of that instance with none, asks again at the next recheck for the unresolved, and no more while it runs for one its host keeps nothing for.
- A store retires an instance on a host in the write that ends its row's hold on it there (`store.advance`): the row goes, moves past `Capacity` to another host under a new instance, or rests `undone` or `failed`. The `retired` table keeps the instance past its row, as a delete clears an `undone` row at once and a create of the name replaces it, for a day of the control plane's clock from the first sweep that reached its host, named it and left nothing of it (`retiredLast`), and for as long as no sweep has, or the last sweep left it. Migration 11 retires the instance of each row that already rested `undone` or `failed` before the table existed. No row takes a retired instance again.
- After the adopts, each recheck sends each host that answers `sweepRetired` with the instances retired there, when there are any. A host whose runtime has the `owned` facet lists what carries its mark, and deletes each machine and marked checkpoint whose instance was sent and that no step it holds names. It answers each instance sent that it still lists, as a step names it, its delete failed, or its provider refused it with `Conflict` while something depends on it, and the store keeps that record untold, so a provider whose deletes fail for a day leaks nothing: each recheck tries again, and its host logs a warning once and an info line when a later sweep deletes it. A sweep waits out each delete it starts, which only its runtime bounds (on smol cloud and boat a machine's delete within 10 minutes, a checkpoint's within each provider request's own bound), and a sweep sent meanwhile waits for it, so an instance has one delete at a time and the answer says whether that delete took it. It deletes a machine alone and leaves every checkpoint the machine holds, since a row may still want one and the sweep carries no `keep`. A host without the facet answers at once. So a make that failed at its provider and landed later, or a resource whose undo found nothing, is deleted at a later recheck. The sweep compares no clocks, and never deletes for want of a claim: a set read at any time names only what no row wants, so a wiped store or a second control plane sweeps nothing of another store's.
- A `start` and a `remove` carry `keep`, every checkpoint handle the rows hold on its host. A runtime whose provider holds a checkpoint through its machine, unmarked, deletes each of the machine's checkpoints outside `keep`, once a start runs the machine or with the machine on a remove, as nothing but the machine's row tells whose it is. So a pause's own checkpoint, or one whose capture's answer was lost, goes at the machine's next start or its remove, and nothing else deletes one. `keep` is the host's whole set, not one machine's, because a checkpoint row names its source by machine name alone, and a build's copy outlives the delete of its builder. The write that ends a capture's operation stores its handle, so a `remove`, which owns the machine, never runs beside a capture whose handle is in no row. This prune does delete for want of a claim, for one machine the store claims. A store restored from a backup still claims the machines it had at the backup, so a start or a remove of one prunes that machine's checkpoints captured after the backup, which the restored rows don't hold. A wiped store and a second control plane claim none of another store's machines, and prune none of them.
- The sweep leaves these at the provider, each billed until someone deletes it:
  - A make that lands more than a day after the first sweep that reached its host named its instance and found nothing of it, or sooner if the control plane's clock is set forward meanwhile, as the window is that clock's alone.
  - Everything on a host whose runtime has no `owned` facet, or that left the config, which no sweep reaches. The records of a host that left the config stay, so a sweep still names them if it returns.
  - What a wiped store or a second control plane never retired, and what a restored store no longer names.
  - An unmarked checkpoint held through a swept machine that no row holds, as no start or remove of that machine runs again to prune it. Pruning it with the sweep would delete for want of a claim: nothing names it, and a row may still want a checkpoint the machine holds.
- To cut a step short, the control plane cancels the operation. Its lease stays held until the host reports the operation done. A stop's command still masks interruption.

Setup scripts travel in the `make` and stay in memory on both sides. A base source on the row says it is `scripted`, so a restart knows a script existed and can't be sent again. A copy holds what a setup did and has none to run.

`MachineAnswers.tla` checks this, with a control plane crash, a host restart, a partition and lost, repeated or late delivery in the interleavings.

### How a request works

The server records the desire and answers with the machine. The write also takes the row out of rest, so a resting `phase` read after that write has seen the request. The loop for that machine does the work, and it is the same path after a restart, because the row records the operation in flight.

The client waits. The SDK's methods keep their shape: `client.stopMachine` polls `getMachine` until `phase` rests, then answers success, or `Superseded` when `desired` has moved on, or the failure the row records. `--no-wait` and `--timeout` stop waiting without changing what happens on the server. The server never answers `Superseded`.

- A machine's `phase` names the step it is in, or rests at `settled`, `failed` or `lost`.
- `waiting` is read, never stored: a read that finds the VM `unknown` shows it, on any row that hasn't failed.
- A client rides out a control plane outage of about 2 minutes (`outageLimit`).
- A make that fails, in the copy or the setup, goes `undoing`, deletes the VM and rests `undone`. The row stays as `failed` with state `missing` and its error. Requests other than `get`, `delete` and `create` answer `NotFound`. It expires after `failedRowsLast`, one day.
- Fork, restore, capture and resize follow the same pattern. A template build answers a `Build`, which `getTemplate` reads with its template, and builds are rows (decision 16).
- Polling is the default. A watch can come later.

A chart decides each write. `machine-chart.ts` and `checkpoint-chart.ts` are xstate charts with no `invoke`, timers or actors. `applied` (`chart.ts`) rebuilds a snapshot from the row, takes one event inside the SQLite write and drops the snapshot, as a threaded one retains every step before it. Fibers do what takes time: a loop per resource (`driver.ts`) reads a host, sends a step and polls it, and a template build is an Effect sequence in `templates.ts`, with its setup in memory and its phase on its `builds` row. `MachineAnswers.tla` checks the same chart, through the table `Chart.tla` exports from it.

No resident actor holds a machine. A request has to land in the write that records it, and an actor's `send` returns before its mailbox runs. Its memory would be a second copy of the row, and leases span rows, so the database stays their authority. An actor with no `invoke` does no I/O, so it adds only a mailbox hop. One with an `invoke` grew about 15 KB per cycle in a spike on xstate 6.0.0-alpha.71, while a snapshot rebuilt from the row per write stayed flat at 43 to 48 µs. A template build stays an Effect sequence, not a chart, as its row records only that it runs and how it ended, and no request changes it between its steps.

Three things to know when changing it. xstate is an alpha pinned exactly, and `Chart.tla` is a golden file, so a bump that changes it changes a transition. A row stores its leaf's path and `platform/sqlite.ts` checks it against the chart, so renaming a leaf refuses older state until `applicationId` moves. The model leaves out resize, join, capacity moves and checkpoints, so those edges rest on the chart tests alone. `Drifting.cfg` adds a VM that stops on its own, a make that lands after its undo found nothing, and the sweep, as a read of whether the store retired the instance and a later delete while its host holds no step. The model has one store and one instance, so a second store, a replaced row and the sweep's checkpoints rest on `fleet.test.ts`.

## What the code said before any decision

These findings, at `adcacee`, shaped the work.

1. **A second host adds no capacity today, and moving placement doesn't fix that.** `offering` (`packages/sdk/src/client.ts:427`) takes the first host in list order that offers the base, and never reads `getCapacity`. A `Capacity` refusal from that host goes back to the caller, and nothing tries the next host. Capacity-aware placement is a new duty, not a moved one.
2. **Hosts can't fully disappear while copies stay local.** `forkMachine` lands on the source's host (`packages/sdk/src/api.ts:142`) and `restoreMachine` on the checkpoint's host (`api.ts:150`). A stopped machine on a full host fails `Capacity` at `start` (`packages/host/src/machines.ts:461`) even when another host has room. Names and routing can lose the host. Capacity can't, unless machines move.
3. **Dropping the prefix makes names global, and nothing enforces that today.** `Name` is unique per host (`packages/sdk/src/ids.ts:25`), through `name TEXT PRIMARY KEY` in each host's own SQLite (`packages/host/src/platform/sqlite.ts:38`). `linux_dev` and `mac_dev` can both exist now. A bare `dev` needs one owner for uniqueness across hosts. That is the whole reason a control plane might hold state.
4. **The prefix does more than route.** It is also the SSH config match (`apps/clankerbox/src/ssh-config.ts:12`, `Host <host>_*`), the tailnet node name (`machines.ts:476`), and the digest scope of prebuilds (`packages/sdk/src/prebuild.ts:89`). Each needs its own answer.

Facts that make the design easier:

- Host state already holds bare names. `Intent.name` and `CheckpointRecord.name` carry no host, and `idOn` adds the prefix at the edge (`packages/host/src/ids.ts:24`).
- Work on a host outlives its request. The actor lives in the host's scope (`machines.ts:579`), and `routes.test.ts:500` proves a create finishes after its client disconnects. Resize and the checkpoint operations fork into that scope too (`machines.ts:1057`, `packages/host/src/checkpoints.ts:67`).
- A host needs nobody else to keep going. Rechecks, startup cleanup and VM scopes are all local (`machines.ts:1071`, `packages/host/src/startup.ts:26`, `README.md:244`).

## 1 and 2. Every duty, before and after

Each duty has exactly one home. "Before" is the code at `adcacee`. "Deleted" is what went with the move. `server` is `apps/server/src`, `host` is `apps/host/src`, `client` is the SDK's `client.ts`.

### Duties that existed

| Duty | Before | After, one home | Deleted or changed |
| --- | --- | --- | --- |
| Pick a host for a create | `client.ts:427` `offering`, `client.ts:462` `create`, `client.ts:481` `place` | Server: `server/placement.ts` `placing` | `Client.place`, `Client.CreateOptions.host`, `offering` |
| Name a host by hand | `--host` (`apps/clankerbox/src/machines/spec.ts:41`), `Profile.host` (`packages/sdk/src/profile.ts:24`), `SpecRequest.host` (`profile.ts:102`) | Nowhere. Deleted. | The flag, the profile field and the `host` half of `SpecRequest` |
| Refuse a base the host lacks | `machines.ts:864` | Server: `server/placement.ts`, from what each host reports | The check left `machines.ts` |
| Admit a VM against RAM and VM limits | `machines.ts:277` `admitted`, `packages/host/src/usage.ts:67` | Host: `host/operations.ts` `admitted` over `host/usage.ts`, with the machines the step lists. A step runs at the host, so its refusal is the truth. | The store as the source of the list |
| Fan out reads | `client.ts:372` `gather`, used at `client.ts:493-496` | Server: `server/hosts.ts` | `Gathered`, `Unreachable`, `gather`, `warnUnreachable`, the `failed` check in the CLI's `command.ts` |
| Route by ID prefix | `client.ts:405` `onResource`, `client.ts:335` `routeTo`, `parseId` (`ids.ts:62`), `subjectOf` (`client.ts:289`) | Server: a row's `host`, read by `server/machines.ts` | `Routed`, `routeTo`, `subjectOf`, `IdParts`, `parseId`, `formatId` |
| Check an ID belongs to this host | `packages/host/src/ids.ts:11` `nameOn`, `CreateRequest` (`packages/sdk/src/resources.ts:229`) | Nowhere. Deleted with the prefix. | `nameOn`, `idOn`, `formatId` calls |
| Check a host calls itself what the list says | `client.ts:273` `checkHost` | Server: `server/hosts.ts`, at `read` | `checkHost` in the client |
| Keep the host list | `ClientConfig.hosts` (`apps/clankerbox/src/config.ts:10`), `HostEntry` (`client.ts:33`), provider `Options.hosts` (`packages/rivet-sandbox-agent/src/options.ts:18`) | Server: `hosts` in its config, `server/composition/config.ts` | All three. The client config and the provider take one URL. |
| Refuse another release | `refusal` and `versionCheck` (`packages/host/src/composition/routes.ts:64,84`), header sent at `client.ts:156` | SDK: `release.ts` `versionCheck`, one helper, served at each hop | The host's own copy |
| Tie prebuilds to a runtime | `nameOf` digests `host.runtimeVersion` (`prebuild.ts:25`) | Server: a build records its host's runtime pin and image (`server/templates.ts`), and a copy under another reads outdated (`server/placement.ts` `outdated`), since templates (decision 16) | `packages/sdk/src/prebuild.ts` |
| Find or restore a prebuild | `Prebuild.create` (`prebuild.ts:75`) | Server: `Machines.create` of a `template`, which clones a host's copy of the build (`server/machines.ts` `fromTemplate`), since templates (decision 16) | `Prebuild.create` |
| Build a prebuild | `checkpoints.ts:180`, a host builds and captures | Server: `server/templates.ts` `build`, over a builder machine, its checkpoint and its delete, since templates (decision 16) | `Prebuild.build` |
| Amp find, resume, restore, create, delete, snapshot | `apps/clankerbox/src/amp-orb.ts` | A package beside the control plane, `packages/amp-orbs`, over the client contract (decision 15) | All of `amp-orb.ts` and its tests |
| Provider cleanup after a failed create | `discard` (`packages/rivet-sandbox-agent/src/sandboxes.ts:76`) | Provider: unchanged | Nothing. `error.made` is the bare name. |
| Read a target and dial SSH | `sshTarget` (`packages/sdk/src/ssh.ts:18`), `ssh.ts:76,130,168` | Client: over `getMachine` | Nothing |
| Keep the SSH config | `apps/clankerbox/src/ssh-config.ts:10-22`, one block per host | CLI: `apps/cli/src/ssh-config.ts`, one `Host *.cbx` block | The per-host blocks |
| Name a host on an error | `located` in `client.ts:367`, `errors.ts:3` | Nowhere on a client error. The server's log names it. | `error.host` |
| Read setup scripts and keys | `specRequest` (`profile.ts:111`), `packages/sdk/src/setup.ts` | Client: the request carries them | Nothing |
| Allocate SSH ports | `pickPort` in `machines.ts:823` | Host: `host/operations.ts`, inside the step, which reports the port | Port uniqueness as a store rule |
| Mint tailnet keys | `machines.ts:471` `join`, `tailnet.oauthClient` in host config | Host: the `join` step, over `Tailnet` | Nothing. When a join is due is `server/tailnet.ts`. |
| Move a machine toward what was asked | `lifecycle.ts`, `reconcile.ts`, `machines.ts:1071` | Server: `server/machine-chart.ts`, `server/driver.ts`, `server/machines.ts` | The host's actors, store, recheck and `lifecycle.ts` |
| Hold leases | `packages/host/src/leases.ts`, in memory | Server: the `operations` table, `server/platform/sqlite.ts` `advance` | `leases.ts` |
| Keep rows | `packages/host/src/store.ts`, `platform/sqlite.ts` | Server: `server/store.ts`, `server/platform/sqlite.ts` | The host's database |
| Pick up what a restart left | `packages/host/src/startup.ts` | Server: each loop's first pass, `server/machines.ts` | `startup.ts` |
| Clean what only the runtime can see | `packages/host/src/startup.ts` | Host: `Runtime.startup` | `startup.ts` |

### Duties that had no home

| Duty | Why it appeared | Home |
| --- | --- | --- |
| Global name uniqueness | Finding 3. A create must be refused when any host holds the name. | Server: the primary key, `server/platform/sqlite.ts` |
| Capacity-aware placement | Finding 1. | Server: `server/machines.ts`. A `Capacity` failure moves the create to the next candidate once its VM is gone. The host's refusal stays the truth, and nothing ambiguous moves a create. The hosts left to try are in memory, with the setup, so a restart ends a move: the create rests failed with `Capacity`. |
| Host membership and draining | Adding or removing a host had no operation. | Server: `hosts` and `draining` in its config |
| Answering for an unreachable host | `Unavailable` was client-made (`errors.ts:277`). | Server: a synchronous refusal, 503, never on a row. A read that can't reach the VM shows `waiting`. |
| Waiting for a client's request to rest | A wait spans restarts now. | Client: `client.ts` `polled`, `answerOf`. A prebuild's wait for its builder is part of building it, above. |
| Running a step on a host | The loop and the VM are on different machines. | Host: `host/operations.ts` |
| Refusing a late or repeated operation | A delivery can arrive after the control plane moved on. | Host: by ID, sequence and `boot`, `host/operations.ts` |
| Telling a host which machines exist | A host keeps no list. | Server: `adoptMachines`, sent when a host's `boot` changes |
| Learning a checkpoint's handle a row lacks | A migrated row has none, and a search costs a runtime listing. | Server: `findCheckpoints` at each recheck, `fleet.ts` |

## 3. AGENTS.md invariants under this design

Kept means the rule holds with its meaning unchanged, even when it moves to the control plane. Changed means the rule stays in a new form. Broken means the rule goes, knowingly.

| Invariant | Mark | Reason |
| --- | --- | --- |
| The row is intent, numbered by the store in the write that records it | Kept | One row, on the control plane. |
| What the VM is doing is always read, never stored | Kept | The control plane reads through the host, and reads `unknown` when it can't. |
| Every machine is read at start, and every resting one at each recheck | Kept | The control plane does it through its host. |
| One actor per machine | Changed | One loop per machine, in one place. A move would keep the same loop. |
| A later request cuts a step short | Kept | By cancelling the operation. |
| A step cut short holds its lease until the VM is where the command takes it | Kept | The lease is released when the host reports the operation done, instead of when a local fiber ends. |
| A request answers from where the machine rests | Changed | The server answers once the store has the desire. The client's wait answers from where the machine rests, and `store.advance` leaves rest in the same write, so `AnswerTrue` holds with no generation in the wait. |
| Leases are in memory only, so a host's end drops them with the work | Changed | They are rows now. They survive a restart of the control plane, as the steps they guard do. |
| A host that starts deletes every machine left unmade | Changed | A restarted control plane reattaches first. It undoes a make only when its operation is lost or failed. Long setups survive a restart. |
| A machine is made by one step, from what only that request holds | Kept | The script is in memory on both sides and is never stored. A control plane restart can't resend it, so a `make` the host never received ends with the row marked failed. |
| A lost reply means the caller reads the resource | Kept | Clients read by name. Between the control plane and a host, it collects the result by ID. |
| Nothing retries | Changed | Clients still never retry a mutation. The control plane resends and collects by operation ID, which is safe because the ID and sequence number stop a second run. |
| A checkpoint exists only from a capture that succeeded until its delete begins | Kept | Records move to the control plane. |
| A paused machine resumes only under its pin, and a copy needs the host's pin | Kept | A host reports its pin. The row stores what a VM booted under. |
| A resize runs beside the actor and the row keeps the sizes read after it | Changed | A resize is a step of the loop, with its own `phase`, and the row keeps the sizes read after it. |
| A host works alone | Broken | During an outage nothing restarts a dead VM. Running VMs are not affected. |
| Clients talk to hosts directly, no controller | Broken | It is the point of the work. |
| Errors carry context, the client sets `host` | Broken | The client knows no host. It keeps `action`. |
| `Unavailable` is made only by the client library | Broken | A server now answers for a host it can't reach. |
| Operations are contracts, `actionCommands` fails on an uncovered action | Kept | It covers the client contract. `Action.implement` in the host's routes covers the host contract. |
| Dependency boundary, Layers only at an entry, lint fence, `no-manual-run` | Changed | Each app is a boundary. Most host domain files move to `apps/server`, and `apps/host` keeps the runtimes, guest scripts and the operation runner. |
| The tailnet is the only gate, and everyone upgrades together | Kept by default | See D4 and D7. |

## 4. What happens in each failure

`apps/server/tests/crash.test.ts` and the model cover the orders marked there. The fault run in the `verify-clankerbox` skill drives the first two by hand.

### Control plane down with machines running

VMs keep running. Running operations finish and hold their reports. Nothing restarts a VM that dies, and no new operation starts. Every API call fails, including new SSH by name, because `clankerbox ssh`, `ssh-proxy` and `ssh-known-hosts` each read the machine first. Open SSH sessions stay up, and machines on the tailnet stay reachable by node name.

### Control plane restarting mid-request

The client's wait rides it out for about 2 minutes, then answers `Unavailable` with `readOnly: false`. On start, the control plane loads its rows and each machine's loop picks up the operation its row records.

A create whose make reached its host keeps running there. The loop finds it by ID, collects the report, and the machine reaches `settled`. If the setup failed, the row goes `undoing` and then `failed`. A make that had not reached its host can't be sent again, because its script died with the process. It goes the same way.

### Host unreachable from the control plane

The machine reads `unknown` and `waiting`, which no row stores, and a lease stays held if an operation was running. Placement skips the host, and new creates go elsewhere. Lists and reads keep answering, with state `unknown`.

A request on such a machine is recorded and answered as usual. The last desire applies when the host returns, so a `stop` from yesterday can run today unless a later request replaces it.

A host that is gone for good has no clean exit yet. Its rows stay, reading `unknown`, and a delete of one waits for a host that will not come. A forget action is unbuilt.

### Partition mid-create

The control plane can't tell whether the `make` arrived. The row stays making and the name stays taken. When the link returns, it asks for the operation by ID. If it ran, the loop collects the report. If the host doesn't hold it and the script is still in memory, it sends the same ID again. If the script is gone, the row goes `undoing`.

A `make` delivered late can't act after that delete, because the delete carries a higher sequence number. A create never goes to another host after an ambiguous failure.

### A reply lost at either hop

Between client and control plane, the loop carries on and the client reads the resource. Between control plane and host, the control plane collects by ID, so the client sees nothing unless the host stays unreachable. A client that repeats `start`, `stop` or `pause` asks for a state again, `delete` answers `absent`, and `create` answers `Conflict`.

A duplicated operation runs once, by ID. A late stale operation is refused by sequence number.

### Hosts on a different release from the control plane

The two stay in lockstep. A host refuses another major.minor, and the control plane reports it as unreachable rather than passing `Invalid` to a client. Machines are not affected.

### Control plane store lost

This is the new worst case, as hosts no longer hold rows. Back up the SQLite file. A host never deletes a VM because the control plane doesn't list it, and acts only on an explicit operation. Orchard and E2B have the opposite rule and would destroy machines here. Native names hold the name and instance, so a partial rebuild from what each runtime lists looks possible. That is unproven.

### Two control planes at once

Both would run loops. The sequence number stops the older one's late operations only if the numbers come from one store. One instance stays the rule, with no standby.

## 5. Decisions

The options as they were weighed, kept as the record. "Decisions made" says what was chosen.

### D1. State ownership

Decided in the direction of none of these. Actors run on the control plane, see Decisions made. The options stay here as the record of what was weighed.

| Option | What it is | Consequences |
| --- | --- | --- |
| A. Control plane holds intent, hosts reconcile | The control plane's row has `desired` and `generation`. Hosts pull or receive them and keep a copy. | Requests survive a partition and apply later. Duplicates are harmless. Two rows, a new report path, and the store becomes a thing to back up. Create stays imperative anyway, because of secrets. `StoreAgrees` and `Result` in the model change. |
| B1. Hosts authoritative, stateless control plane | A list of hosts and an in-memory index rebuilt by listing. | Nothing to back up. Smallest server. One unreachable host blocks all creates, or duplicates become possible. Each restart reads every host. |
| B2. Hosts authoritative, durable name table | One table, resource and name to host. No `desired`, sizes or state. Rebuildable from hosts. | Creates and honest reads survive a host outage. Row is unchanged, so the existing model holds per host. A second write per create, drift to correct, and a fence for late creates. |
| C. Hosts authoritative, route inside the ID | The ID holds an opaque host slot, such as `dev-k3`. | No index and no store. Names unique per host only. A lost create reply leaves no ID. A host part still sits in the ID, which is what you wanted gone, and a machine can never move. |

### D2. Connection direction

| Option | Consequences |
| --- | --- |
| Control plane calls hosts | Hosts keep their HTTP routes and `ActionHttp.client` is reused. Needs a route to each host, which the tailnet gives. Hours-long creates hold an open request, as now. Timeouts stack: clients wait 10 s (`readTimeout` in `packages/sdk/src/api.ts`) and a host bounds its reads at 9 s (`stateReadWait` in `apps/host/src/runtime.ts`), leaving 1 s for a hop and a fan-out, so one of those numbers must move. |
| Hosts dial the control plane | No listening API port on hosts. The connection doubles as membership and health. Needs request multiplexing, cancellation for hours-long work over one stream, and reconnect rules. `effect-actions` serves actions over Effect RPC on a protocol the server provides, and its `live-rpc` example is a WebSocket, but there the client dials. A host that dials and then serves needs the RPC server on the dialing end. Nothing in the repository does this, and I haven't tried it. |

### D3. Membership

| Option | Consequences |
| --- | --- |
| Configured list in the control plane's config | Simple, explicit, reviewable. Adding a host is an edit and a reload. Matches today's client list. |
| Hosts register | A host config names the control plane, and adding a host is starting it. Needs a stored member list, ID clash handling, a credential or tag check against rogue hosts (D7), and a way to remove one. |
| Discovery by tailnet tag | The control plane lists peers holding a tag. No config and no registration call. Ties membership to Tailscale's API. |

Any of these also needs a way to drain a host, or placement can't avoid one that is leaving.

### D4. Contracts

| Option | Consequences |
| --- | --- |
| One contract at both hops | The host serves what the control plane serves, and the SDK client works against either. `actionCommands` is unchanged. Host-only needs (a sequence, a boot number) leak to clients, and client-only needs (`unread` lists) leak to hosts. Version check is one rule. |
| Two contracts sharing schemas | A client contract and a host contract. Each can change alone. Host actions can stay out of the CLI. `actionCommands` covers the client contract, and the host contract needs its own coverage check. Allows skew between the hops if you want it. |

Sub-decisions:

- **Can clients still reach hosts directly?** No means the tailnet policy opens host API ports only to the control plane. Break-glass means an operator can point the CLI at a host, which requires one contract or a host-contract CLI, and writes made that way bypass any name table.
- **Release skew.** Lockstep keeps one rule and gives an API outage during upgrades. Tolerating N-1 on the host contract allows rolling upgrades and adds a compatibility promise you don't have today.
- **`error.host`.** Delete it, or let the control plane set it for operators. Keeping it on client errors keeps a host in the client's view.
- **`hosts` and `capacity` commands.** Keep them as operator views on the client contract, or move them to an operator contract.

### D5. IDs and moves

| Option | Consequences |
| --- | --- |
| Keep `<host>_<name>` | No uniqueness problem and no table. Fails your stated goal. |
| Bare global names | `dev` is the ID. Needs an owner for uniqueness (D1). Existing `linux_dev` and `mac_dev` collide. A caller knows the ID before the reply, so the lost-reply rule stays cheap. |
| Opaque ID plus a name label | The server mints `m-x7f2`, and `dev` is a label. No rename problem. A lost reply leaves the caller with only a label, so lookup by label has to work anyway. Worse to type. |

Moves, as a separate choice:

| Option | Consequences |
| --- | --- |
| Never | Simplest. A full host keeps its stopped machines stuck (finding 2). |
| Cold, stopped machines only | A disk copy to another host. A new runtime operation on both kinds, an ownership handoff, a new SSH port, and one actor per machine held by stopping the old one first. |
| Live | `ram` state restores only under the same pin (`PinMismatch`, `packages/host/src/refs.ts:43`, `checkpointKinds` in `packages/host/src/settings.ts:16`), so both hosts must run one smolvm build. Mac has only disk checkpoints. Moving is capture then restore, of the same kind. |

SSH by bare name also needs a choice. `Host <host>_*` has nothing to match once the prefix goes.

- A fixed suffix, such as `ssh dev.cbx`, gives one `Host *.cbx` block that `ssh-proxy` strips.
- A fixed prefix is the same with a marker in front.
- `Match exec` asks the control plane on every `ssh` to any destination, which slows all of them and fails when it is down.
- Dropping the plain-OpenSSH path leaves only `clankerbox ssh dev`.

The tailnet node name is `dev` under bare names, which can clash with other nodes on the tailnet. A fixed prefix avoids that.

### D6. Data path

| Option | Consequences |
| --- | --- |
| SSH stays direct | Bytes never touch the control plane, and open sessions survive it. `Machine.ssh.host` still shows a host address, as an opaque endpoint. The tailnet policy must open machine ports on every host, so a tag rule keeps new hosts automatic. |
| SSH relayed through the control plane | Clients need no route to hosts. The control plane carries every byte and becomes the only route, so its outage ends sessions. |
| SSH by tailnet node only | No endpoint at all. Works only for guests with `tailscaled` (`README.md:188`). |

### D7. Trust

| Option | Consequences |
| --- | --- |
| Tailnet stays the only gate | No keys and no TLS. The policy changes to clients to control plane, and control plane to host APIs. Machines joined to the tailnet are nodes, so the policy must keep their tags away from the control plane port, which can now create, change and delete every machine. |
| Add caller identity from the tailnet | The control plane asks Tailscale who is calling, and can scope by user or tag. New dependency on a local Tailscale socket. |
| Add a token between the control plane and hosts | Guards registration and host APIs. A secret to issue and rotate, and it ends "no keys". |

Where secrets live, each as its own choice:

- **`tailnet.oauthClient`.** Stay on each host, as now (`README.md:68`), or move to the control plane, which mints keys. Moving gives one secret to rotate, and joins stop working while it is down.
- **`authorizedKeys`.** Moved to the control plane's config after 0.35: one key set for everyone and no per-client keys. The host installs them after a setup and onto each clone of a build's copy, and a template's builder takes none, so a key change rebuilds nothing.
- **Setup scripts.** Pass through in memory only, or get stored. Storing them breaks the rule that only the request holds them, and they may carry secrets.

### D8. Deployment

| Choice | Options and consequences |
| --- | --- |
| Where it runs | A dedicated small node has its own failure domain. In a host's process or machine costs nothing extra, and that host's restart takes the API down with it. On a linux host it must not listen where guests reach it (`README.md:248`). |
| Store | SQLite, with the existing `platform/sqlite.ts` and migrations as the pattern, is one file that must be backed up. A shared database allows several instances and adds a service to run. |
| Instances | One is simple, and an outage is a restart. MagicDNS lets you move it by name. A standby needs a store it can reach and a rule for who is active, or two writers appear (section 4). Several need a shared store and name leases. |

### D9. Scope

| Item | Options and consequences |
| --- | --- |
| Placement | First-fit in list order is today's behavior and adds no capacity. First-fit with next-on-`Capacity` adds capacity with no policy. Most free RAM reads `getCapacity` for every create and spreads load. Prebuild affinity competes with spreading. |
| Prebuild location | Today one host builds and only creates placed there restore it. Build on every eligible host gives hits everywhere and partial failures to report. Build on one with affinity concentrates load. |
| Prebuild code | Moves to the control plane, because `nameOf` needs a host's `runtimeVersion`. `createMachine` then takes a spec and does the find-or-restore. A client keeps `--fresh` as a flag on that call. |
| Prebuild names | One digest on two hosts collides under global names. Either the digest includes the host, or a prebuild becomes one name with one copy per host, a new concept. |
| Profiles | Stay client files, or move to the control plane for sharing. Moving means recipes and their `agent.env` secrets are stored. |

### D10. Packaging

Decided as neither of these. Each program is its own app, see "Where the code lives".

| Option | Consequences |
| --- | --- |
| New package, such as `packages/control-plane`, with a role command in the app | Same shape as `packages/host`, private and bundled, with its own domain files, `platform/`, `composition/`, fence rules and `./testing`. The app's `control-plane.ts` chooses Layers as `host.ts` does. |
| Role inside `apps/clankerbox` | No new package. App commands may import only `effect`, the SDK and siblings, so the fence has to widen for a server with a store and HTTP routes. |

### D11. Existing state

Decided: start fresh.

| Option | Consequences |
| --- | --- |
| Adopt in place | Host rows hold bare names already, so a host's state carries over with no migration of machines. The control plane reads each host's list at first start. The work is clashes: two hosts holding `dev` need a rename action, or the operator deletes one. Tailnet nodes keep their old names until they log in again. |
| Start fresh | Delete machines and checkpoints, then start hosts on new state dirs. Nothing to reconcile. Loses running work, paused orbs and prebuilds. |

### D12. What must keep working while the control plane is down

Each level includes the ones above it. The cost column assumes SSH stays direct.

| Level | What works | Cost |
| --- | --- | --- |
| Machines run | VMs, rechecks, open sessions, tailnet nodes | Nothing, this is already true |
| New SSH | New connections to running machines | The client caches each endpoint and host key it reads, or SSH goes by tailnet node. A cache is client state again, though small. |
| Reads | `get` and `machines` | Direct client reach to hosts, or a read replica |
| All mutations | Everything, on one host at a time | Break-glass direct reach, and a way to merge those writes back |

### How the decisions interlock

- **D2 and D3.** Hosts that dial are the member list, so registration comes with that choice. A one-time registration call also works with the control plane calling hosts.
- **D3 and D7.** Registration needs an answer to who may register.
- **D6 and D12.** Relayed SSH removes the "open sessions survive" row. Direct SSH leaves `Machine.ssh.host` visible.
- **D5 and D9.** Global names force a choice on prebuild and snapshot names.
- **D4 and D12.** Direct reach for reads or mutations conflicts with closing host APIs. With no row on a host, a direct mutation has nowhere to be recorded.
- **D8 and the store.** More than one instance needs a shared store.
