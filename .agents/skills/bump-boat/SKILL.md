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
  for the run. A host ID starts with a letter, so no real host's sandbox
  carries that label. It deletes only the sandboxes and snapshots it made and
  the sandboxes of that label, never by a prefix, so every real host of the
  account keeps its machines; its last finding counts what is left, which
  must be 0.

## Facts the adapter pins

Each line names where the code holds it and how to check it again.

- Routes and bodies: `POST /sandboxes` and `POST /sandboxes/{id}/fork` with
  `Idempotency-Key`, `noEnv: true`, `monitoring: false`, `ttlSeconds: null`;
  `GET /sandboxes/{id}` answers `{sandbox}`; `GET /sandboxes?label=k=v`
  pages by `pageInfo.nextCursor`; `POST .../resume {type?, ttlSeconds}`,
  `POST .../stop`, `DELETE /sandboxes/{id}` with `X-Ascii-Confirm-Delete:
  <id>`; `POST .../sshkey {key}` answers `hostKey`, `machineIp` and
  `sshEndpoint`; `POST /saved-snapshots {sandboxId, name}`,
  `GET /saved-snapshots`, each with its `sourceSandboxId`, by which a
  machine's start and delete find the snapshots it holds,
  `GET|DELETE /saved-snapshots/{name}`; `GET /limits` with `machineTypes`
  and `starts.{minute,hour,day}`. (`api.ts`; check each path and schema in
  the YAML.)
- A create repeated under its `Idempotency-Key` answers the same sandbox and
  counts no start, sent one after the other. Two sent at once were seen to
  count two. (`api.ts` retries only one at a time; the live suite's first
  finding.)
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
  `IP_RATE_LIMIT_EXCEEDED`, `idempotency_in_progress`, `sandbox_starting`,
  `sandbox_stopping` and `ssh_host_key_unavailable` are waited out by
  `Retry-After`. (`boat.ts`'s `capacityCodes`, `api.ts`'s `waitedOut`; grep
  the YAML for each code.)
- The states: `ready`, `idle` and `running` run; `archived`, `archiving` and
  `error` are stopped; a set `dataExpiredAt` or a 404 is missing; the rest
  are starting. (`boat.ts`'s `stateOf`; the YAML's `Sandbox.state`.)
- The apt Tailscale package enables its own `tailscaled` unit on boat's
  systemd guest, which the linux base script disables. (The live suite's
  tailnet findings.)
