---
name: bump-boat-api
description: Re-audit clankerbox's boat runtime against boat's current API v1 spec, docs and image, or move it to a new API version.
disable-model-invocation: true
---

# Bump boat's API

clankerbox's boat host calls boat.dev's HTTP API v1 directly, with Schemas for
exactly the endpoints it uses; there is no boat SDK, CLI or version to pin.
boat changes its spec, docs and guest image in place, so a bump is a re-audit:
run it when boat publishes a new API version, its spec's hash changes, its
image changes, or a live run fails on boat's side. Re-check the claims below
against the spec, the docs and the trial account, not just the tests. Fix what
broke, report optional opportunities separately, and don't deploy, change
production hosts or commit unless asked. A candidate without the live run below
is an **unqualified candidate**.

The design is for boat's trial, by the owner's decision: checks that need a paid
plan (`ttlSeconds: null`, a `large` create that succeeds, whether `POST /sshkey`'s
`hostKey` is the current activation's) are dropped, not deferred. Don't add them
back.

## Source and scope

- **Pinned in this repo:** `baseUrl` (`https://boat.dev/api/v1`) in
  `packages/host/src/boat-api.ts`, with the spec's sha256 in its header comment;
  `apiVersion` in `packages/host/src/boat.ts`, which the host reports as its
  runtime's version; `API` in `tests/live/boat/driver.py`. The Schemas, refusal
  tables and constants in `boat-api.ts` and `boat.ts` (named below) follow the
  spec, and so do the fakes in `packages/host/tests/boat-api.test.ts` and
  `boat.test.ts`. `packages/sdk/tests/ids.test.ts` holds the named-snapshot
  name rule.
- **Sources:** the spec at `https://docs.boat.dev/openapi/boat-v1.yaml`, and
  the docs at `docs.boat.dev`. The audited spec has sha256
  `79aa87e21849194635cf057293d6934638bab1aeee1c1d4857aa1920e34cf210`, fetched
  2026-10-05; the audit, on 2026-10-04, recorded only its prefix and suffix,
  `79aa87e2…f210`, which match. Keep the copy you audit under
  `.work/inputs/boat-v1-<date>.yaml` with its full sha256 and fetch date, so the
  next bump can diff against it. Also note boat's changelog and the image's
  OS release.
- **Notation:** "D" is the spec or docs; "O" was observed on a trial account
  (`type: small`, `noEnv: true`). An observed claim is re-checked live, a
  documented one in the spec.
- The API key is a credential: it travels only as the bearer token. Nothing you
  write, log or keep as evidence may hold it, or a setup script, a packed
  recipe or the preparation seed.

## Claims to re-check

Each: what boat does, and what of ours depends on it.

**Endpoints and shapes** (D)

- Used: `POST /sandboxes` (with `type`, `noEnv`, `ttlSeconds`, and `from` a named
  snapshot for a restore), `GET /sandboxes/{id}`, `POST /sandboxes/{id}/fork`,
  `/resume`, `/stop`, `/sshkey`, `/commands`, `PATCH /sandboxes/{id}` (`name`),
  `DELETE /sandboxes/{id}`, `POST /named-snapshots` (`sandboxId`, `name`),
  `GET` and `DELETE /named-snapshots/{name}`; the live driver also reads
  `GET /limits`, `GET /sandboxes` and `GET /named-snapshots`. Ours: one method
  each in `boat-api.ts`'s `make`.
- The fields read: a sandbox's `id`, `state`, `error`, `ip`, `sshEndpoint`,
  `lastSnapshotAttemptAt` and `lastSnapshotStatus` (`Sandbox`, all but `id` and
  `state` optional, since a `cancelled` sandbox is reported once with only
  `id`, `state` and `error`); a command's `exitCode`, `stdout`, `stderr` and
  `timedOut` (`Finished`); a named snapshot's `name`, `status` and `error`
  (`NamedSnapshot`); a refusal's `code`, `message` and `requestId` (`Refused`).
  A sandbox's `desktopUrl` holds a token, so errors never carry a body.
- Create's body has no name, tag or metadata field (it lists `type`,
  `ttlSeconds`, `env`, `environment`, `noEnv`, `snapshots`, `failFast`,
  `setupScript`, `org`); `PATCH {name}` sets a display name of 1–120
  characters afterwards; `GET /sandboxes` filters by state only, at most 200 a
  page. A sandbox echoes nothing the client chose. Ours: a row without its
  sandbox ID can only be found by hand as an unrenamed `Box <time>`; `observe`
  reads each recorded ID, never a list; the rename after a create is only a
  label, and a refused rename is a warning.
