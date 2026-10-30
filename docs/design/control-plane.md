# Control plane design note

Status: stage 1 finished, decisions made. No code changed. Every `file:line` is at commit `adcacee`.

The goal is that a client talks to one server, IDs carry no host, and adding a host adds capacity. This note says what the client does today, where each duty could live, what each choice costs, and what breaks in each failure. "Decisions made" says what was chosen. Section 5 keeps the options that were weighed.

## Decisions made

1. **Actors run on the control plane.** This is the direction, and the redesign may change current rules where a careful design needs it.
2. **A host runs whole steps, as operations.** "Make `dev`" includes the copy, the setup and the preparation. The control plane decides what happens and when.
3. **Mutations are asynchronous on the server, and waiting is a client concern.** The server records what was asked and answers at once. A reconcile loop does the work.
4. **A failed create keeps its row.** The VM goes, and the row stays, marked failed, until it expires or a new `create` replaces it.
5. **SSH by name is `ssh dev.cbx`, plus `clankerbox ssh dev`.** The SSH config needs one block, which never changes when a host is added.
6. **New SSH by name fails while the control plane is down.** Clients keep no cache of endpoints or host keys.
7. **Start fresh.** Existing machines, checkpoints and prebuilds are not imported, so there is no import tool and names can't clash.
8. **Cross-host forks and moves stay out of stage 2.** The design leaves room for them. Nothing in the client contract promises that a fork stays on its source's host. The two-host smolvm restore test runs before that work starts.

9. **Amp orbs and `exec` are removed.** Those were the action's only two callers. `clankerbox amp-orb`, `execMachine` and `clankerbox exec` go, and `clankerbox ssh dev -- <command>` covers a command run by hand. `Runtime.exec` stays, because setup and preparation run through it. Image-reference bases stay, and a machine made from one still needs sshd from its setup to be reachable.
10. **One app per program.** See "Where the code lives".
11. **The remaining defaults stand.**
    - The control plane calls hosts (D2).
    - Adding a host is one line in the control plane's config and a reload (D3).
    - There are two contracts, one for clients and one for hosts. Clients can't reach hosts directly, `error.host` goes, and `hosts` and `capacity` stay as operator views on the client contract (D4).
    - SSH stays direct (D6).
    - The tailnet stays the only gate, and secrets stay where they are (D7).
    - One instance with SQLite, and backups are required (D8).
    - Everything upgrades together (D4).
    - Placement takes the first host that fits, then the next on `Capacity`, and tries a host holding the matching prebuild first (D9).
    - A prebuild's digest includes its host, so each host keeps its own copy under a name that means nothing to a client (D9).
    - Tailnet nodes are named with a fixed prefix, `cbx-dev`, so they can't clash with other nodes (D5).

Everything below this section follows from these.

### Where the code lives

| Path | Holds | Runs on |
| --- | --- | --- |
| `apps/cli` | Commands, profiles and the SSH config. Still publishes `clankerbox`. | Client machines |
| `apps/server` | Rows, the reconcile loop, placement, the store, the client routes | The control plane |
| `apps/host` | Runtimes, the operation runner, guest scripts, the host routes | Each host |
| `packages/sdk` | The client contract and the client. Published. | Imported by the CLI, the provider and the server |
| `packages/host-contract` | The host contract. Private. | Imported by the server and the host |
| `packages/rivet-sandbox-agent` | The provider | Imported by its users |

`packages/host` goes away, and each app's `package.json` is its boundary. The three apps publish as separate packages at one version. The CLI's end-to-end tests reach the other two through their `./testing` exports, which stay unpublished.

### What lives where

| Control plane | Host |
| --- | --- |
| Machine rows and checkpoint records, including `desired`, `generation`, sizes, `made`, host key and pin | VMs, disks, saved RAM and checkpoint files |
| Actors, `reconcile`, the recheck loop | The runtimes, `smolvm` and `tart` |
| Leases | The operation runner, in memory |
| Placement, name uniqueness, admission for each host | Guest scripts: setup, preparation and the tailnet check |
| The client contract and the host contract's caller | The host contract, the tailnet secret |

A host keeps no database. Each operation carries the refs it needs, and a host's disk holds only what the runtime holds. Its ID stays in its config, because Tart's native names use it (`packages/host/src/platform/tart/tart.ts:105`).

### How an operation works

An operation has an ID, a machine, a kind, a per-machine sequence number and its arguments. The kinds are `make`, `start`, `stop`, `pause`, `remove`, `resize`, `capture`, `deleteCheckpoint` and `join`. Reads are plain calls, not operations.

