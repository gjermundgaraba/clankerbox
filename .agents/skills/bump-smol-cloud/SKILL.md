---
name: bump-smol-cloud
description: Re-check, against the real smol cloud account, every fact of smol cloud's API that clankerbox's smol-cloud host relies on, when the provider changes its API or its plans, or before a release that touches the adapter.
disable-model-invocation: true
---

# Bump smol cloud

smol cloud is a hosted API with no version to pin, so a bump re-checks the facts
below against the live account, not a release. The adapter is
`apps/host/src/platform/smol-cloud/`, and `apps/host/tests/fake-smol-cloud.ts`
answers as the provider did when these facts were last checked: a fact that
moved changes both, and the fake's tests in
`apps/host/tests/platform/smol-cloud.test.ts`. Fix what broke, report optional
opportunities separately, and don't commit unless asked.

## The re-check

`apps/host/tests/live/smol-cloud.test.ts` asserts each fact below. Run it from
`apps/host`, in the one shell that loads the keys, and never with `set -x`:

```sh
source <path to the .envrc holding SMOL_MACHINES_API_KEY and TAILSCALE_AUTHKEY>
CLANKERBOX_LIVE_LEDGER=/tmp/ledger CLANKERBOX_LIVE_ANSWERS=/tmp/answers vp run test:live
```

It spends money: it makes at most 3 machines at once, those from an image with
a provider expiry, and 3 checkpoints, and deletes them. Every machine it makes
is named `cbx-0live-*`: its own as `cbx-0live-<run>-*`, and its host's under
the host ID `0live-<run>`, which it mints for the run. A host ID starts with a
letter, so no real host's ID equals that one or starts it, and no real host's
machine carries the mark. It clears only `cbx-0live-*` when it starts, so every
real host of the account keeps its machines. `answers` records what the
provider said for each item still open. Afterwards, list what the account holds
under `cbx-0live-` and each ID in `ledger`: every machine and checkpoint
must be gone. Check `answers` and `ledger` for the key before you keep them.

## Facts the adapter pins

Each is an assertion of the live suite, in the case named.

- A machine name is at most 63 characters (`64` answers 400), so a host ID is
  at most 26 (`cbx-` + ID + `-` + 32 hex). A second create of a name answers 409.
- `autoStopSeconds: 0` with a published port answers 422 on a plan whose
  `GET /v1/account` says `plan.allowAlwaysOn` false; the adapter sends 86400
  then.
- `GET /v1/account` gives `effectiveMaxConcurrentMachines` and
  `effectiveMaxCpus`, and `GET /v1/capacity` what runs.
- A create answers 201 `stopped`; a start answers `started`.
- `POST /exec/stream` refuses an empty argument with 400, answers a missing
  user with an error, takes string `stdin`, and sends each output line as a
  `data` line of an `stdout` event, ending with an `exit` event of
  `{exitCode}`.
- The tunnel, `wss://.../v1/machines/{id}/tunnel/22`, takes the key in
  `Authorization`, carries raw TCP to sshd, and doesn't wake a stopped machine.
- Memory, vCPUs and disk grow on a running machine and on a stopped one;
  memory doesn't shrink (400).
- A capture with `wait=true` can answer `creating`, so the adapter polls it to
  `available`.
- A pause leaves a checkpoint of its own, which outlives the resume. While
  paused, exec, start, stop and that checkpoint's delete answer 409. Once the
  resume has the machine running again, that checkpoint's delete answers 204:
  a start's prune by `keep` depends on it.
- A restore answers `stopped`, carries its source's ports and resources, no
  labels and no expiry, and takes the `network` and `autoStopSeconds` it is sent.
- A checkpoint a living restore was made from refuses its delete with 409.
- A deleted machine's checkpoints stay, listed with its `machineId` and
  `machineDeleted: true`, until each is deleted.
- Through a host: a base machine joins the tailnet over exec, its sshd answers
  through the host's relay port, a restore of it comes up with no node and
  joins as a node of its own, and one logged out with its old state put back
  joins again on one new key.
