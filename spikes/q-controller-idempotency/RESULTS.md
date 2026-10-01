# Question spike: drop the controller? drop idempotency keys?

Read-only analysis, 2026-10-01. Nothing was built and no runtime resources were
created. Sources:

- the plan, `docs/plans/typescript-rewrite.md` (cited by section name)
- Clankerdesk at `147b3bd`, cited as `CD:path:line`
- personal-cloud at `e54dab32`, cited as `PC:path:line`
- the current wire contract under `protocol/clankerbox/v1/`
- clankerauth-sdk README, and spike S5

## A. Do we need the controller?

### What the planned controller does, and who depends on it

The plan's controller has three jobs: authenticate, route by host prefix, and fan
out (Architecture; Simplification inventory → Controller; Phase 4). Broken down:

| # | Job | Real consumer | Without a controller |
| --- | --- | --- | --- |
| 1 | One URL and one clankerauth resource for every client | CLI (`PC:hosts/clankerbox-controller/operator-client.json` has one `url`); Clankerdesk (`ClankerboxTarget = {url, tokenPath, machines?}`, `CD:packages/api/src/clankerbox.ts:12-16`; production value at `PC:deployments/clankerdesk/deploy/docker-compose.apps.yml`, `CLANKERDESK_CLANKERBOX`) | The client config holds `hosts: [{id, url}]`. One clankerauth key carries grants on every host resource. |
| 2 | Route by the `<host>.` prefix (machines, checkpoints, builds) | CLI and Clankerdesk: every get/stop/delete/capture/restore | The SDK client looks up the prefix in its `hosts` map. Same code, in `packages/contract` rather than a service. |
| 3 | Resolve profile → host on create | Clankerdesk: "Machine creates omit host placement so the controller resolves it from that profile" (`CD:tools/real-clankerbox/README.md:71`); production config sets only `{"profile":"linux-dev"}` | `MachineDefaults.host` already exists as an optional field (`CD:packages/api/src/clankerbox.ts:6-9`). Make it required. The CLI reads `host_id` from `profile.json` on publish, and fans out a profile lookup for `create --profile`. |
| 4 | Resolve a machine name with no prefix | CLI (`ssh NAME`, `stop NAME`, …) | The CLI fans out `getMachine({name})` across the configured hosts. Two answers means the name is ambiguous; the error names both hosts. This is the same fan-out the controller would run, executed in the CLI. |
| 5 | List fan-out with partial results (names unreachable hosts) | CLI `machines`, `checkpoint list`, `hosts`, `profile list`; Clankerdesk `machines.list()` → extension `list` (`CD:apps/server/src/machines.ts:400`, `CD:extensions/clankerbox/src/host.ts:70`, `CD:apps/server/src/supervisor.ts:136`) | An SDK `listAll` helper: `Effect.forEach(hosts, …, {concurrency: "unbounded"})` with per-host `Result`. |
| 6 | The host trusts callers only through a key | Hosts | Unchanged. The plan already gates hosts by the key and not the network (Controller: "keep clankerauth on every call, so the host can trust the controller only through the key, not the network"). |
| 7 | `dev` runs the controller in-process (Target layout) | `clankerbox dev`, Clankerdesk's real-clankerbox harness | Dev has one host. The client config is `hosts: [{id: "dev", url}]`. The in-process Layer goes. |

The remaining consumers don't depend on it at all:

- **clankercreds** never calls the API. It reads only `/var/lib/clankerbox/machine-id`.
- **clankerbox-profiles** only pins `host_id` in `profile.json` (`gg-linux-dev/profile.json`: `"host_id": "linux"`).

The reframe: the controller's code doesn't disappear. Routing, fan-out and name
resolution become a small module in the `packages/contract` client (a
`HostsClient` over the per-host `ActionHttpClient`). The CLI and Clankerdesk
already both consume that package. Phase 4 becomes a client module rather than a
deployed service.

### Placement and the source of truth

- **Placement already happens without the controller:** the profile pins
  `host_id`. Since D7, the plan has no controller-side capacity or placement.
  `CreateMachine.host_id` is deleted because "the profile pins the host"
  (Contract and wire).