- A host runs one operation per machine at a time, and runs it to the end if the connection drops.
- A host keeps an operation's result until the control plane collects it, or until the next operation on that machine.
- The same ID sent twice returns the same operation. A sequence number lower than the highest the host has seen for that machine is refused. The host keeps those numbers in memory, because a host restart ends every delivery in flight anyway.
- The control plane can ask a host for every operation it holds, running or finished.
- To cut a step short, the control plane cancels the operation. Its lease stays held until the host reports the operation done. A stop's command still masks interruption, as it does today.
- A host restart ends its operations. The control plane finds the ID unknown, reads the VM and lets the actor decide.

Setup scripts travel in the `make` operation and stay in memory on both sides.

None of this is model-checked yet.

### How a request works

The server records the desire, numbers it with `generation`, and answers with the machine. It doesn't hold the request open. The loop for that machine does the work, and it is the same path after a restart, because the row records the operation in flight.

The client waits. The SDK's methods keep their shape: `client.stopMachine` polls `getMachine` until the machine rests at that generation or later, then answers success, or `Superseded` when the row has moved on to something else, or the failure the row records. `--no-wait` and `--timeout` stop waiting without changing what happens on the server.

- `Machine` gains `generation`, and a resting machine reports the generation it rests at. `settled` at generation `g` means the loop read the VM at `g` or later, with no operation in flight.
- A step's failure moves into the row with its generation, because a wait can span a restart.
- A create whose copy or setup fails deletes its VM, but its row stays, marked failed, so the waiting client can read why. A `create` of that name replaces it, and it expires after a while.
- Fork, restore, capture, prebuild and resize follow the same pattern. Reads stay synchronous.
- Polling is the default. A watch can come later.

The loop may replace the statechart. Answers were a large part of why `lifecycle.ts` needs its states, and once they move to the client, `next` over the row, a read and the operation in flight may be enough. Stage 2 should test that.

## What the code says before any decision

Four findings change the shape of the work.

1. **A second host adds no capacity today, and moving placement doesn't fix that.** `offering` (`packages/sdk/src/client.ts:427`) takes the first host in list order that offers the base, and never reads `getCapacity`. A `Capacity` refusal from that host goes back to the caller, and nothing tries the next host. Capacity-aware placement is a new duty, not a moved one.
2. **Hosts can't fully disappear while copies stay local.** `forkMachine` lands on the source's host (`packages/sdk/src/api.ts:142`) and `restoreMachine` on the checkpoint's host (`api.ts:150`). A stopped machine on a full host fails `Capacity` at `start` (`packages/host/src/machines.ts:461`) even when another host has room. Names and routing can lose the host. Capacity can't, unless machines move.
3. **Dropping the prefix makes names global, and nothing enforces that today.** `Name` is unique per host (`packages/sdk/src/ids.ts:25`), through `name TEXT PRIMARY KEY` in each host's own SQLite (`packages/host/src/platform/sqlite.ts:38`). `linux_dev` and `mac_dev` can both exist now. A bare `dev` needs one owner for uniqueness across hosts. That is the whole reason a control plane might hold state.
4. **The prefix does more than route.** It is also the SSH config match (`apps/clankerbox/src/ssh-config.ts:12`, `Host <host>_*`), the tailnet node name (`machines.ts:476`), and the digest scope of prebuilds (`packages/sdk/src/prebuild.ts:89`). Each needs its own answer.

Facts that make the design easier:

- Host state already holds bare names. `Intent.name` and `CheckpointRecord.name` carry no host, and `idOn` adds the prefix at the edge (`packages/host/src/ids.ts:24`).
- Work on a host outlives its request. The actor lives in the host's scope (`machines.ts:579`), and `routes.test.ts:500` proves a create finishes after its client disconnects. Resize and the checkpoint operations fork into that scope too (`machines.ts:1057`, `packages/host/src/checkpoints.ts:67`).
- A host needs nobody else to keep going. Rechecks, startup cleanup and VM scopes are all local (`machines.ts:1071`, `packages/host/src/startup.ts:26`, `README.md:244`).

## 1 and 2. Every duty, where it lives, and its proposed home

The first table covers controller duties that exist today. The second covers duties that exist nowhere yet. A `D` number marks a home that depends on a decision in section 5. These tables become the stage 2 before-and-after table.

### Duties that exist today

