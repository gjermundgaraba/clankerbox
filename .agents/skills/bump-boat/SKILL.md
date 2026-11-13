---
name: bump-boat
description: Re-check every boat API fact clankerbox's boat host relies on, against boat's published schema and a live run on the operator's account, and fix the adapter where boat moved.
disable-model-invocation: true
---

# Bump boat

clankerbox's boat host drives boat's REST API v1 (`https://boat.dev/api/v1`)
through a hand-written client, `apps/host/src/platform/boat/api.ts`. boat
publishes no release the host pins, so a bump re-checks the facts below
whenever boat's schema or docs change, or a live run fails. Fix what broke,
report what is new and optional separately, and don't commit unless asked.

## Sources

- The schema, `https://docs.boat.dev/openapi/boat-v1.yaml`, and the docs,
  `https://docs.boat.dev/llms-full.txt`. Download each into its own empty
  folder and read it there.
- The live suite, `apps/host/tests/live/boat.test.ts`, which costs starts on
  the operator's account. Run it once, in `apps/host`, with the key loaded
  only for that command:
  `source <checkout>/.envrc && CLANKERBOX_LIVE=1 vp test tests/live/boat.test.ts`.
  It labels everything it makes `cbx-host=0live-<random>`, a host ID it mints
  for the run, and a host ID starts with a letter, so no real host's sandbox
  carries that label. It writes the name of every snapshot it makes, before
  the save is sent, and the ID of every sandbox, which finds that sandbox's
  snapshots once it is gone, to its run's ledger,
  `boat-0live-<random>.ledger` in `~/.local/state/clankerbox-live`
  (`$XDG_STATE_HOME`, or `CLANKERBOX_LIVE_LEDGERS`, moves it), a folder of
  mode 0700 and a file of mode 0600 that the suite refuses once open to
  others; the ledger starts with the host and PID of the run. Each test
  starts and ends with a sweep (`tests/live/sweep.ts`'s `selected`), which
  prints what it selects before it deletes anything, and deletes only:
  sandboxes labelled with this run's host ID, and snapshots in this run's
  ledger or saved from one of its sandboxes, and the same of a run provably
  over, one whose ledger names this host and a PID no process holds, or one
  `CLANKERBOX_LIVE_OVER=0live-…,…` names. It reads which runs are over
  once, before it lists (`sweepRead`), and retires the ledgers of those
  runs alone once nothing of them is left (`retiredOver`), so a run that
  ends while it lists keeps its ledger for the next sweep. A ledger ID
  never selects a sandbox. What other live runs hold it only lists.
  `CLANKERBOX_LIVE_LIST_ONLY=1` lists and deletes nothing; run the last test alone with it to see what a
  sweep would take. boat offers no expiry for a sandbox or a snapshot, so a
  run's first sweep begins its ledger, before it makes anything, and a run
  killed at any line leaves what a later run's sweep takes once that run is
  provably over (`sweep.ts`'s `ledgers`, and its killed-run test). The
  last test sweeps, asserts that nothing of its run is left, lists what
  other live runs hold, and removes its ledger; its finding is the
  zero-leftover listing.

## Facts the adapter pins

Each line names where the code holds it and how to check it again.

- Routes and bodies: `POST /sandboxes` and `POST /sandboxes/{id}/fork` with
  `Idempotency-Key`, `noEnv: true`, `monitoring: false`, `ttlSeconds: null`;
  `GET /sandboxes/{id}` answers `{sandbox}`; `GET /sandboxes?label=k=v`
  pages by `limit`, `cursor` and `pageInfo.nextCursor`, null or empty on the
  last page, and a cursor answered twice fails the list as unanswered; `POST .../resume {type?, ttlSeconds}`,
  `POST .../stop`, `DELETE /sandboxes/{id}` with `X-Ascii-Confirm-Delete:
  <id>`; `POST .../sshkey {key}` answers `hostKey`, `machineIp` and
  `sshEndpoint`; `POST /saved-snapshots {sandboxId, name}`,
  `GET /saved-snapshots?namePrefix=cbx-`, each with its `sourceSandboxId`,
  by which a machine's start and delete find the snapshots it holds; that
  list takes only `name`, `namePrefix` and `org`, refuses `limit` and
  `cursor` with 400 `invalid_query`, and answers every snapshot at once,
  with no `pageInfo`;
  `GET|DELETE /saved-snapshots/{name}`; `GET /limits` with `machineTypes`
  and `starts.{minute,hour,day}`. (`api.ts`; check each path and schema in
  the YAML.)
- A create repeated under its `Idempotency-Key` answers the same sandbox and
  counts no start once that sandbox is ready. One sent while the first is
  still being made, even 150 ms later, answers 409 `idempotency_in_progress`
  with no `Retry-After`, and counts a start. The same key with another body
  answers 409 `idempotency_key_reused`. A key is at most 255 characters.
  (`boat.ts`'s `landed` looks for a create whose answer was lost by its
  labels before it sends it again, and waits for the listing on
  `idempotency_in_progress` instead of sending a third; the key is
  `cbx-<host id>-<instance>`; the live suite's first finding, and the fake's
  `make`.)
- A save of a sandbox that is deleted at once still ends, `ready` from a
  stopped sandbox and `failed` from a running one, and stays listed with the
  deleted sandbox's `sourceSandboxId`. (`boat.ts`'s `delete` prunes again
  once the sandbox is gone; the fake's `landSaveDuringDelete`.)
- A resume within minutes of a stop answers 200 with the same machine, host
  key and address, and counts no start; past that, or with a `type`, it
  answers 202 and counts one. (`api.ts`'s `resume`; live suite.)
- A delete sent twice answers 202 both times; only a read answers 404.
  (`boat.ts`'s `delete` polls the read; live suite.)
- `/sshkey` answers the host key sshd serves now, after a cold start and
  after the guest's identity script re-keys; a key sent twice is written
  once. (`ssh.ts` re-pins from it when a host key is refused; live suite.)
- Machine types: `small` 2 vCPUs 4 GiB, `default` 4 and 8, `large` 8 and 16,
  `xlarge` 16 and 32, with the disk the guest's block device reads: 80 GiB
  on `small` and `default`, 149 GiB on `large`. `xlarge` is the docs' 251,
  unmeasured until a plan offers it. (`traits.ts`'s `types`; the live
  suite's disk findings.)
- The codes `limit_reached`, `rate_limited`, `out_of_capacity` and
  `no_ready_machine` mean no room, which moves a create to the next host;
  `IP_RATE_LIMIT_EXCEEDED`, `sandbox_starting`, `sandbox_stopping`,
  `save_in_progress` and `ssh_host_key_unavailable` are waited out by
  `Retry-After`. The YAML says `type_too_small` refuses a resume onto a
  type whose disk is smaller than the data, but the operator's account took
  a sandbox holding 85G of written data on `large` onto `small`, so the
  adapter maps no such refusal: one fails the resize `Internal` with boat's
  code. A `/sshkey` 503 was never provoked either: `/sshkey` answered 200
  right after a create's answer. (`boat.ts`'s `capacityCodes`, `api.ts`'s
  `waitedOut`; grep the YAML for each code.)
- A resize sends its typed resume to an archived sandbox only: once boat
  takes it, the sandbox comes back at the new type or the resize fails
  naming both types, as each resume counts a start; a lost one is read back
  and sent again at the next poll, and so is one boat refuses
  `sandbox_running_stop_first` while it reads the sandbox archived, three
  untaken sends in all, never provoked on the account. (`boat.ts`'s
  `retyped`; the fake's `loseRequest` and the resize tests.)
- The states: `ready`, `idle` and `running` run; `archived` is stopped;
  `error`, a machine boat lost or failed to start, is unbilled, read as
  stopped, ends a stop at once and fails a start; `cancelled`, a create or
  fork boat found no machine for, is read once and then answers 404, so a
  make that meets it answers `Capacity` and a start `Missing`, as a 404
  does; a set `dataExpiredAt` reads missing; the rest are on their way.
  Neither `error` nor `cancelled` was met on the operator's account: the
  YAML's `Sandbox.state` and the docs' "A sandbox is in error" say so.
  (`boat.ts`'s `heldOf`, `ends` and `stateOf`; the fake's `fail`, `cancel`
  and `vanish`.)
- Each request is bounded by `answerWithin` in `platform/provider-http.ts`: 30
  seconds for a read, a minute for a change. A request unanswered by then is
  one whose answer was lost.
- The apt Tailscale package enables its own `tailscaled` unit on boat's
  systemd guest, which the linux base script disables. (The live suite's
  tailnet findings.)