- **The client's `hosts` list is the natural single source of truth** for "which
  hosts exist". Today that list lives only in the controller's `config.json`
  (`PC:hosts/clankerbox-controller/config.json`). Without a controller it moves to:
  - the CLI's `client.json`
  - Clankerdesk's `CLANKERDESK_CLANKERBOX`

  That makes two copies, both written by personal-cloud deploys. Adding a host
  means editing both. With two hosts and one operator, that is cheap.
- **How a client learns which host has a profile:**
  - Clankerdesk: the config says so (`machines: {profile, host}`).
  - CLI: `profile publish` reads `host_id` from the recipe. `create --profile X`
    fans out `getProfile(X)`. Every other call carries the host in the ID prefix.
  - Profile names collide only if the operator publishes the same `id` to two
    hosts. Treat that as ambiguity, exactly like names (row 4).

### Auth

clankerauth models a resource as an origin URL: `Resource.make` derives the
identifier from the public URL (clankerauth `packages/sdk/README.md:57`). "One key
can reach several resources" (`README.md:228`). S5 criterion 1 showed one key with
grants on two resources accepted by both. So:

- Each host is its own resource, which the plan already requires (Phase 3: "The
  clankerauth resource").
- Each client gets one key with grants on every host resource.
- What goes: the controller's own resource, and the controller → host key.
- Caveat from the SDK: a key granted on several resources can be replayed by any
  of them to the others. The hosts are peers with the same trust, so this is
  acceptable, but it should be stated.
- Adding a host means granting existing keys on the new resource. The plan already
  needs that step for the controller's key.

### Network

**Today:**
- Hosts admit only the controller:
  - WireGuard link controller → Hetzner `10.203.112.1:8444`
  - the UniFi rule `clankerbox-controller-to-workstation-rpc` for the Mac
    (`PC:platforms/unifi/firewall-policy.yml:210-220`)
  - the controller's own nftables (`PC:hosts/clankerbox-controller/nftables.conf`)
- Clients reach the controller through edge Caddy at
  `https://clankerbox.home.garaba.net`, restricted to the admin VPN and the apps
  VM (`PC:hosts/clankerbox-controller/README.md`, Topology).

**The plan already requires direct client → host reachability.** D2 publishes each
guest port on the host's tailnet address, and Clankerdesk sshes into
`Machine.endpoints` directly ("Handed to Clankerdesk"). Every client that uses
`clankerbox ssh` or a Clankerdesk terminal must reach the host's tailnet address
anyway. Without a controller, the host API port joins the guest ports on that
same path.

**What is genuinely new:** the host API is reachable by any tailnet node that
holds a key, not just the controller's address. On Linux that API is served by a
root process (D11). Two caveats:

- A Tailscale ACL can restrict the API port to the client tags.
- The plan's controller design already relies on the key and not the network, so
  the difference is ACL hygiene, not a change to the security model.

**A tension the plan already has**, which dropping the controller neither creates nor softens:

- personal-cloud's architecture says "Tailscale is not the normal service path"
  (`PC:ARCHITECTURE.md:21`).
- Clankerdesk runs in Docker on the apps VM (`192.168.20.30`, bridge
  `10.255.255.224/28`).
- Getting it onto the tailnet (host Tailscale plus routing from the bridge, or a
  sidecar) is phase 8 work either way.

### Lost and deleted

**Lost:**
- **One URL and one place to log requests.** Each host logs its own calls.
- **Partial-result fan-out as a server feature.** It is kept as an SDK helper,
  with the same behaviour.
- **A place to add multi-host placement later (D12).** Two points:
  - D12 offers two options. "Every pool host reachable at placement" is
    stateless fan-out, which a client-side router does just as well. "A key →
    host record" needs a database the controller doesn't have. Dropping the
    controller therefore removes nothing D12 could use.
  - With B's keyless design, a retried create finds its earlier attempt by name
    lookup with fan-out, a primitive the client already has (row 4). Pool
    placement then becomes "fan out by name, then pick a host". If it ever needs
    shared state, a controller can be reintroduced at that point.
- **Version skew.** The host API becomes the public API. It already is the API
  the controller proxies, and the plan ships one binary and an SDK versioned with
  it, so nothing extra.

**Deleted:**
- `packages/controller`, Phase 4, and the `server` role of the binary.
- Controller fan-out tests.
- The dev in-process controller Layer.
- In personal-cloud:
  - VM112 (`192.168.20.32`): its provision playbook, nftables and service unit
  - the edge Caddy route `clankerbox.home.garaba.net`
  - the WireGuard link and the UniFi rule (phase 8 deletes these anyway)
  - the controller's backup and maintenance steps
- One HTTP hop, with its own 5 s timeout and its own failure mode: "controller
  unavailable" vs "host unavailable" collapses to one transport failure.
- The controller → host key.
- D12's controller-specific text.

### Recommendation A

**Drop the controller.** Move routing, name resolution and list fan-out into the
SDK client in `packages/contract`, configured with `hosts: [{id, url}]`.

Clankerdesk changes:
- `ClankerboxTarget` becomes `{hosts: [{id, url}], tokenPath, machines: {profile, host}}`, with `host` required.
- Every other Clankerdesk call already carries the host in its ID prefix.

The trade-off:
- **Given up:** one URL, and a single choke point for logging and network policy.
- **In exchange:** a deployed service, a VM, a hop, a phase and a key all go.

The network path it needs is the one D2 already requires. Revisit only if
pool placement across several hosts per platform (D12) becomes real *and* needs
shared state. Name lookup by fan-out (with B) covers the retry half of D12
without state.

## B. Drop idempotency keys?

### What Clankerdesk uses keys and operations for

The current contract returns an `Operation` from every mutation
(`protocol/clankerbox/v1/machine.proto:11-20`). Checkpoints have no name
(`resources.proto:113-124`), and `GetMachine` takes only an ID (`machine.proto:32`).

1. **Replay after an unconfirmed submit, in-process.**
   - `submitWithRetry` retries up to 2 times on `ClankerboxUnreachable`, with the same key and body (`CD:apps/server/src/machine-recovery.ts:65-91`).
   - The request timeout is 5 s (`CD:apps/server/src/clankerbox.ts:78`).
2. **Recovery after a Clankerdesk crash or restart.**
   - The key is persisted in the allocation row before dispatch: `Attempt{action, key, operation, submission}` (`CD:apps/server/src/machines.ts:48-53`, `:286-300`).
   - The row is marked `unconfirmed` before the first network byte (`:206-207`).
   - The next `create` or `close` re-runs `submit`, which resends the same key and body (`:198-225`).
   - The contract is stated at `:82-86`: "unanswered submissions always reuse their original key and body".
3. **Telling "never accepted" from "maybe accepted".**
   - `submissionAfterFailure` and `admissionRefusals` classify the first exchange's error (`CD:apps/server/src/machine-recovery.ts:10, 32-58`). The list includes `name_conflict` (`:36`).
   - A `rejected` or `unsubmitted` create lets `close` mark the allocation closed with no delete (`CD:apps/server/src/machines.ts:337-343`).
   - An `unconfirmed` one is resubmitted with its key during close, then settled, then stopped and deleted (`:359-379`).
   - The same applies to checkpoints (`CD:apps/server/src/checkpoints.ts:212-216`).
4. **Learning the resource ID.**
   - `machineId` comes from `operation.machineId` (`CD:apps/server/src/machines.ts:231-237`).
   - `checkpointId` comes from `operation.checkpointId` (`CD:apps/server/src/checkpoints.ts:197`, `:310-313`).
   - That is why restore needs a settled capture.
5. **Progress and outcome.**
   - Clankerdesk polls `getOperation`: `settleOperation` and `closureProgress` (`CD:apps/server/src/machine-recovery.ts:96-135`).
   - Through an operations cache (`CD:apps/server/src/machines.ts:138-156`).
   - In the allocation view (`:171-197`) and the checkpoint refresh (`CD:apps/server/src/checkpoints.ts:127-162`).
   - Shown in the UI: `CD:extensions/clankerbox/src/client.tsx:62,85` and `CD:extensions/clankerbox/src/checkpoint-client.tsx:184-194`.
   - Exposed to extensions: `CD:packages/extension-sdk/src/machines.ts:56`, `CD:apps/server/src/supervisor.ts:142`, `CD:extensions/clankerbox/src/host.ts:72`.
6. **Fresh keys for every explicit stop and delete** (`CD:apps/server/src/machines.ts:365-376`).
   - Here the key adds nothing over the target state. The code already skips the stop when the machine is stopped, and re-reads the machine afterwards (`:366`, `:377-379`).

In summary, keys serve three purposes:
- replay across lost replies and crashes;
- disambiguating Clankerdesk's earlier attempt from nothing (uses 1 and 2);
- an operation ID to poll (use 5).

Use 3 exists only because certainty is inferred from error codes instead of read
from state.

### Keyless design

**The client chooses the name. The name is the idempotency key, scoped to the host.**

- **Create** (`name, profile`):
  - No machine has that name: create it.
  - A machine has that name and the same profile *name*: return it, whatever its status. Compare the name, not the revision, so a republish between the first attempt and the retry doesn't turn the retry into `Conflict`.
  - Anything else: `Conflict{kind: "name"}`.
  - Clankerdesk already picks a unique deterministic name, `machine-${allocationId}` (`CD:apps/server/src/machines.ts:268`), so this costs Clankerdesk nothing.
  - The name has no dot, so it is not ID-shaped (Contract and wire).
- **Restore** (`name, checkpointId`): same rule, comparing the checkpoint ID.
- **Fork** (`name, sourceMachineId`): same rule, comparing the source.
- **Capture** (`name, machineId`): new. The checkpoint gets a client-chosen name, unique per host.
  - Clankerdesk sends `cp-${entryId}`; its own `name` stays local display text (`CD:apps/server/src/checkpoints.ts:21-31`).
  - Same rule, comparing the source machine.
  - This is a **contract addition**: `Checkpoint.name`, and get-by-name.
- **Every create-like call returns the resource with its host-qualified ID at once.**
  - The host writes the row before replying.
  - This replaces uses 4 and 5: Clankerdesk stores `machineId` and `checkpointId` from the first reply.
  - Restore no longer waits for capture to settle just to learn an ID.
- **Stop, start and delete are idempotent on the target state:**
  - stop of a stopped machine succeeds;
  - start of a running one succeeds;
  - delete of an absent one is `NotFound`, which callers treat as done (the plan already maps `GetMachine` → `NotFound` to deleted, Phase 7).
  - Checkpoint delete works the same way.
- **Get by name:** `getMachine({name})` and `getCheckpoint({name})` on a host, alongside get-by-ID.
- **Host-qualified IDs stay.** The plan's reason for them was "so the stateless
  controller routes by prefix"; the client's router now reads the prefix instead.
- **Host invariant (load-bearing):** a create-like call writes its row and
  replies success, or replies with a tagged error and has written nothing under
  that name. An error reply therefore proves "nothing exists from this call", for
  any error tag. That is why Clankerdesk's error-classification list can go.

**Does this cover every Clankerdesk flow?**

| Flow | Today | Keyless |
| --- | --- | --- |
| create / restore, reply lost | resend same key | resend same name and body; returns the existing machine |
| Clankerdesk crash after dispatch | resend same key on next call | `getMachine({name})`, or resend create |
| close, create unconfirmed | resend create with key, settle, stop, delete | resend create by name (idempotent), wait while `pending`, stop, delete. Today's pattern, minus the key. |
| close, create never sent (`unsubmitted`) | closed, no call | unchanged |
| close, create refused | closed if the error is in `admissionRefusals` | closed on any error reply (host invariant); no list |
| capture, reply lost or crash | resend key; ID only after settle | resend capture by `cp-${entryId}`; ID in the first reply |
| checkpoint delete | key | delete by ID; `NotFound` = done |
| stop / delete in close | fresh key each | plain call, then read the machine |

**Mistaking a collision for a replay:**
- This happens only when an unrelated resource has the same name *and* the same
  source. Clankerdesk's UUID names make that impossible in practice.
- For the operator's CLI, `create --profile linux-dev foo` when an older `foo`
  from `linux-dev` exists returns the old machine instead of failing.
- On a single-operator system that is harmless if the reply says so. The CLI
  prints "foo already exists (status …)" when the returned machine wasn't created
  by this call. The host can mark that with `created: boolean` on the create
  reply.
- A failed earlier attempt is also returned (status `failed`). The caller deletes
  it before reusing the name. That matches Clankerdesk's rule that a failed
  attempt needs a new explicit intent (`CD:apps/server/src/machines.ts:84-85`).

**The late-arrival race:**
- Scenario: a create times out at 5 s but lands on the host later.
- With keys, close resubmits and then deletes, so nothing is orphaned.
- Keyless, the same resubmit-by-name-then-delete pattern gives the same
  guarantee. Recommended for Clankerdesk.
- The cheaper alternative is "lookup by name; `NotFound` → closed". That can
  leave a visible `machine-<uuid>` orphan, which the operator can identify and
  delete.

**Profile publish builds** are used only by the operator CLI, not Clankerdesk.
- A host rule of at most one active build per profile: publish while one runs
  returns `Conflict{kind: "busy"}` carrying the running build ID, which
  `--wait` can follow.
- A lost reply followed by a re-run then waits on the existing build, or at worst
  starts one redundant build. Harmless.

### Operations without keys

**The journal stays; the operations table goes.** The plan's reason for the
journal is independent of keys: "keep writing `started` before each native
effect. Without it a RAM child gets cold-booted twice, or `create` adopts a
foreign VM" (Host → Journal and operations). Keyless moves the journal onto the
resource rows:

- **Machine row:**
  - `pending: {action, phase: accepted|started} | null`
  - `lastFailure: {action, message, uncertain} | null`
  - Runtime state (running/stopped/missing) is still read live, never stored, as
    the plan requires (Architecture). Only the in-flight action and the last
    failure are stored.
  - At startup a `started` row becomes `lastFailure{uncertain: true}` (D5,
    unchanged in substance).
- **Checkpoint row:** `status: capturing | ready | failed{message, uncertain}`. A failed checkpoint keeps its row until it is deleted.
- **Build row:** already a resource with its own status. Unchanged.
- **Busy checks** become "is `pending` set on this machine, or is its checkpoint or
  build active". The plan's `revision_id` foreign key stays on machine rows.
- **"Keep recording completion even when the caller has cancelled"** stays; the
  completion is written to the resource row.

**What Clankerdesk polls:** `getMachine(id)` until `pending` is null, then reads
`lastFailure`. For checkpoints, `getCheckpoint(id)` until it leaves `capturing`.

`closureProgress` becomes:

| Machine | Result |
| --- | --- |
| `pending` set | wait |
| no `pending`, `lastFailure` for this action | refuse; close deletes |
| otherwise | advance |

The separate operations cache (`CD:apps/server/src/machines.ts:138-156`) folds
into the machine cache `recent`.

**With the controller, or without it:** an unavailable host in the middle of a
create is a transport failure. The client keeps the same name and body and
retries later, at the same host: the profile pins it, the restore's checkpoint ID
names it, and so does the fork source's ID. The host's unique-name index turns
the retry into either the first create or a return of the existing row. No state
is needed outside the host, with or without a controller. This is also the
answer to D12's retry half: a pool placement finds an earlier attempt by name
lookup with fan-out, rather than by a key → host record.

### Deleted from the plan

- **Feature scope (Kept):**
  - Lifecycle: "operation inspection, idempotency keys on every mutation".
  - CLI: `operation` and `--idempotency-key`. `--async` stays (it returns the resource in its pending state) and `--wait`/`--timeout` poll the resource.
- **Architecture:** "the caller retries with the same idempotency key". The host's list "machines, operations, idempotency keys, …" drops operations and keys.
- **Target layout and Phase 2:** the `operation` ActionGroup. Operations drop out of the host-qualified ID list.
- **Contract and wire:**
  - The `Unavailable` note becomes "replayed with the same name".
  - The `Conflict` case for key/action mismatch goes; `Conflict{name}` remains.
- **Host → Journal and operations:**
  - "collapse idempotency to key + action … operations are kept" goes.
  - "busy checks onto real operation columns" is rewritten as resource-row status.
  - The journal bullet is reworded: `accepted → started → succeeded | failed` lives on the resource row.
- **CLI, dev and tooling:**
  - `--idempotency-key` leaves the shared flags.
  - `tests/live` uses deterministic names instead of "deterministic idempotency keys".
- **Feature scope → Deleted:** add the Operation response fields; the whole Operation message goes.
- **D5:** rewritten around `Machine.pending` / `lastFailure` and `Checkpoint.status`, with `uncertain` kept.
- **D12:** shrinks to the name-lookup note above.
- **Phase 7 (Clankerdesk migration):** the "operation status (D5)" bullet and the `admissionRefusals` bullet are replaced by the Clankerdesk changes below.

**Additions to the plan:**
- `Checkpoint.name`, unique per host.
- Create, fork, restore and capture return the resource.
- Get by name for machines and checkpoints.
- `created: boolean` on create-like replies.
- One active build per profile.

### What Clankerdesk changes

- **Delete:**
  - `Attempt.key`, and `Attempt.operation` (replaced by the machine or checkpoint read).
  - The `admissionRefusals` list (`CD:apps/server/src/machine-recovery.ts:32-43`). `submissionAfterFailure` (`:49-58`) shrinks to "a transport failure means `unconfirmed`, any error reply means `rejected`", by the host invariant. `name_conflict` at `:36` flips meaning: a same-source "conflict" is now success.
  - The local `submission` states (`unsubmitted | unconfirmed | rejected`, `:10`) **stay**. They decide whether close needs a network call (`CD:apps/server/src/machines.ts:337-343`) and whether it must resubmit then delete.
  - `settleOperation` reads the machine instead.
  - The operations cache.
  - `client.operation` and `getOperation` (`CD:apps/server/src/clankerbox.ts:294-299`).
- **Checkpoints:**
  - Send `cp-${entryId}` as the clankerbox name.
  - Store `checkpointId` from the capture reply.
  - `remove` (`CD:apps/server/src/checkpoints.ts:209-241`) branches on `Checkpoint.status` instead of `capture.operation.status`.
- **Extension surface (Clankerdesk-owned, cut-over work):**
  - `AllocationView.operation` and `CheckpointView.capture/removal.operation` (`CD:packages/api/src/clankerbox.ts:62, 97-111`) become resource status fields.
  - Drop `Machines.operation()` (`CD:packages/extension-sdk/src/machines.ts:56`), `MachineOperationRead` (`CD:apps/server/src/supervisor.ts:142`) and the extension `operation` action (`CD:extensions/clankerbox/src/host.ts:72`).
  - The UI labels at `CD:extensions/clankerbox/src/client.tsx:62,85` and `CD:extensions/clankerbox/src/checkpoint-client.tsx:184-194` read `machine.pending` and `checkpoint.status`.
- **Unchanged:** the durability barrier. Clankerdesk persists its allocation record (with the request body) before dispatch. A crash still recovers by resending the same name and body.

### Recommendation B

**Drop idempotency keys and the operations resource.**
- Client-chosen names, unique per host, with a same-source check, make create,
  fork, restore and capture idempotent.
- Stop, start and delete are idempotent on target state.
- Progress and outcome live on the resource: `pending`/`lastFailure` on machines,
  `status` on checkpoints and builds.

**The journal stays, as columns on those rows.**

**Clankerdesk loses:** keys, operations, the operations cache and the
error-classification list, which is its most delicate code. It keeps its local
`unsubmitted | unconfirmed | rejected` record. That works because the host
guarantees an error reply wrote nothing.

**Costs:**
- Contract additions: `Checkpoint.name`, get-by-name, resource-returning mutations, `created`.
- For the operator: a re-run `create` with an existing same-profile name returns the existing machine (flagged) instead of failing.
- History: a machine row keeps only its last failure, not every past attempt.

**Combined with A:** a retried create needs nothing but the name and the host
the profile pins.