| Duty | Today | Proposed home | Deleted or changed |
| --- | --- | --- | --- |
| Pick a host for a create | `client.ts:427` `offering`, `client.ts:462` `create`, `client.ts:481` `place` | Control plane | `Client.place`, `Client.CreateOptions.host`, `offering` |
| Name a host by hand | `--host` (`apps/clankerbox/src/machines/spec.ts:41`), `Profile.host` (`packages/sdk/src/profile.ts:24`), `SpecRequest.host` (`profile.ts:102`) | Deleted, or an operator-only placement hint (D9) | The flag, the profile field and the `host` half of `SpecRequest` |
| Refuse a base the host lacks | `machines.ts:864` | Control plane, from the bases each host reports | The check moves with `machines.ts` |
| Admit a VM against RAM and VM limits | `machines.ts:277` `admitted`, `packages/host/src/usage.ts:67` | Control plane, one admission at a time per host, from the host's limits and a read of its machines | Admission moves with `machines.ts` |
| Fan out reads | `client.ts:372` `gather`, used at `client.ts:493-496` | Control plane | `Gathered`, `Unreachable`, `gather`, `warnUnreachable`, the `failed` check in `apps/clankerbox/src/command.ts:237` |
| Route by ID prefix | `client.ts:405` `onResource`, `client.ts:335` `routeTo`, `parseId` (`ids.ts:62`), `subjectOf` (`client.ts:289`) | Control plane (D5) | `Routed`, `routeTo`, `subjectOf`, `IdParts`, `parseId`, `formatId` |
| Check an ID belongs to this host | `packages/host/src/ids.ts:11` `nameOn`, `CreateRequest` (`packages/sdk/src/resources.ts:229`) | Deleted with the prefix | `nameOn`, `idOn`, `formatId` calls in `machines.ts:887,905`, `checkpoints.ts:224` |
| Check a host calls itself what the list says | `client.ts:273` `checkHost` | Control plane, at membership (D3) | `checkHost` in the client |
| Keep the host list | `ClientConfig.hosts` (`apps/clankerbox/src/config.ts:10`), `HostEntry` (`client.ts:33`), provider `Options.hosts` (`packages/rivet-sandbox-agent/src/options.ts:18`) | Control plane (D3) | All three. The client config and the provider take one URL. |
| Refuse another release | `refusal` and `versionCheck` (`packages/host/src/composition/routes.ts:64,84`), header sent at `client.ts:156` | Each server checks the hop in front of it | Nothing deleted. One shared helper. |
| Tie prebuilds to a runtime | `nameOf` digests `host.runtimeVersion` (`prebuild.ts:25`) | Control plane | `nameOf` and `formatId` calls in `prebuild.ts` |
| Find or restore a prebuild | `Prebuild.create` (`prebuild.ts:75`) | Control plane | `Prebuild.create` and `Prebuild.build` shrink to one call each, or stay as thin wrappers |
| Build a prebuild | `checkpoints.ts:180`, a host builds and captures | Control plane drives it. A host runs the `make`, `capture` and `remove` operations. | `build` moves with `checkpoints.ts` |
| Amp find, resume, restore, create | `amp-orb.ts:124` `locate`, `amp-orb.ts:226` `spawn`, `amp-orb.ts:205` `restored` | Deleted | All of `apps/clankerbox/src/amp-orb.ts` and its tests |
| Amp delete on every host | `amp-orb.ts:312` `remove` | Deleted | With `amp-orb.ts` |
| Amp snapshot sequence | `amp-orb.ts:297-308` | Deleted | With `amp-orb.ts` |
| Run a command in a machine | `execMachine` (`packages/sdk/src/api.ts:154`), `machines.ts:1140`, `apps/clankerbox/src/machines/commands.ts:261` | Deleted | The action, the service method, the command and the `Executed` answer. `Runtime.exec` stays for guest scripts. |
| Provider cleanup after a failed create | `discard` (`packages/rivet-sandbox-agent/src/sandboxes.ts:76`) | Stays in the provider | Nothing. `error.made` becomes the bare name. |
| Read a target and dial SSH | `sshTarget` (`packages/sdk/src/ssh.ts:18`), `ssh.ts:76,130,168` | Client, over the control plane's `getMachine` (D6) | Nothing unless SSH is relayed |
| Keep the SSH config | `apps/clankerbox/src/ssh-config.ts:10-22`, one block per host | Client, with one block (D5) | The per-host blocks |
| Name a host on an error | `located` in `client.ts:367`, `errors.ts:3` | Control plane logs, not client errors | The client stops setting `host` |
| Read setup scripts and keys | `specRequest` (`profile.ts:111`), `packages/sdk/src/setup.ts` | Client. The request carries them. | Nothing |
| Allocate SSH ports | `pickPort` in `machines.ts:823` | Host, inside the `make` operation, which reports the port | Port uniqueness per host stops being a store rule |
| Mint tailnet keys | `machines.ts:471` `join`, `tailnet.oauthClient` in host config (`README.md:68`) | Host, as a `join` operation (D7) | Nothing, unless D7 moves the secret |
| Move a machine toward what was asked | `lifecycle.ts`, `reconcile.ts`, `machines.ts:1071` | Control plane | The host's actors, store and recheck loop |