- Resume takes no `Idempotency-Key`. Ours: an unclear resume fails the `start`
  and is never repeated.

**Activation and limits** (D, O)

- The trial allows 2 active sandboxes and 5/25/75 starts per minute/hour/day;
  create, fork and resume each count as a start, and so did two 429 refusals,
  while 403 type refusals and idempotent repeats didn't. `GET /limits` reports
  the limits, `activeSandboxes` and the starts left; its `activeStates` are
  `provisioned`, `cloning`, `ready`, `idle` and `running`. A subscription in its
  7-day trial keeps the trial's limits until its first payment. Ours:
  `activeStates` and `stateOf` in `boat.ts` (active reads `running`, `cancelled`
  and 404 read `missing`, anything else `stopped`); the live driver's pre-flight
  and start count.
- The trial refuses `ttlSeconds: null` and anything over 7200 with 400
  `trial_auto_stop_required`; create and resume default to a 1 h TTL, and a fork
  always does unless the call passes `ttlSeconds`. Ours: `ttlSeconds` 7200 and
  `noEnv: true` on every create, fork, resume and restore (`activation`).
- `noEnv: true` keeps GitHub credentials, `gh` config and model logins out of the
  guest (`holdsCreatorLogins: false`); the guest still has an `ASCII_TOKEN`,
  which D says is confined to that sandbox.
- Types: `small` 2 vCPU/4 GB/12 GB, `default` 4/8/50, `large` 8/16/125, `xlarge`
  16/32/251 from the $100 plan; the spec lists only the first three. On the
  trial, `large` is 403 `trial_machine_class_not_allowed`; `xlarge` is 403
  `machine_class_plan_required` below the $100 plan. Ours: `machineTypes` and
  `machineType` (the smallest that covers the request; none is
  `Precondition`), `planRefusals`.

**Refusals and retries** (D, O)