### Duties with no home today

| Duty | Why it appears | Proposed home |
| --- | --- | --- |
| Global name uniqueness | Finding 3. A create must be refused when any host holds the name. | Control plane, one primary key |
| Capacity-aware placement | Finding 1. It needs a policy and a read of `getCapacity`. | Control plane. The host's refusal stays the truth, and the control plane moves on only after a definite `Capacity` or `NotOffered`. |
| Host membership and draining | Adding or removing a host has no operation today, it is a client config edit. | Control plane (D3) |
| Answering for an unreachable host | `Unavailable` is client-made today (`errors.ts:277`). A server has to make it now. | Control plane. Every action declares it. |
| Running a step on a host | The actor and the VM are now on different machines. | Host, as an operation |
| Refusing a late or repeated operation | A delivery can arrive after the control plane moved on. | Host, by operation ID and sequence number |

## 3. AGENTS.md invariants under this design

Kept means the rule holds with its meaning unchanged, even when it moves to the control plane. Changed means the rule stays in a new form. Broken means the rule goes, knowingly.

| Invariant | Mark | Reason |
| --- | --- | --- |
| The row is intent, numbered by the store in the write that records it | Kept | One row, on the control plane. |
| What the VM is doing is always read, never stored | Kept | The control plane reads through the host, and reads `unknown` when it can't. |
| Every machine is read at start, and every resting one at each recheck | Kept | The control plane does it, one batched read per host. |
| One actor per machine | Kept | There is one place actors can run, and a move keeps the same actor. |
| A later request cuts a step short | Kept | By cancelling the operation. |
| A step cut short holds its lease until the VM is where the command takes it | Kept | The lease is released when the host reports the operation done, instead of when a local fiber ends. |
| A request answers from where the machine rests | Changed | The server answers once the store has the desire. The client's wait answers from where the machine rests, using `generation`. `AnswerTrue` must be rechecked against what a read reports. |
| Leases are in memory only, so a host's end drops them with the work | Changed | They stay in memory, on the control plane, and its end drops them without ending the work. On restart it must read each host's operations and treat those machines as held before acting. |
| A host that starts deletes every machine left unmade | Changed | A restarted control plane reattaches first. It deletes an unmade machine only when its operation is unknown or failed. Long setups then survive a restart. |
| A machine is made by one step, from what only that request holds | Kept | The script is in memory on both sides and is never stored. A control plane restart can't resend it, so a `make` the host never received ends with the row marked failed. |
| A lost reply means the caller reads the resource | Kept | Clients read by name. Between the control plane and a host, it collects the result by ID. |
| Nothing retries | Changed | Clients still never retry. The control plane resends and collects by operation ID, which is safe because the ID and sequence number stop a second run. |
| A checkpoint exists only from a capture that succeeded until its delete begins | Kept | Records move to the control plane. |
| A paused machine resumes only under its pin, and a copy needs the host's pin | Kept | A host reports its pin. The row stores what a VM booted under. |
| A resize runs beside the actor and the row keeps the sizes read after it | Kept | As an operation that owns the lease. |
| A host works alone | Broken | During an outage nothing restarts a dead VM. Running VMs are not affected. |
| Clients talk to hosts directly, no controller | Broken | It is the point of the work. |
| Errors carry context, the client sets `host` | Broken | The client knows no host. It keeps `action`. |
| `Unavailable` is made only by the client library | Broken | A server now answers for a host it can't reach. |
| Operations are contracts, `actionCommands` fails on an uncovered action | Kept | It covers the client contract. The host contract needs its own coverage check. |
| Dependency boundary, Layers only at an entry, lint fence, `no-manual-run` | Changed | Each app is a boundary. Most host domain files move to `apps/server`, and `apps/host` keeps the runtimes, guest scripts and the operation runner. |
| The tailnet is the only gate, and everyone upgrades together | Kept by default | See D4 and D7. |

## 4. What happens in each failure

This is inferred from the code and the design. None of it has been run.

### Control plane down with machines running

VMs keep running. Running operations finish and hold their results. Nothing restarts a VM that dies, and no new operation starts. Every API call fails, including new SSH by ID, because `clankerbox ssh`, `ssh-proxy` and `ssh-known-hosts` each read the machine first (`apps/clankerbox/src/ssh.ts:76,130,168`). Open SSH sessions stay up, and machines on the tailnet stay reachable by node name.

### Control plane restarting mid-request

The client gets `Unavailable` with `readOnly: false` and reads the resource. On start, the control plane loads its rows, asks each host for its operations, and attaches each actor to the operation it finds.

A create mid-setup keeps running on the host. The actor reattaches, collects the result, and the machine reaches `settled` with `get dev` answering it. If the setup failed, the actor deletes the machine. This is the end state the stage 2 fault run should check.

### Host unreachable from the control plane

The machine reads `unknown` and rests in `waiting`, and its lease stays held if an operation was running. Placement skips the host, and new creates go elsewhere. Reads of its machines answer `Unavailable`, and a list names them as `unread`, as `Usage` does (`packages/sdk/src/resources.ts:172`).

A request on such a machine is recorded and answered as usual. The client's wait times out and says the request is saved. The last desire applies when the host returns, so a `stop` from yesterday can run today unless a later request replaces it.

A host that is gone for good needs an operator action that forgets it. Its machines are lost, because their disks are on it.

### Partition mid-create

The control plane can't tell whether the `make` arrived. The row stays unmade and the name stays taken. When the link returns, the control plane asks for the operation by ID. If it ran, the actor collects the result. If the host doesn't know it and the control plane still holds the script, it sends the same ID again. If the script is gone, the actor deletes the machine.

A `make` delivered late can't act after that delete, because the delete carries a higher sequence number. A create never goes to another host after an ambiguous failure.

### A reply lost at either hop

Between client and control plane, the actor carries on and the client reads the resource. Between control plane and host, the control plane collects by ID, so the client sees nothing unless the host stays unreachable past its wait. A client that repeats `start`, `stop` or `pause` asks for a state again, `delete` answers `absent`, and `create` answers `Conflict`.

A duplicated operation runs once, by ID. A late stale operation is refused by sequence number. This replaces the risk that a duplicate `stop` lands after a `start`.

### Hosts on a different release from the control plane

By default the two stay in lockstep. A host refuses another major.minor, and the control plane reports it as unreachable rather than passing `Invalid` to a client. Machines are not affected. Most logic now lives on the control plane, so the host contract should change less often. That could allow skew later, which is a guess until the contract exists.

### Control plane store lost

This is the new worst case, as hosts no longer hold rows. Back up the SQLite file. A host never deletes a VM because the control plane doesn't list it, and acts only on an explicit operation. Orchard and E2B have the opposite rule and would destroy machines here. Native names hold the name and instance (`packages/host/src/platform/smolvm.ts:111`), so a partial rebuild from what each runtime lists looks possible. That is unproven.

### Two control planes at once

Both would run actors. The sequence number stops the older one's late operations only if the numbers come from one store. One instance stays the rule, with no standby.

## 5. Decisions

Options come with consequences and no verdict. Interlocks are listed at the end, since several decisions can't be made alone.

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
| Control plane calls hosts | Hosts keep their HTTP routes and `ActionHttp.client` is reused. Needs a route to each host, which the tailnet gives. Hours-long creates hold an open request, as now. Timeouts stack: clients wait 10 s (`api.ts:35`) and a host bounds its reads at 9 s (`runtime.ts:64`), leaving 1 s for a hop and a fan-out, so one of those numbers must move. |
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
- **`authorizedKeys`.** Stay in client config and travel in the request (`setup.ts:159`), or move to the control plane. Moving gives one key set for everyone and drops per-client keys. They are part of the prebuild digest (`prebuild.ts:41`), so either way a change rebuilds.
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

## Before stage 2

- The baseline at `adcacee` is green. `vp check` passes, and `vp test` passes 683 tests in 47 files.
- `java` is now on `PATH`, at version 25. TLC passes the current model, with 5,767,482 distinct states in about 4.5 minutes.
- `MachineAnswers.tla` covers one made machine, with creation and copies out of scope (`verify-machine-answers/SKILL.md`, Bounds). A control plane crash mid-create needs creation in the model or in a sibling model. That is more than adding three fault actions.