- 429 `limit_reached` (also with `failFast`), `rate_limited` and
  `daily_limit_reached`; 503 `out_of_capacity` and `no_ready_machine` (with
  `failFast`, within about 1.5 s); 409 `named_snapshot_limit` for an 11th named
  snapshot. None creates anything. A create or fork that finds no machine ends
  `cancelled`, reported once, then 404. The spec (D, not seen live) adds 429
  `member_limit_reached`, an organization owner's cap below the plan's active
  limit, and says `rate_limited` names the rolling start window it hit,
  minute, hour or day; no `Retry-After` is documented. Ours:
  `capacityRefusals` (all but `rate_limited`) as `Capacity` under the refusal
  rule, only for the calls that take room (`takesRoom`: create, fork, resume,
  restore and a named snapshot's save). Any other 429 to a keyed call
  (`Throttled`) is repeated `throttledRepeats` (2) times `throttledPause` (65 s)
  apart, past the minute window, so an hour's or a day's limit costs at most
  three starts; then `rate_limited` is `Capacity` and an unknown code
  `Internal`. Resume and a save, which take no key, map `rate_limited` to
  `Capacity` at once. A 429 to any other call is a passing limit, repeated for
  a `GET` or `DELETE` and failing `Internal` otherwise; no call sends
  `failFast`. Check live, when a run hits it: the `rate_limited` message's
  window, and whether a refused start still counts. `running` refuses a
  cancelled create, fork or restore as `Capacity`; a 404 after boat accepted
  one is `Internal`, keeping the row `failed` with its sandbox ID, as a poll
  that missed the one `cancelled` read can't tell it from a sandbox boat lost.
- `Idempotency-Key` on create (also with `from`) and fork: the same key and body
  return the same sandbox, also once ready; another body is 409
  `idempotency_key_reused`; a retry during creation is 409
  `idempotency_in_progress`. Keys last 24 h, and a create that failed before
  its sandbox existed releases its key within about 2 minutes. Ours:
  `idempotencyKey` (`clankerbox-<host>-<instance>`), the unclear-outcome retry
  of every call safe to repeat, every `GET`, `DELETE` and keyed call
  (`retryWindow` 5 minutes, `firstPause` to `longestPause`, `attemptTimeout`),
  cut short by a caller's own wait, and a state read by `machineReadWait` (8 s,
  under the core's `stateReadWait`); `inProgress` repeated as unclear, and a
  429 too, at least `throttledPause` on, until the `throttledRepeats`th 429,
  so at most three starts; any refusal answering a repeat after
  an unclear one, a 429 or 503 `Capacity` or a 403 plan `Precondition`, failing
  `Internal`. A refusal after only 429s is trusted, as they made nothing.

**Access and exec** (D, O)

- `POST /sandboxes/{id}/sshkey` authorizes a public key for `user`; it survives
  fork, resume and named-snapshot restores in `~/.ssh/authorized_keys`. Its
  reply also carries a `hostKey`, unused. Ours: one host key, authorized once
  after create.
- `ip` is IPv6 or IPv4; `sshEndpoint` is a public IPv4 `host:port` relay to port
  22, set only when the machine has no IPv4 of its own. Both change on every
  start. Ours: `endpointOf`, read with the state and never stored.
- SSH streams stdin and returns the exit code; a 650 s session through the relay
  ran to the end; ssh joins argv into one string. `user` has passwordless
  `sudo -n`; sshd allows root with a key. Ours: `remoteCommand` quotes every
  argument, exec runs as `user` through `sudo -n`, one connection per exec.
- `POST /sandboxes/{id}/commands` runs a bash string as `user` in `/home/user`,
  returns `exitCode`, `signal`, `stdout`, `stderr` and `timedOut`, takes
  `timeoutSeconds` 1–600 (a timeout kills it, exit 143), and has no stdin. Ours:
  it only reads the guest's host keys before each SSH connection
  (`hostKeysCommand`), pinned per connection; `commandMargin` on top of its
  timeout.
- Every create, fork, resume and restore is a new machine, with new SSH host
  keys, hostname, machine-id and endpoint; snapshots exclude host keys and
  hostname. Ours: a pin is never reused; preparation's re-mint is harmless.

**Snapshots, forks and the lazy restore** (D, O)

- Background snapshots run about once a minute (attempts started 60.0 s apart
  and took 3.8–24.4 s), plus a final one on stop; a stop whose snapshot fails is
  refused and the sandbox keeps running. `force` drops everything written since
  the last snapshot. Ours: stop never passes `force`, waits for `archived`
  (`stopWait`; it took 2.3–28.5 s).
- Carried: `/home/user`, `/etc`, `/usr`, `/opt`, `/srv`, `/root`, `/var/lib` and
  `/var/opt` (D lists a narrower `/var/lib`). Dropped: `/tmp`, `/var/tmp`,
  `/var/cache`, `/var/log`, processes and `ufw` rules. Enabled systemd units
  start again after a restore. Ours: README's boat setup rules.
- A fork of a running sandbox comes from its latest background snapshot. boat
  stamps `lastSnapshotAttemptAt` when an attempt starts, already
  `lastSnapshotStatus: in_progress`, and leaves it when the attempt completes,
  when `lastSnapshotStatus` becomes `completed` and `snapshotCompletedAt` moves.
  Ours: a fork syncs, notes `lastSnapshotAttemptAt`, then waits until it
  changes and reads `completed` (`snapshotWait`, `snapshotPause`), comparing only
  boat's own values. A change in these fields' meaning breaks forks silently:
  re-check it live.
- Named snapshots: an account keeps at most 10, names are account-wide and match
  `^[a-z0-9][a-z0-9-]{0,62}$`; re-saving a name at the cap works; a snapshot is
  independent of its source and survives its deletion; a save is `saving` until
  it settles (about two minutes from a running sandbox, 0.2–121 s from a stopped
  one). Ours: `snapshotName` (`cbx-<host>-<inst>`, so a host ID of at most 32
  characters fits), `captureWait`, `capturePause`.
- At `ready` the binds (`/home/user`, `/etc`, `/usr`, `/opt`, `/root`, `/srv`)
  are mounted and fetched on first read; `/var/lib` and `/var/opt` are restored
  in full before `/var/lib/ascii-lazy/sys-done` appears, a few seconds after
  ready, 9–14 s with 1 GiB. That marker is undocumented; the documented signal
  is the `sandbox.hydrated` webhook, which can't reach a tailnet host; a
  sandbox has no field for it (the spec of 2026-10-05). Ours: `restoredWait`
  (`restoredMarker`, `markerWait`) before preparation after a fork, restore or
  any start, a running machine's included, except on the machine a create
  made: create's SSH wait touches `createdMark` (`/run/clankerbox-created`),
  and the wait skips the marker while it exists. That rests on D: a resume
  "restores onto a fresh machine", and a fork or restore provisions a new
  sandbox, so `/run`, a tmpfs outside the carried paths, never holds the mark
  after a lazy restore. Check live (the suite's start of `main` after its
  create, its `[marker]` line and its resume): whether a fresh create's
  sandbox has `/var/lib/ascii-lazy` or its `sys-done` at all; that the mark is
  there after create and gone after a resume, a fork and a restore, whose
  marker still appears; and that a start of a running machine never stopped
  since its create returns in seconds. Gap: a guest reboot clears the mark, and
  a start of the create's machine then waits `markerWait` and fails. Ask
  whether boat now documents a signal a host can poll. Preparation's
  `/var/lib/clankerbox/instance` can't stand in for the mark: a start keeps the
  row's instance, so a resume restores a file that already holds it, and
  `/var/lib` is readable while its restore runs (the marker is written there);
  nothing says a file in it shows only once all of it is restored. A mark under
  `/var/tmp` or `/var/cache`, which a reboot keeps and no snapshot carries (O),
  would close the gap, but rests on that observed drop list where `/run` rests
  on a tmpfs; so would the marker's absence on a create's machine, if a live
  run finds `/var/lib/ascii-lazy` never there.

**Delete** (D, O)

- `DELETE` needs `X-Ascii-Confirm-Delete: <id>`, returns 202 with an operation,
  and the sandbox answers 404 within a second; the operation then purges data
  for hours; a repeated DELETE returns the same operation. Named snapshots
  survive their sandbox's deletion. Ours: an unclear DELETE is repeated, and a
  404 to it is done; delete polls for 404 (`deleteWait`) and never waits for
  the purge.

**The guest image** (O; boat's, not pinned)

- Ubuntu 24.04 (24.04.4 when observed), x86_64, with systemd, sshd, Docker, Node,
  Python and coding agents; `ufw` active; `/etc/resolv.conf` is the
  systemd-resolved stub; `/etc/environment` reaches SSH sessions. boat's agent
  listens on TCP 8911 and its HTTPS routes use a WireGuard tunnel; a guest rule
  blocking either marks the sandbox degraded. Ours: README's setup rules and
  bases note; setup over SSH as root worked in about 6 s.

## Verify

- Unit: `vp test` in `packages/host` (`boat-api.test.ts`, `boat.test.ts`, whose
  fake answers as boat's API does) and `packages/sdk` (`ids.test.ts`),
  then `vp run --no-cache ready`. Change a fake only to match boat's real answers.
- Live: `pnpm live:boat [--address TAILNET_ADDRESS]` on a trial account with
  room for it (`tests/live/README.md`: two free active sandboxes, 7 starts left
  this hour and day, room for 2 named snapshots). It covers create, stop and
  resume, forks of running and stopped sources, checkpoints restored after
  their source is deleted, the 429 and `large` refusals, a host restart and a
  crash. It runs as a work run (`scripts/WORK_RUNS.md`) and deletes what it
  made by recorded ID; report what is left on the account, what runs locally,
  and what evidence it keeps.

## After

- Update the spec hash and its date in `boat-api.ts`'s header, the Schemas,
  tables and constants that changed, the fakes, and README's boat notes. For a
  new API version, also `baseUrl`, `apiVersion` and the driver's `API`.
- Update this skill's claims with what changed, and record the spec copy's full
  hash.
- Report what changed at boat and its fixes, the checks actually run (the
  account's start count before and after), optional opportunities, and
  remaining sandboxes, local resources and retained evidence separately.
